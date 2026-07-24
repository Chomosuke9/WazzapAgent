from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import tempfile
import time
from collections import OrderedDict, deque
from pathlib import Path
from typing import Deque, Dict, Optional

from .config import SUBAGENT_PROGRESS_DETAIL_MAX_CHARS, SUBAGENT_REPORT_MAX_CHARS
from .models import ProgressEntry, SubTask


class SubTaskPersistenceError(RuntimeError):
    """Raised when durable tracker state cannot be committed."""


class SubTaskOutputError(ValueError):
    """Raised when callback output bytes or metadata are not trustworthy."""


def _truncate(text: Optional[str], limit: int) -> Optional[str]:
    if text is None or limit <= 0 or len(text) <= limit:
        return text
    # Reserve room for the marker so the final string never exceeds ``limit``.
    marker = " …[truncated]"
    keep = max(0, limit - len(marker))
    return text[:keep] + marker


class SubTaskTracker:
    _MAX_DEFERRED_COMPLETIONS = 100
    _MAX_DELIVERED_TOMBSTONES = 4096

    def __init__(self, state_path: str | os.PathLike[str] | None = None) -> None:
        self._active: Dict[str, SubTask] = {}
        self._history: Dict[str, Deque[SubTask]] = {}
        # Completion can race task registration, and after a bridge restart a
        # callback can arrive before the account has finished booting.  Keep it
        # durably until the corresponding task is registered instead of
        # returning a misleading success and discarding the result.
        self._deferred_results: OrderedDict[str, dict] = OrderedDict()
        # Durable idempotency tombstones prevent a retried callback from
        # re-sending a report/attachment after the original result was already
        # delivered and its history entry was cleared.
        self._delivered_sessions: OrderedDict[str, float] = OrderedDict()
        self._delivery_checkpoints: Dict[str, set[str]] = {}
        self._delivery_intents: Dict[str, Dict[str, dict]] = {}
        self._state_path = Path(state_path).expanduser().resolve() if state_path else None
        self._load_state()

    def enable_persistence(self, state_path: str | os.PathLike[str]) -> None:
        """Attach durable storage after a late-mounted tenant root appears."""
        resolved = Path(state_path).expanduser().resolve()
        if self._state_path == resolved:
            return
        self._state_path = resolved
        self._load_state()
        self._persist_state()

    @staticmethod
    def _result_for_persistence(result: dict) -> dict:
        """Bound tracker state while retaining enough data for recovery.

        Inline output bytes remain in memory for normal delivery.  Persisting
        tens or hundreds of MiB of base64 into the tracker state on every
        callback is unsafe, so the durable copy keeps file metadata/raw paths
        and explicitly marks inline content as omitted.
        """
        safe = dict(result) if isinstance(result, dict) else {}
        inline = safe.get("output_files_content")
        if isinstance(inline, list) and inline:
            safe["output_files_content"] = [
                {
                    key: value
                    for key, value in item.items()
                    if key != "content_base64"
                }
                for item in inline
                if isinstance(item, dict)
            ]
            safe["output_files_content_dropped"] = True
        return safe

    @staticmethod
    def _task_to_dict(task: SubTask) -> dict:
        return {
            "session_id": task.session_id,
            "instruction": task.instruction,
            "chat_id": task.chat_id,
            "status": task.status,
            "start_time": task.start_time,
            "end_time": task.end_time,
            "progress": [
                {
                    "step": entry.step,
                    "detail": entry.detail,
                    "timestamp": entry.timestamp,
                    "reason": entry.reason,
                }
                for entry in task.progress
            ],
            "result": SubTaskTracker._result_for_persistence(task.result),
            "report": task.report,
        }

    @staticmethod
    def _task_from_dict(raw: dict) -> SubTask:
        task = SubTask(
            session_id=str(raw["session_id"]),
            instruction=str(raw.get("instruction") or ""),
            chat_id=str(raw["chat_id"]),
            status=str(raw.get("status") or "running"),
            start_time=float(raw.get("start_time") or time.time()),
            end_time=(float(raw["end_time"]) if raw.get("end_time") is not None else None),
            result=(raw.get("result") if isinstance(raw.get("result"), dict) else {}),
            report=(str(raw["report"]) if raw.get("report") is not None else None),
        )
        for entry in raw.get("progress") or []:
            if not isinstance(entry, dict):
                continue
            task.progress.append(ProgressEntry(
                step=str(entry.get("step") or "unknown"),
                detail=str(entry.get("detail") or ""),
                timestamp=float(entry.get("timestamp") or time.time()),
                reason=(str(entry["reason"]) if entry.get("reason") is not None else None),
            ))
        return task

    def _load_state(self) -> None:
        if self._state_path is None or not self._state_path.is_file():
            return
        try:
            raw = json.loads(self._state_path.read_text(encoding="utf-8"))
            for item in raw.get("active") or []:
                task = self._task_from_dict(item)
                self._active[task.session_id] = task
                self._history.setdefault(task.chat_id, deque(maxlen=50))
            for chat_id, items in (raw.get("history") or {}).items():
                history: Deque[SubTask] = deque(maxlen=50)
                for item in items or []:
                    history.append(self._task_from_dict(item))
                self._history[str(chat_id)] = history
            for session_id, item in (raw.get("deferred_results") or {}).items():
                if isinstance(item, dict):
                    self._deferred_results[str(session_id)] = item
            for session_id, delivered_at in (raw.get("delivered_sessions") or {}).items():
                self._delivered_sessions[str(session_id)] = float(delivered_at)
            for session_id, parts in (raw.get("delivery_checkpoints") or {}).items():
                if isinstance(parts, list):
                    self._delivery_checkpoints[str(session_id)] = {
                        str(part) for part in parts if isinstance(part, str)
                    }
            for session_id, intents in (raw.get("delivery_intents") or {}).items():
                if isinstance(intents, dict):
                    self._delivery_intents[str(session_id)] = {
                        str(part): dict(intent)
                        for part, intent in intents.items()
                        if isinstance(part, str) and isinstance(intent, dict)
                    }
        except Exception as exc:
            # Starting with empty state could duplicate already-delivered
            # WhatsApp messages or orphan active callbacks. Preserve the bad
            # file for diagnosis, then fail closed.
            self._active.clear()
            self._history.clear()
            self._deferred_results.clear()
            self._delivered_sessions.clear()
            self._delivery_checkpoints.clear()
            self._delivery_intents.clear()
            try:
                corrupt = self._state_path.with_suffix(
                    self._state_path.suffix + f".corrupt-{int(time.time())}"
                )
                os.replace(self._state_path, corrupt)
            except OSError:
                pass
            raise SubTaskPersistenceError(
                f"sub-agent tracker state is corrupt: {exc}"
            ) from exc

    def _persist_state(self) -> None:
        if self._state_path is None:
            return
        payload = {
            "version": 1,
            "active": [self._task_to_dict(task) for task in self._active.values()],
            "history": {
                chat_id: [self._task_to_dict(task) for task in history]
                for chat_id, history in self._history.items()
            },
            "deferred_results": {
                session_id: self._result_for_persistence(result)
                for session_id, result in self._deferred_results.items()
            },
            "delivered_sessions": dict(self._delivered_sessions),
            "delivery_checkpoints": {
                session_id: sorted(parts)
                for session_id, parts in self._delivery_checkpoints.items()
            },
            "delivery_intents": self._delivery_intents,
        }
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_name = tempfile.mkstemp(
                prefix=f".{self._state_path.name}.",
                suffix=".tmp",
                dir=self._state_path.parent,
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(
                        payload,
                        handle,
                        ensure_ascii=False,
                        separators=(",", ":"),
                        default=str,
                    )
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(tmp_name, self._state_path)
            except Exception:
                try:
                    os.unlink(tmp_name)
                except FileNotFoundError:
                    pass
                raise
        except OSError as exc:
            raise SubTaskPersistenceError(
                f"could not persist sub-agent tracker state: {exc}"
            ) from exc

    def _spool_inline_outputs(self, session_id: str, result: dict) -> dict:
        """Durably turn inline callback bytes into local-path manifest entries.

        This keeps restart recovery useful for cross-machine deployments while
        preventing the tracker JSON and deferred-result map from retaining huge
        base64 strings. The normal output staging path later copies these files
        into the tenant's Node-allowlisted media directory.
        """
        if not isinstance(result, dict):
            return result
        inline = result.get("output_files_content")
        if not isinstance(inline, list) or not inline:
            return result
        if self._state_path is None:
            raise SubTaskOutputError("durable callback spool is not configured")
        if len(inline) > 64:
            raise SubTaskOutputError("callback declares more than 64 output files")
        spool_root = (
            self._state_path.parent
            / "subagent_callback_inbox"
            / hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:24]
        )
        written: list[Path] = []
        local_entries: list[dict] = []
        total_size = 0
        allowed_root = (self._state_path.parent / "subagent_callback_inbox").resolve()
        try:
            spool_root.mkdir(parents=True, exist_ok=True)
            for index, item in enumerate(inline):
                if not isinstance(item, dict):
                    raise SubTaskOutputError("inline output entry must be an object")
                encoded = item.get("content_base64")
                if not isinstance(encoded, (str, bytes)) or not encoded:
                    local_path = item.get("local_path")
                    if local_path:
                        candidate = Path(str(local_path)).expanduser().resolve()
                        try:
                            candidate.relative_to(allowed_root)
                        except ValueError as exc:
                            raise SubTaskOutputError(
                                "local output path is outside the tenant callback inbox"
                            ) from exc
                        if candidate.is_symlink() or not candidate.is_file():
                            raise SubTaskOutputError("local output file is unavailable")
                        declared_size = item.get("size", item.get("size_bytes"))
                        declared_sha = str(item.get("sha256") or "").lower()
                        if isinstance(declared_size, bool) or not isinstance(declared_size, int):
                            raise SubTaskOutputError("local output has invalid size")
                        digest = hashlib.sha256()
                        size = 0
                        with candidate.open("rb") as handle:
                            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                                size += len(chunk)
                                digest.update(chunk)
                        if size != declared_size or digest.hexdigest() != declared_sha:
                            raise SubTaskOutputError("local output size/checksum mismatch")
                    local_entries.append(dict(item))
                    continue
                original_name = Path(str(item.get("name") or f"output-{index}")).name
                if original_name in {"", ".", ".."}:
                    original_name = f"output-{index}"
                decoded = base64.b64decode(encoded, validate=True)
                declared_size = item.get("size", item.get("size_bytes"))
                declared_sha = str(item.get("sha256") or "").lower()
                if isinstance(declared_size, bool) or not isinstance(declared_size, int):
                    raise SubTaskOutputError("inline output has invalid size")
                if declared_size != len(decoded):
                    raise SubTaskOutputError("inline output size mismatch")
                digest = hashlib.sha256(decoded).hexdigest()
                if len(declared_sha) != 64 or digest != declared_sha:
                    raise SubTaskOutputError("inline output checksum mismatch")
                if declared_size > 200 * 1024 * 1024:
                    raise SubTaskOutputError("inline output exceeds the 200 MB file limit")
                total_size += declared_size
                if total_size > 256 * 1024 * 1024:
                    raise SubTaskOutputError("inline outputs exceed the 256 MB aggregate limit")
                final_name = f"{index:04d}-{digest[:12]}-{original_name}"
                destination = spool_root / final_name
                if not destination.is_file():
                    fd, temporary = tempfile.mkstemp(prefix=".inline-", dir=spool_root)
                    try:
                        with os.fdopen(fd, "wb") as handle:
                            handle.write(decoded)
                            handle.flush()
                            os.fsync(handle.fileno())
                        os.replace(temporary, destination)
                        written.append(destination)
                    except Exception:
                        try:
                            os.unlink(temporary)
                        except FileNotFoundError:
                            pass
                        raise
                local_entry = {
                    key: value for key, value in item.items()
                    if key != "content_base64"
                }
                local_entry["local_path"] = str(destination.resolve())
                local_entries.append(local_entry)
        except (OSError, ValueError, TypeError) as exc:
            for path in written:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
            if isinstance(exc, SubTaskOutputError):
                raise
            raise SubTaskOutputError(f"could not durably spool callback output: {exc}") from exc
        spooled = dict(result)
        spooled["output_files_content"] = local_entries
        spooled["output_files_content_spooled"] = True
        spooled["_spooled_output_dir"] = str(spool_root.resolve())
        return spooled

    def prepare_result(self, session_id: str, result: dict) -> dict:
        """Validate and durably materialize callback bytes before HTTP ACK."""
        return self._spool_inline_outputs(session_id, result)

    def callback_download_path(
        self, session_id: str, file_id: str, name: str,
    ) -> Path | None:
        """Allocate a deterministic durable path for a streamed output."""
        if self._state_path is None:
            return None
        spool_root = (
            self._state_path.parent
            / "subagent_callback_inbox"
            / hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:24]
        )
        safe_name = Path(str(name or "output.bin")).name
        if safe_name in {"", ".", ".."}:
            safe_name = "output.bin"
        file_key = hashlib.sha256(str(file_id).encode("utf-8")).hexdigest()[:12]
        spool_root.mkdir(parents=True, exist_ok=True)
        return spool_root / f"{file_key}-{safe_name}"

    def callback_inbox_root(self) -> Path | None:
        """Return the only root trusted for callback-created local files."""
        if self._state_path is None:
            return None
        return (self._state_path.parent / "subagent_callback_inbox").resolve()

    def _cleanup_result_spool(self, result: dict) -> None:
        raw = result.get("_spooled_output_dir") if isinstance(result, dict) else None
        if not raw or self._state_path is None:
            return
        allowed_root = (self._state_path.parent / "subagent_callback_inbox").resolve()
        candidate = Path(str(raw)).expanduser().resolve()
        try:
            candidate.relative_to(allowed_root)
        except ValueError:
            return
        if candidate != allowed_root:
            shutil.rmtree(candidate, ignore_errors=True)

    def _cleanup_task_spool(self, task: SubTask) -> None:
        self._cleanup_result_spool(task.result)

    def register(self, task: SubTask) -> bool:
        """Register *task* and replay a completion that arrived early.

        Returns ``True`` when a deferred completion was applied immediately.
        """
        self._active[task.session_id] = task
        self._history.setdefault(task.chat_id, deque(maxlen=50))
        deferred = self._deferred_results.pop(task.session_id, None)
        if deferred is not None:
            return self.finalize(task.session_id, deferred)
        self._persist_state()
        return False

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

    def finalize(self, session_id: str, result: dict, *, prepared: bool = False) -> bool:
        """Finalize a known task, returning whether the result was accepted.

        Duplicate/late completions for a task already in history are treated
        idempotently and can replace a local timeout with the real result.
        Unknown session IDs return ``False`` so the webhook layer can retain
        them and return a retryable non-2xx response.
        """
        if session_id in self._delivered_sessions:
            return True
        task = self._active.get(session_id)
        if task is None:
            for history in self._history.values():
                for candidate in history:
                    if candidate.session_id == session_id:
                        if not prepared:
                            result = self._spool_inline_outputs(session_id, result)
                        previous = (
                            candidate.end_time,
                            candidate.result,
                            candidate.status,
                            candidate.report,
                        )
                        candidate.end_time = time.time()
                        candidate.result = result
                        success = result.get("success", False)
                        candidate.status = "completed" if success else "failed"
                        raw_report_value = result.get("report") or result.get("error") or None
                        raw_report = str(raw_report_value) if raw_report_value is not None else None
                        candidate.report = _truncate(raw_report, SUBAGENT_REPORT_MAX_CHARS)
                        try:
                            self._persist_state()
                        except Exception:
                            (
                                candidate.end_time,
                                candidate.result,
                                candidate.status,
                                candidate.report,
                            ) = previous
                            raise
                        return True
            return False
        if not prepared:
            result = self._spool_inline_outputs(session_id, result)
        self._active.pop(session_id, None)
        previous = (task.end_time, task.result, task.status, task.report)
        task.end_time = time.time()
        task.result = result
        success = result.get("success", False)
        task.status = "completed" if success else "failed"
        raw_report_value = result.get("report") or result.get("error") or None
        raw_report = str(raw_report_value) if raw_report_value is not None else None
        task.report = _truncate(raw_report, SUBAGENT_REPORT_MAX_CHARS)
        history = self._history.setdefault(task.chat_id, deque(maxlen=50))
        evicted = history[0] if len(history) == history.maxlen else None
        history.append(task)
        try:
            self._persist_state()
        except Exception:
            try:
                history.remove(task)
            except ValueError:
                pass
            if evicted is not None:
                history.appendleft(evicted)
            task.end_time, task.result, task.status, task.report = previous
            self._active[session_id] = task
            raise
        return True

    def defer_completion(
        self, session_id: str, result: dict, *, prepared: bool = False,
    ) -> None:
        """Retain an unknown completion for registration/restart recovery."""
        if not prepared:
            result = self._spool_inline_outputs(session_id, result)
        previous = self._deferred_results.get(session_id)
        self._deferred_results[session_id] = result
        self._deferred_results.move_to_end(session_id)
        while len(self._deferred_results) > self._MAX_DEFERRED_COMPLETIONS:
            _old_session, old_result = self._deferred_results.popitem(last=False)
            self._cleanup_result_spool(old_result)
        try:
            self._persist_state()
        except Exception:
            self._deferred_results.pop(session_id, None)
            if previous is not None:
                self._deferred_results[session_id] = previous
            raise

    def is_finished(self, session_id: str) -> bool:
        return any(
            task.session_id == session_id
            for history in self._history.values()
            for task in history
        )

    def get_finished(self, session_id: str) -> SubTask | None:
        for history in self._history.values():
            for task in history:
                if task.session_id == session_id:
                    return task
        return None

    def is_delivered(self, session_id: str) -> bool:
        return session_id in self._delivered_sessions

    def is_delivery_part_done(self, session_id: str, part: str) -> bool:
        return part in self._delivery_checkpoints.get(session_id, set())

    def get_delivery_intent(self, session_id: str, part: str) -> dict | None:
        intent = self._delivery_intents.get(session_id, {}).get(part)
        return dict(intent) if intent is not None else None

    def prepare_delivery_part(
        self, session_id: str, part: str, intent: dict,
    ) -> dict:
        """Persist the exact outbound payload before attempting delivery."""
        existing = self.get_delivery_intent(session_id, part)
        if existing is not None:
            return existing
        intents = self._delivery_intents.setdefault(session_id, {})
        intents[part] = dict(intent)
        try:
            self._persist_state()
        except Exception:
            intents.pop(part, None)
            if not intents:
                self._delivery_intents.pop(session_id, None)
            raise
        return dict(intent)

    def mark_delivery_part_done(self, session_id: str, part: str) -> None:
        parts = self._delivery_checkpoints.setdefault(session_id, set())
        if part in parts:
            return
        previous_intent = self._delivery_intents.get(session_id, {}).pop(part, None)
        parts.add(part)
        try:
            self._persist_state()
        except Exception:
            parts.discard(part)
            if not parts:
                self._delivery_checkpoints.pop(session_id, None)
            if previous_intent is not None:
                self._delivery_intents.setdefault(session_id, {})[part] = previous_intent
            raise
        intents = self._delivery_intents.get(session_id)
        if intents is not None and not intents:
            self._delivery_intents.pop(session_id, None)

    def mark_delivered(self, session_id: str) -> None:
        previous_history = {
            chat_id: deque(history, maxlen=history.maxlen)
            for chat_id, history in self._history.items()
        }
        previous_delivered = OrderedDict(self._delivered_sessions)
        previous_checkpoints = {
            key: set(parts) for key, parts in self._delivery_checkpoints.items()
        }
        previous_intents = {
            key: {part: dict(intent) for part, intent in intents.items()}
            for key, intents in self._delivery_intents.items()
        }
        removed_tasks: list[SubTask] = []
        for chat_id, history in list(self._history.items()):
            retained: Deque[SubTask] = deque(maxlen=50)
            for task in history:
                if task.session_id == session_id:
                    removed_tasks.append(task)
                else:
                    retained.append(task)
            if retained:
                self._history[chat_id] = retained
            else:
                self._history.pop(chat_id, None)
        self._delivered_sessions[session_id] = time.time()
        self._delivered_sessions.move_to_end(session_id)
        while len(self._delivered_sessions) > self._MAX_DELIVERED_TOMBSTONES:
            self._delivered_sessions.popitem(last=False)
        self._delivery_checkpoints.pop(session_id, None)
        self._delivery_intents.pop(session_id, None)
        try:
            self._persist_state()
        except Exception:
            self._history = previous_history
            self._delivered_sessions = previous_delivered
            self._delivery_checkpoints = previous_checkpoints
            self._delivery_intents = previous_intents
            raise
        for task in removed_tasks:
            self._cleanup_task_spool(task)

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
        removed = self._history.pop(chat_id, None)
        for task in removed or []:
            self._delivered_sessions[task.session_id] = time.time()
            self._cleanup_task_spool(task)
        while len(self._delivered_sessions) > self._MAX_DELIVERED_TOMBSTONES:
            self._delivered_sessions.popitem(last=False)
        self._persist_state()

    def clear_all(self) -> None:
        """Wipe all history (not active tasks). Used by /reset global."""
        for history in self._history.values():
            for task in history:
                self._delivered_sessions[task.session_id] = time.time()
                self._cleanup_task_spool(task)
        while len(self._delivered_sessions) > self._MAX_DELIVERED_TOMBSTONES:
            self._delivered_sessions.popitem(last=False)
        self._history.clear()
        self._persist_state()

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
