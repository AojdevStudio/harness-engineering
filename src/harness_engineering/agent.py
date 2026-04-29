from __future__ import annotations

import json
import logging
import selectors
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from harness_engineering.config import CodexConfig
from harness_engineering.models import Issue
from harness_engineering.workspace import WorkspaceManager

logger = logging.getLogger(__name__)


class AgentError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class AgentEvent:
    event: str
    timestamp: datetime
    codex_app_server_pid: str | None = None
    usage: dict[str, Any] | None = None
    payload: dict[str, Any] | None = None


class CodexClient(Protocol):
    def run_turn(
        self,
        *,
        workspace_path: Path,
        issue: Issue,
        prompt: str,
        on_event: Callable[[AgentEvent], None],
    ) -> None: ...


class StubCodexClient:
    """Deterministic local client for proving orchestration without Codex app-server."""

    def __init__(self, codex: CodexConfig, workspace_manager: WorkspaceManager) -> None:
        self.codex = codex
        self.workspace_manager = workspace_manager

    def run_turn(
        self,
        *,
        workspace_path: Path,
        issue: Issue,
        prompt: str,
        on_event: Callable[[AgentEvent], None],
    ) -> None:
        self.workspace_manager.assert_agent_cwd(workspace_path, workspace_path)
        thread_id = f"stub-thread-{issue.identifier}"
        turn_id = "stub-turn-1"
        on_event(
            AgentEvent(
                event="session_started",
                timestamp=datetime.now(UTC),
                codex_app_server_pid=None,
                payload={"thread_id": thread_id, "turn_id": turn_id, "issue_identifier": issue.identifier},
            )
        )
        on_event(
            AgentEvent(
                event="notification",
                timestamp=datetime.now(UTC),
                payload={"message": f"stub codex accepted {issue.identifier}"},
            )
        )
        usage = _stub_usage(prompt)
        on_event(
            AgentEvent(
                event="thread_tokenUsage_updated",
                timestamp=datetime.now(UTC),
                usage=usage,
                payload={"usage": usage},
            )
        )
        if self.codex.stub_delay_ms:
            time.sleep(self.codex.stub_delay_ms / 1000)
        if self.codex.stub_exit == "failure":
            on_event(
                AgentEvent(
                    event="turn_failed",
                    timestamp=datetime.now(UTC),
                    payload={"message": f"stub codex failed {issue.identifier}", "turn": {"id": turn_id}},
                )
            )
            raise AgentError("stub_failed", f"stub codex failure for {issue.identifier}")
        on_event(
            AgentEvent(
                event="turn_completed",
                timestamp=datetime.now(UTC),
                payload={"message": f"stub codex completed {issue.identifier}", "turn": {"id": turn_id}},
            )
        )


class CodexAppServerClient:
    """Small stdio JSON-RPC client for the installed Codex app-server v2 surface.

    The exact Codex schema remains the Codex binary's responsibility. This client keeps
    Symphony's side narrow: start thread, start turn, handle completion, and resolve
    approvals/user-input/tool calls according to the documented high-trust posture.
    """

    def __init__(self, codex: CodexConfig, workspace_manager: WorkspaceManager) -> None:
        self.codex = codex
        self.workspace_manager = workspace_manager
        self._next_id = 1

    def run_turn(
        self,
        *,
        workspace_path: Path,
        issue: Issue,
        prompt: str,
        on_event: Callable[[AgentEvent], None],
    ) -> None:
        self.workspace_manager.assert_agent_cwd(workspace_path, workspace_path)
        process = subprocess.Popen(
            ["bash", "-lc", self.codex.command],
            cwd=workspace_path,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        try:
            pid = str(process.pid)
            self._send(process, "initialize", {"clientInfo": {"name": "harness-engineering", "version": "0.1.0"}, "capabilities": {}})
            self._read_response(process, timeout_ms=self.codex.read_timeout_ms)
            self._notify(process, "initialized")

            thread_result = self._send_and_wait(
                process,
                "thread/start",
                {
                    "cwd": str(workspace_path),
                    "approvalPolicy": self.codex.approval_policy,
                    "sandbox": self.codex.thread_sandbox,
                    "serviceName": "harness-engineering",
                    "ephemeral": False,
                    "experimentalRawEvents": False,
                    "persistExtendedHistory": True,
                },
                timeout_ms=self.codex.read_timeout_ms,
            )
            thread = thread_result.get("thread", {})
            thread_id = thread.get("id")
            if not thread_id:
                raise AgentError("response_error", "thread/start response did not include thread.id")

            turn_result = self._send_and_wait(
                process,
                "turn/start",
                {
                    "threadId": thread_id,
                    "cwd": str(workspace_path),
                    "approvalPolicy": self.codex.approval_policy,
                    "sandboxPolicy": self.codex.turn_sandbox_policy,
                    "input": [{"type": "text", "text": prompt, "text_elements": []}],
                },
                timeout_ms=self.codex.read_timeout_ms,
            )
            turn = turn_result.get("turn", {})
            turn_id = turn.get("id")
            if not turn_id:
                raise AgentError("response_error", "turn/start response did not include turn.id")
            on_event(
                AgentEvent(
                    event="session_started",
                    timestamp=datetime.now(UTC),
                    codex_app_server_pid=pid,
                    payload={"thread_id": thread_id, "turn_id": turn_id, "issue_identifier": issue.identifier},
                )
            )
            self._stream_until_turn_end(process, turn_id=turn_id, pid=pid, on_event=on_event)
        finally:
            _terminate(process)

    def _stream_until_turn_end(
        self,
        process: subprocess.Popen[str],
        *,
        turn_id: str,
        pid: str,
        on_event: Callable[[AgentEvent], None],
    ) -> None:
        deadline = time.monotonic() + self.codex.turn_timeout_ms / 1000
        while True:
            if process.poll() is not None:
                raise AgentError("port_exit", "codex app-server process exited before turn completed")
            if time.monotonic() > deadline:
                raise AgentError("turn_timeout", "codex turn timed out")
            message = self._read_message(process, timeout_ms=min(1000, self.codex.read_timeout_ms))
            if message is None:
                continue
            if "method" in message and "id" in message:
                self._handle_server_request(process, message)
                continue
            method = message.get("method")
            raw_params = message.get("params")
            params: dict[str, Any] = raw_params if isinstance(raw_params, dict) else {}
            usage = _extract_usage(method, params)
            event = AgentEvent(
                event=_event_name(method),
                timestamp=datetime.now(UTC),
                codex_app_server_pid=pid,
                usage=usage,
                payload=params,
            )
            on_event(event)
            if method == "turn/completed":
                completed_id = params.get("turn", {}).get("id") or params.get("turnId")
                if completed_id in {None, turn_id}:
                    return
            if method in {"turn/failed", "turn/cancelled"}:
                raise AgentError(_event_name(method), f"codex turn ended with {method}")

    def _handle_server_request(self, process: subprocess.Popen[str], message: dict[str, Any]) -> None:
        request_id = message["id"]
        method = message.get("method")
        if method == "item/commandExecution/requestApproval":
            result: dict[str, Any] = {"decision": "acceptForSession"}
        elif method == "item/fileChange/requestApproval":
            result = {"decision": "acceptForSession"}
        elif method == "item/permissions/requestApproval":
            result = {"permissions": {}, "scope": "session"}
        elif method == "item/tool/requestUserInput":
            self._send_response(process, request_id, error={"code": -32000, "message": "user input is not supported by this harness"})
            return
        elif method == "item/tool/call":
            result = {
                "success": False,
                "contentItems": [{"type": "inputText", "text": f"unsupported tool call: {message.get('params', {}).get('name')}"}],
            }
        else:
            self._send_response(process, request_id, error={"code": -32601, "message": f"unsupported server request {method}"})
            return
        self._send_response(process, request_id, result=result)

    def _send_and_wait(self, process: subprocess.Popen[str], method: str, params: dict[str, Any], *, timeout_ms: int) -> dict[str, Any]:
        request_id = self._send(process, method, _drop_none(params))
        response = self._read_response(process, timeout_ms=timeout_ms, request_id=request_id)
        result = response.get("result")
        if not isinstance(result, dict):
            raise AgentError("response_error", f"{method} returned non-object result")
        return result

    def _send(self, process: subprocess.Popen[str], method: str, params: dict[str, Any]) -> int:
        request_id = self._next_id
        self._next_id += 1
        self._write(process, {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        return request_id

    def _notify(self, process: subprocess.Popen[str], method: str) -> None:
        self._write(process, {"jsonrpc": "2.0", "method": method})

    def _send_response(
        self,
        process: subprocess.Popen[str],
        request_id: int | str,
        *,
        result: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
    ) -> None:
        message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
        if error is not None:
            message["error"] = error
        else:
            message["result"] = result or {}
        self._write(process, message)

    def _write(self, process: subprocess.Popen[str], message: dict[str, Any]) -> None:
        if process.stdin is None:
            raise AgentError("port_exit", "codex stdin is closed")
        process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        process.stdin.flush()

    def _read_response(
        self,
        process: subprocess.Popen[str],
        *,
        timeout_ms: int,
        request_id: int | None = None,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_ms / 1000
        while time.monotonic() < deadline:
            message = self._read_message(process, timeout_ms=max(int((deadline - time.monotonic()) * 1000), 1))
            if message is None:
                continue
            if "id" in message and (request_id is None or message["id"] == request_id):
                if "error" in message:
                    raise AgentError("response_error", str(message["error"]))
                return message
            if "method" in message and "id" in message:
                self._handle_server_request(process, message)
        raise AgentError("response_timeout", "timed out waiting for Codex app-server response")

    def _read_message(self, process: subprocess.Popen[str], *, timeout_ms: int) -> dict[str, Any] | None:
        if process.stdout is None:
            raise AgentError("port_exit", "codex stdout is closed")
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        try:
            events = selector.select(timeout_ms / 1000)
            if not events:
                return None
            line = process.stdout.readline()
        finally:
            selector.close()
        if not line:
            return None
        try:
            return json.loads(line)
        except json.JSONDecodeError as exc:
            raise AgentError("malformed", f"malformed JSON from Codex app-server: {line[:200]}") from exc


def _drop_none(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item is not None}


def create_codex_client(codex: CodexConfig, workspace_manager: WorkspaceManager) -> CodexClient:
    if codex.driver == "stub":
        return StubCodexClient(codex, workspace_manager)
    return CodexAppServerClient(codex, workspace_manager)


def _terminate(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _event_name(method: str | None) -> str:
    if not method:
        return "other_message"
    return method.replace("/", "_")


def _extract_usage(method: str | None, params: dict[str, Any]) -> dict[str, Any] | None:
    if method != "thread/tokenUsage/updated":
        return None
    usage = params.get("usage") or params.get("total_token_usage") or params
    return usage if isinstance(usage, dict) else None


def _stub_usage(prompt: str) -> dict[str, int]:
    input_tokens = max(len(prompt.split()), 1)
    output_tokens = 1
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
    }
