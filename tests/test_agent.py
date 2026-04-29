from __future__ import annotations

from pathlib import Path

import pytest

from harness_engineering.agent import AgentError, CodexAppServerClient, _extract_usage, _thread_start_params, _turn_start_params
from harness_engineering.config import CodexConfig
from harness_engineering.workspace import WorkspaceManager


def test_thread_start_params_avoid_experimental_history_fields(tmp_path: Path) -> None:
    params = _thread_start_params(CodexConfig(), tmp_path)

    assert params["cwd"] == str(tmp_path)
    assert params["serviceName"] == "harness-engineering"
    assert params["ephemeral"] is False
    assert "persistExtendedHistory" not in params
    assert "persistFullHistory" not in params
    assert "experimentalRawEvents" not in params


def test_turn_start_params_preserve_prompt_and_workspace(tmp_path: Path) -> None:
    params = _turn_start_params(CodexConfig(), thread_id="thread-1", workspace_path=tmp_path, prompt="Do the work")

    assert params["threadId"] == "thread-1"
    assert params["cwd"] == str(tmp_path)
    assert params["input"] == [{"type": "text", "text": "Do the work", "text_elements": []}]


def test_extract_usage_prefers_current_token_usage_total_shape() -> None:
    usage = _extract_usage(
        "thread/tokenUsage/updated",
        {
            "tokenUsage": {
                "last": {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3},
                "total": {"inputTokens": 10, "outputTokens": 20, "totalTokens": 30},
            }
        },
    )

    assert usage == {"inputTokens": 10, "outputTokens": 20, "totalTokens": 30}


def test_turn_completed_with_failed_status_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    client = CodexAppServerClient(CodexConfig(), WorkspaceManager(Path("/tmp")))
    messages: list[dict[str, object]] = [{"method": "turn/completed", "params": {"turn": {"id": "turn-1", "status": "failed"}}}]

    def read_message(_process: _MessageProcess, *, timeout_ms: int) -> dict[str, object] | None:
        return messages.pop(0) if messages else None

    monkeypatch.setattr(client, "_read_message", read_message)

    with pytest.raises(AgentError) as exc:
        client._stream_until_turn_end(  # type: ignore[arg-type]
            _MessageProcess(),
            turn_id="turn-1",
            pid="pid-1",
            on_event=lambda _event: None,
        )

    assert exc.value.code == "turn_failed"


class _MessageProcess:
    def poll(self) -> None:
        return None
