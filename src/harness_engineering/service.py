from __future__ import annotations

import logging
import os
import signal
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from queue import Empty, Queue
from typing import Any

from harness_engineering.agent import AgentEvent
from harness_engineering.config import ConfigError, ServiceConfig
from harness_engineering.github_tracker import GitHubTracker, TrackerError
from harness_engineering.http_server import start_http_server
from harness_engineering.models import Issue
from harness_engineering.orchestrator import (
    OrchestratorState,
    RecentEvent,
    RetryScheduler,
    RunningEntry,
    available_slots,
    should_dispatch,
    sort_for_dispatch,
)
from harness_engineering.runner import AgentRunner
from harness_engineering.workflow import WorkflowDefinition, WorkflowReloader
from harness_engineering.workspace import WorkspaceManager, sanitize_workspace_key

logger = logging.getLogger(__name__)


class SymphonyService:
    def __init__(self, workflow_path: str | Path, *, port_override: int | None = None) -> None:
        self.workflow_path = Path(workflow_path).expanduser().resolve()
        self.reloader = WorkflowReloader(self.workflow_path)
        self.workflow: WorkflowDefinition | None = None
        self.config: ServiceConfig | None = None
        self.state: OrchestratorState | None = None
        self.executor: ThreadPoolExecutor | None = None
        self.futures: dict[str, Future[None]] = {}
        self.worker_events: Queue[tuple[str, AgentEvent]] = Queue()
        self.stop_event = threading.Event()
        self.port_override = port_override
        self._tick_requested = threading.Event()
        self._lock = threading.RLock()

    def start(self) -> None:
        self.workflow = self.reloader.load_initial()
        self.config = ServiceConfig.from_workflow(self.workflow, self.workflow_path)
        self.config.validate_dispatch()
        self.state = OrchestratorState(
            poll_interval_ms=self.config.polling.interval_ms,
            max_concurrent_agents=self.config.agent.max_concurrent_agents,
            max_concurrent_agents_by_state=self.config.agent.max_concurrent_agents_by_state,
            active_states=set(self.config.tracker.active_states),
            terminal_states=set(self.config.tracker.terminal_states),
        )
        self.executor = ThreadPoolExecutor(max_workers=self.config.agent.max_concurrent_agents, thread_name_prefix="symphony-agent")
        self._startup_terminal_cleanup()
        port = self.port_override if self.port_override is not None else self.config.server.port
        if port is not None:
            start_http_server(self.config.server.host, port, state_provider=self.snapshot, refresh=self.request_tick)
            logger.info("http_server started host=%s port=%s", self.config.server.host, port)

    def run_forever(self) -> None:
        if self.state is None:
            self.start()
        signal.signal(signal.SIGTERM, lambda *_: self.stop_event.set())
        signal.signal(signal.SIGINT, lambda *_: self.stop_event.set())
        next_tick = 0.0
        while not self.stop_event.is_set():
            now = time.monotonic()
            if self._tick_requested.is_set() or now >= next_tick:
                self._tick_requested.clear()
                self.tick()
                interval = (self.state.poll_interval_ms if self.state else 30_000) / 1000
                next_tick = time.monotonic() + interval
            self.stop_event.wait(0.2)
        if self.executor:
            self.executor.shutdown(wait=True, cancel_futures=False)

    def request_tick(self) -> None:
        self._tick_requested.set()

    def snapshot(self) -> OrchestratorState:
        if self.state is None:
            raise RuntimeError("service not started")
        return self.state

    def tick(self) -> None:
        if self.workflow is None or self.config is None or self.state is None:
            raise RuntimeError("service not started")

        self._drain_worker_events()
        self._reap_finished_workers()
        self._reload_if_needed()
        self._apply_config_to_state()
        self._reconcile_running()

        try:
            self.config.validate_dispatch()
        except ConfigError as exc:
            logger.error("validation failed code=%s reason=%s", exc.code, exc)
            return

        tracker = GitHubTracker(self.config.tracker)
        try:
            candidates = tracker.fetch_candidate_issues()
        except TrackerError as exc:
            logger.error("tracker_fetch failed code=%s reason=%s", exc.code, exc)
            return

        self._dispatch_due_retries(candidates, now_ms=int(time.monotonic() * 1000))

        for issue in sort_for_dispatch(candidates):
            if available_slots(self.state) <= 0:
                break
            if should_dispatch(issue, self.state):
                self._dispatch(issue, attempt=None)

    def _dispatch(self, issue: Issue, *, attempt: int | None) -> None:
        assert self.config is not None
        assert self.workflow is not None
        assert self.state is not None
        assert self.executor is not None

        workspace_manager = WorkspaceManager(
            self.config.workspace.root,
            hooks=self.config.hooks.as_scripts(),
            hook_timeout_ms=self.config.hooks.timeout_ms,
        )
        workspace_path = self.config.workspace.root / sanitize_workspace_key(issue.identifier)
        entry = RunningEntry(
            issue=issue,
            workspace_path=str(workspace_path),
            retry_attempt=attempt,
            started_at=datetime.now(UTC),
        )
        self.state.running[issue.id] = entry
        self.state.claimed.add(issue.id)
        self.state.retry_attempts.pop(issue.id, None)
        runner = AgentRunner(self.config, self.workflow, workspace_manager)
        future = self.executor.submit(
            runner.run_attempt, issue, attempt=attempt, on_event=lambda event: self._queue_agent_event(issue.id, event)
        )
        self.futures[issue.id] = future
        logger.info("dispatch started issue_id=%s issue_identifier=%s attempt=%s", issue.id, issue.identifier, attempt)

    def _dispatch_due_retries(self, candidates: list[Issue], *, now_ms: int) -> None:
        assert self.config is not None
        assert self.state is not None
        if not self.state.retry_attempts:
            return

        scheduler = RetryScheduler(max_backoff_ms=self.config.agent.max_retry_backoff_ms)
        candidates_by_id = {issue.id: issue for issue in candidates}
        for issue_id, retry in list(self.state.retry_attempts.items()):
            if retry.due_at_ms > now_ms:
                continue

            self.state.retry_attempts.pop(issue_id, None)
            issue = candidates_by_id.get(issue_id)
            if issue is None:
                self.state.claimed.discard(issue_id)
                logger.info("retry released issue_id=%s issue_identifier=%s reason=issue_not_candidate", issue_id, retry.identifier)
                continue

            # Retry entries are claimed by design; clear that stale claim before
            # evaluating eligibility. A successful _dispatch will claim again.
            self.state.claimed.discard(issue_id)

            if available_slots(self.state, state_name=issue.state) <= 0:
                self.state.claimed.add(issue_id)
                self.state.retry_attempts[issue_id] = scheduler.create_entry(
                    issue_id=issue_id,
                    identifier=issue.identifier,
                    attempt=retry.attempt,
                    now_ms=now_ms,
                    error="no available orchestrator slots",
                    continuation=retry.continuation,
                )
                logger.info(
                    "retry requeued issue_id=%s issue_identifier=%s reason=no_available_orchestrator_slots", issue_id, issue.identifier
                )
                continue

            if should_dispatch(issue, self.state):
                self._dispatch(issue, attempt=retry.attempt)
            else:
                self.state.claimed.discard(issue_id)
                logger.info("retry released issue_id=%s issue_identifier=%s reason=not_dispatch_eligible", issue_id, issue.identifier)

    def _queue_agent_event(self, issue_id: str, event: AgentEvent) -> None:
        self.worker_events.put((issue_id, event))
        self.request_tick()

    def _drain_worker_events(self) -> None:
        while True:
            try:
                issue_id, event = self.worker_events.get_nowait()
            except Empty:
                return
            self._apply_agent_event(issue_id, event)

    def _apply_agent_event(self, issue_id: str, event: AgentEvent) -> None:
        assert self.state is not None
        entry = self.state.running.get(issue_id)
        if not isinstance(entry, RunningEntry):
            return
        message = _summarize_payload(event.payload)
        entry.codex_app_server_pid = event.codex_app_server_pid
        entry.last_codex_event = event.event
        entry.last_codex_timestamp = event.timestamp
        entry.last_codex_message = message
        self.state.recent_events.append(
            RecentEvent(
                issue_id=issue_id,
                issue_identifier=entry.issue.identifier,
                event=event.event,
                timestamp=event.timestamp,
                message=message,
            )
        )
        if len(self.state.recent_events) > 50:
            del self.state.recent_events[:-50]
        if event.event == "session_started" and event.payload:
            thread_id = event.payload.get("thread_id")
            turn_id = event.payload.get("turn_id")
            if thread_id and turn_id:
                entry.session_id = f"{thread_id}-{turn_id}"
            entry.turn_count += 1
        if event.usage:
            self._apply_usage_delta(entry, event.usage)
        if event.event == "account_rateLimits_updated" and event.payload:
            self.state.codex_rate_limits = event.payload

    def _apply_usage_delta(self, entry: RunningEntry, usage: dict[str, Any]) -> None:
        assert self.state is not None
        input_tokens = _int_field(usage, "input_tokens", "inputTokens", "input")
        output_tokens = _int_field(usage, "output_tokens", "outputTokens", "output")
        total_tokens = _int_field(usage, "total_tokens", "totalTokens", "total")
        if input_tokens is not None:
            self.state.codex_totals.input_tokens += max(input_tokens - entry.last_reported_input_tokens, 0)
            entry.codex_input_tokens = input_tokens
            entry.last_reported_input_tokens = input_tokens
        if output_tokens is not None:
            self.state.codex_totals.output_tokens += max(output_tokens - entry.last_reported_output_tokens, 0)
            entry.codex_output_tokens = output_tokens
            entry.last_reported_output_tokens = output_tokens
        if total_tokens is not None:
            self.state.codex_totals.total_tokens += max(total_tokens - entry.last_reported_total_tokens, 0)
            entry.codex_total_tokens = total_tokens
            entry.last_reported_total_tokens = total_tokens

    def _reap_finished_workers(self) -> None:
        if self.state is None or self.config is None:
            return
        self._drain_worker_events()
        scheduler = RetryScheduler(max_backoff_ms=self.config.agent.max_retry_backoff_ms)
        now_ms = int(time.monotonic() * 1000)
        for issue_id, future in list(self.futures.items()):
            if not future.done():
                continue
            entry = self.state.running.pop(issue_id, None)
            self.futures.pop(issue_id, None)
            if isinstance(entry, RunningEntry):
                self.state.codex_totals.seconds_running += max((datetime.now(UTC) - entry.started_at).total_seconds(), 0.0)
                try:
                    future.result()
                except Exception as exc:
                    attempt = (entry.retry_attempt or 0) + 1
                    self.state.retry_attempts[issue_id] = scheduler.create_entry(
                        issue_id=issue_id,
                        identifier=entry.issue.identifier,
                        attempt=attempt,
                        now_ms=now_ms,
                        error=str(exc),
                    )
                    logger.error(
                        "worker failed issue_id=%s issue_identifier=%s attempt=%s reason=%s", issue_id, entry.issue.identifier, attempt, exc
                    )
                else:
                    self.state.completed.add(issue_id)
                    self.state.retry_attempts[issue_id] = scheduler.create_entry(
                        issue_id=issue_id,
                        identifier=entry.issue.identifier,
                        attempt=1,
                        now_ms=now_ms,
                        continuation=True,
                    )
                    logger.info("worker completed issue_id=%s issue_identifier=%s", issue_id, entry.issue.identifier)

    def _reload_if_needed(self) -> None:
        assert self.config is not None
        changed = self.reloader.reload_if_changed()
        if changed and self.reloader.current:
            try:
                new_config = ServiceConfig.from_workflow(self.reloader.current, self.workflow_path)
                new_config.validate_dispatch()
            except ConfigError as exc:
                logger.error("workflow_reload failed code=%s reason=%s", exc.code, exc)
                return
            self.workflow = self.reloader.current
            self.config = new_config
            logger.info("workflow_reload completed path=%s", self.workflow_path)
        elif self.reloader.last_error:
            logger.error("workflow_reload failed code=%s reason=%s", self.reloader.last_error.code, self.reloader.last_error)

    def _apply_config_to_state(self) -> None:
        assert self.config is not None
        assert self.state is not None
        self.state.poll_interval_ms = self.config.polling.interval_ms
        self.state.max_concurrent_agents = self.config.agent.max_concurrent_agents
        self.state.max_concurrent_agents_by_state = self.config.agent.max_concurrent_agents_by_state
        self.state.active_states = set(self.config.tracker.active_states)
        self.state.terminal_states = set(self.config.tracker.terminal_states)

    def _reconcile_running(self) -> None:
        assert self.config is not None
        assert self.state is not None
        if self.config.codex.stall_timeout_ms > 0:
            scheduler = RetryScheduler(max_backoff_ms=self.config.agent.max_retry_backoff_ms)
            now = datetime.now(UTC)
            now_ms = int(time.monotonic() * 1000)
            for issue_id, entry in list(self.state.running.items()):
                if not isinstance(entry, RunningEntry):
                    continue
                last = entry.last_codex_timestamp or entry.started_at
                if (now - last).total_seconds() * 1000 > self.config.codex.stall_timeout_ms:
                    self.state.running.pop(issue_id, None)
                    self.state.claimed.add(issue_id)
                    _terminate_entry_process(entry)
                    self.state.retry_attempts[issue_id] = scheduler.create_entry(
                        issue_id=issue_id,
                        identifier=entry.issue.identifier,
                        attempt=(entry.retry_attempt or 0) + 1,
                        now_ms=now_ms,
                        error="stalled",
                    )
                    logger.warning("worker stalled issue_id=%s issue_identifier=%s", issue_id, entry.issue.identifier)

        if not self.state.running:
            return
        tracker = GitHubTracker(self.config.tracker)
        try:
            refreshed = {issue.id: issue for issue in tracker.fetch_issue_states_by_ids(list(self.state.running))}
        except TrackerError as exc:
            logger.warning("reconcile_refresh failed code=%s reason=%s", exc.code, exc)
            return
        workspace_manager = WorkspaceManager(
            self.config.workspace.root,
            hooks=self.config.hooks.as_scripts(),
            hook_timeout_ms=self.config.hooks.timeout_ms,
        )
        for issue_id, entry in list(self.state.running.items()):
            if not isinstance(entry, RunningEntry):
                continue
            issue = refreshed.get(issue_id)
            if issue is None:
                continue
            state_name = issue.state.lower()
            if state_name in self.state.terminal_states:
                self.state.running.pop(issue_id, None)
                self.state.claimed.discard(issue_id)
                self.state.retry_attempts.pop(issue_id, None)
                _terminate_entry_process(entry)
                workspace_manager.remove_for_issue(issue.identifier)
                logger.info("reconcile terminal_cleanup completed issue_id=%s issue_identifier=%s", issue_id, issue.identifier)
            elif state_name in self.state.active_states:
                entry.issue = issue
            else:
                self.state.running.pop(issue_id, None)
                self.state.claimed.discard(issue_id)
                self.state.retry_attempts.pop(issue_id, None)
                _terminate_entry_process(entry)
                logger.info("reconcile released_non_active issue_id=%s issue_identifier=%s", issue_id, issue.identifier)

    def _startup_terminal_cleanup(self) -> None:
        assert self.config is not None
        tracker = GitHubTracker(self.config.tracker)
        workspace_manager = WorkspaceManager(
            self.config.workspace.root,
            hooks=self.config.hooks.as_scripts(),
            hook_timeout_ms=self.config.hooks.timeout_ms,
        )
        try:
            terminal_issues = tracker.fetch_issues_by_states(self.config.tracker.terminal_states)
        except TrackerError as exc:
            logger.warning("startup_terminal_cleanup skipped code=%s reason=%s", exc.code, exc)
            return
        for issue in terminal_issues:
            workspace_manager.remove_for_issue(issue.identifier)
            logger.info("startup_terminal_cleanup removed issue_id=%s issue_identifier=%s", issue.id, issue.identifier)


def _summarize_payload(payload: dict[str, Any] | None) -> str | None:
    if not payload:
        return None
    for key in ("message", "text", "summary"):
        value = payload.get(key)
        if isinstance(value, str):
            return value[:300]
    return None


def _int_field(payload: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, int):
            return value
    return None


def _terminate_entry_process(entry: RunningEntry) -> None:
    if not entry.codex_app_server_pid:
        return
    try:
        os.kill(int(entry.codex_app_server_pid), signal.SIGTERM)
    except (ValueError, ProcessLookupError):
        return
    except PermissionError as exc:
        logger.warning(
            "worker_terminate failed issue_id=%s issue_identifier=%s reason=%s",
            entry.issue.id,
            entry.issue.identifier,
            exc,
        )
