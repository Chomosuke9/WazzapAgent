from __future__ import annotations

import time
from collections import deque
from typing import Deque, Dict, Optional

from .config import SUBAGENT_PROGRESS_DETAIL_MAX_CHARS, SUBAGENT_REPORT_MAX_CHARS
from .models import ProgressEntry, SubTask


def _truncate(text: Optional[str], limit: int) -> Optional[str]:
    if text is None or limit <= 0 or len(text) <= limit:
        return text
    # Reserve room for the marker so the final string never exceeds ``limit``.
    marker = " …[truncated]"
    keep = max(0, limit - len(marker))
    return text[:keep] + marker


class SubTaskTracker:
    def __init__(self) -> None:
        self._active: Dict[str, SubTask] = {}
        self._history: Dict[str, Deque[SubTask]] = {}

    def register(self, task: SubTask) -> None:
        self._active[task.session_id] = task
        self._history.setdefault(task.chat_id, deque(maxlen=50))

    def update_progress(
        self,
        session_id: str,
        step: str,
        detail: str,
        reason: Optional[str] = None,
    ) -> None:
        task = self._active.get(session_id)
        if task is None:
            return
        # Hard cap both the detail and reason — we cannot trust the upstream
        # cap to hold if SUBAGENT_PROGRESS_DETAIL_MAX_CHARS gets tightened on
        # this side.
        detail = _truncate(detail, SUBAGENT_PROGRESS_DETAIL_MAX_CHARS) or ""
        reason = _truncate(reason, SUBAGENT_PROGRESS_DETAIL_MAX_CHARS)
        # Skip duplicate: if the last entry has identical step+detail+reason, ignore
        if task.progress:
            last = task.progress[-1]
            if last.step == step and last.detail == detail and last.reason == reason:
                return
        task.progress.append(
            ProgressEntry(
                step=step,
                detail=detail,
                timestamp=time.time(),
                reason=reason,
            )
        )

    @staticmethod
    def _render_progress_entry(entry: "ProgressEntry") -> str:
        """Render a progress entry for the active-task context block.

        Prefers ``"<step>: <reason>"`` when ``reason`` is populated (the new
        WazzapSubAgents native-tool-call format); falls back to
        ``"<step>: <detail>"`` for older sub-agents that only sent ``detail``.
        """
        reason = (entry.reason or "").strip()
        if reason:
            return f"{entry.step}: {reason}"
        return f"{entry.step}: {entry.detail}"

    def finalize(self, session_id: str, result: dict) -> None:
        task = self._active.pop(session_id, None)
        if task is None:
            return
        task.end_time = time.time()
        task.result = result
        success = result.get("success", False)
        task.status = "completed" if success else "failed"
        raw_report = result.get("report") or result.get("error") or None
        task.report = _truncate(raw_report, SUBAGENT_REPORT_MAX_CHARS)
        self._history.setdefault(task.chat_id, deque(maxlen=50)).append(task)

    def get_active_for_chat(self, chat_id: str) -> SubTask | None:
        for task in self._active.values():
            if task.chat_id == chat_id:
                return task
        return None

    def get_chat_for_session(self, session_id: str) -> Optional[str]:
        """Reverse lookup: session_id → chat_id for the *active* task.

        Used by the queue-webhook handler to route a ``queued`` /
        ``queue_advanced`` notification from WazzapSubAgents to the
        correct WhatsApp chat. Returns ``None`` if the session is not in
        the active map (e.g. already finalised).
        """
        task = self._active.get(session_id)
        return task.chat_id if task is not None else None

    # Bounds for the active-task context block. The progress deque can hold
    # up to 100 entries (see SubTask.progress), each with a ~500 char detail
    # — that's potentially 50 KB if rendered raw, which would blow LLM2's
    # context window every turn while a sub-agent is running. We render
    # only the most recent ``_FORMAT_CONTEXT_MAX_PROGRESS`` entries and cap
    # each rendered line to ``_FORMAT_CONTEXT_MAX_PROGRESS_DETAIL`` chars.
    _FORMAT_CONTEXT_MAX_PROGRESS = 5
    _FORMAT_CONTEXT_MAX_PROGRESS_DETAIL = 200

    def format_context(self, chat_id: str) -> str | None:
        task = self.get_active_for_chat(chat_id)
        if task is None:
            return None

        elapsed = task.elapsed_seconds
        minutes = int(elapsed // 60)
        seconds = int(elapsed % 60)
        elapsed_text = f"{minutes}m {seconds}s" if minutes > 0 else f"{seconds}s"

        lines: list[str] = []
        lines.append("## Active sub-agent task (already running for this chat)")
        lines.append(f"- Instruction: {task.instruction}")
        lines.append(f"- Running for: {elapsed_text}")

        if task.progress:
            total = len(task.progress)
            # ``deque`` does not support negative slicing directly, so materialise
            # the last N entries via ``list``.
            tail = list(task.progress)[-self._FORMAT_CONTEXT_MAX_PROGRESS :]
            omitted = total - len(tail)
            lines.append("")
            header = "Progress so far"
            if omitted > 0:
                header += f" (showing last {len(tail)} of {total})"
            lines.append(f"{header}:")
            for entry in tail:
                # ``entry.detail`` already carries the full payload (including
                # ``reason`` from WazzapSubAgents). Prefer a clean
                # "<step>: <reason>" rendering when ``reason`` is available so
                # the bridge surfaces *intent* rather than an opaque blob; fall
                # back to ``detail`` otherwise.
                rendered = self._render_progress_entry(entry)
                if len(rendered) > self._FORMAT_CONTEXT_MAX_PROGRESS_DETAIL:
                    rendered = (
                        rendered[: self._FORMAT_CONTEXT_MAX_PROGRESS_DETAIL - 1] + "…"
                    )
                lines.append(f"- {rendered}")

        lines.append("")
        lines.append("Rules while a sub-agent is in flight:")
        lines.append(
            "- You could call `execute_subtask` again for this chat for steering the sub-agent to correct its progress"
        )
        lines.append(
            '- DO NOT re-acknowledge with phrases like "i\'ll check it!" / '
            '"wait a minute." / "on it". The user already saw your earlier '
            "acknowledgement."
        )
        lines.append(
            "- If the user asks an unrelated question, answer that briefly. "
            "If they're just checking on progress, DO NOT reply with \"It's still working...\", they will think you made things up; instead, tell them the current progress of the sub-agent task."
        )
        lines.append(
            "- The sub-agent's final report will be delivered to you on the next "
            "turn as a `[SUBTASK FINISHED]` system message; that's when you "
            "summarise the result for the user."
        )

        return "\n".join(lines)

    def format_recent_finished(
        self, chat_id: str, *, max_age_seconds: float = 300.0
    ) -> str | None:
        """Render the most recently finished sub-agent task for ``chat_id`` if it
        finished within ``max_age_seconds``.

        This exists so a follow-up message (e.g. user replying to the report)
        in a fresh burst still has a clear, prompt-level signal of what just
        happened. The persistent history already carries the [SUBTASK FINISHED]
        line, but the model is more reliable when we surface it as a dedicated
        context slot rather than relying on it being noticed inside a chat
        transcript.
        """
        history = self._history.get(chat_id)
        if not history:
            return None
        task = history[-1]
        if task.end_time is None:
            return None
        age = time.time() - task.end_time
        if age < 0 or age > max_age_seconds:
            return None
        success_text = "yes" if task.status == "completed" else "no"
        lines: list[str] = []
        lines.append("## Recently finished sub-agent task")
        lines.append(f"- Instruction: {task.instruction}")
        lines.append(f"- Success: {success_text}")
        if task.report:
            lines.append(f"- Report: {task.report}")
        lines.append("")
        lines.append(
            "This task has already been delivered to the user (if there are any files attached to it)."
        )
        lines.append(
            "DO NOT call `execute_subtask` again for THIS SAME task — it is "
            "already done and delivered. You MAY call it for a DIFFERENT new "
            "task the user explicitly asks for."
        )
        return "\n".join(lines)

    def clear_history_for_chat(self, chat_id: str) -> None:
        """Remove all finished-task history for a chat.
        Called after sub-agent result delivery and on /reset so that
        format_recent_finished() no longer injects a stale block.
        Does NOT touch _active — running tasks are unaffected.
        """
        self._history.pop(chat_id, None)

    def clear_all(self) -> None:
        """Wipe all history (not active tasks). Used by /reset global."""
        self._history.clear()

    def format_idle(self, chat_id: str) -> str:
        """Return a context block indicating no sub-agent task is active.
        Gives LLM2 an explicit signal that it is free to call execute_subtask.
        """
        return (
            "## Sub-agent status\n"
            "No sub-agent task is currently running or recently finished.\n"
            "If the user's request qualifies (file processing, code execution, "
            "web scraping, etc.), call `execute_subtask` immediately."
        )
