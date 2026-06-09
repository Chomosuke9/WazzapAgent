"""Pin the context-block contracts that prevent the post-task delivery loop.

The user-visible bug these tests guard against:

  - The bot keeps replying "Siap, aku cek dokumennya" over and over even
    after the sub-agent has finished, and the actual report never reaches
    the user.

The fixes rely on three context blocks that LLM2 sees:

  1. ``format_context()`` — when a task is in flight, must tell LLM2 not to
     re-acknowledge or re-spawn the same task.
  2. ``format_recent_finished()`` — for follow-up bursts after delivery,
     must mark the task as already-delivered so LLM2 does not redo it.
  3. The post-task re-invoke ``subagent_result_block`` (built in main.py)
     uses ``[SUBTASK FINISHED]`` from the same tracker state. The recent-
     finished helper must keep that report intact.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bridge.subagent.tracker import SubTaskTracker  # noqa: E402
from bridge.subagent.models import SubTask  # noqa: E402


def _make_tracker_with_active(chat_id: str = "chat-1") -> SubTaskTracker:
    tracker = SubTaskTracker()
    tracker.register(SubTask(
        session_id="sess-1",
        chat_id=chat_id,
        instruction="Summarise the attached PDF in one paragraph.",
    ))
    return tracker


def test_active_context_warns_against_reack_and_respawn():
    tracker = _make_tracker_with_active()
    block = tracker.format_context("chat-1")
    assert block is not None
    # Active-task header + instruction should be present.
    assert "Active sub-agent task" in block
    assert "Summarise the attached PDF" in block
    # The new anti-loop guidance MUST be present — without it the model
    # happily emits another "oke aku cek dulu" while the task is in flight.
    assert "DO NOT call `execute_subtask` again" in block
    assert "DO NOT re-acknowledge" in block


def test_active_context_returns_none_when_no_task():
    tracker = SubTaskTracker()
    assert tracker.format_context("chat-1") is None


def test_recent_finished_surfaces_report_for_followup_bursts():
    tracker = _make_tracker_with_active()
    tracker.finalize(
        "sess-1",
        {
            "success": True,
            "report": "PDF says: project deadline is next Friday.",
            "output_files": [],
        },
    )
    block = tracker.format_recent_finished("chat-1")
    assert block is not None
    assert "Recently finished sub-agent task" in block
    assert "Summarise the attached PDF" in block
    assert "next Friday" in block
    # Must explicitly tell LLM2 the task is delivered so a follow-up burst
    # doesn't trigger another execute_subtask.
    assert "DO NOT call `execute_subtask` again" in block


def test_recent_finished_expires_after_max_age():
    tracker = _make_tracker_with_active()
    tracker.finalize("sess-1", {"success": True, "report": "ok"})
    # Force an old finish time so the helper treats it as expired.
    history = tracker._history.get("chat-1")
    assert history
    history[-1].end_time = time.time() - 10_000
    assert tracker.format_recent_finished("chat-1", max_age_seconds=300.0) is None


def test_recent_finished_returns_none_when_no_history():
    tracker = SubTaskTracker()
    assert tracker.format_recent_finished("chat-1") is None


def test_active_context_renders_reason_when_available():
    """The new ``reason`` field on ProgressEntry must be surfaced as
    ``"<step>: <reason>"`` so LLM2 sees *why* each tool ran rather than a
    raw JSON-y ``detail`` blob — that's the whole point of plumbing
    ``reason`` through from WazzapSubAgents."""
    tracker = _make_tracker_with_active()
    tracker.update_progress(
        "sess-1",
        "bash",
        "{'reason': 'Mengekstrak zip yang diterima', 'command': 'unzip foo.zip'}",
        reason="Mengekstrak zip yang diterima",
    )
    block = tracker.format_context("chat-1")
    assert block is not None
    # Rendering must use the reason, not the raw detail.
    assert "bash: Mengekstrak zip yang diterima" in block
    # The raw JSON-stringified detail must NOT appear (avoids token
    # bloat and confuses the model).
    assert "command" not in block


def test_active_context_falls_back_to_detail_when_no_reason():
    """Older WazzapSubAgents versions don't send ``reason``; the rendering
    must still produce something useful by falling back to ``detail``."""
    tracker = _make_tracker_with_active()
    tracker.update_progress("sess-1", "python", "calculating averages")
    block = tracker.format_context("chat-1")
    assert block is not None
    assert "python: calculating averages" in block


def test_active_context_truncates_progress_to_last_n():
    """Without truncation, 100 progress entries × ~500 chars each would
    bloat every LLM2 turn while a sub-agent runs. The active-task block
    must keep only the most recent N entries and explicitly note how
    many were elided."""
    tracker = _make_tracker_with_active()
    n_total = 12
    for i in range(n_total):
        # Non-duplicate, alphabetic markers so substring matches don't
        # bleed across iterations (e.g. "step 1" inside "step 12").
        tracker.update_progress(
            "sess-1",
            "bash",
            f"detail-{i:02d}",
            reason=f"step-MARK{i:02d}",
        )

    block = tracker.format_context("chat-1")
    assert block is not None
    expected_visible = [f"MARK{i:02d}" for i in range(n_total - 5, n_total)]
    expected_hidden = [f"MARK{i:02d}" for i in range(n_total - 5)]
    for r in expected_visible:
        assert r in block, f"missing recent reason: {r!r}"
    for r in expected_hidden:
        assert r not in block, f"old reason should be elided: {r!r}"
    # The header should communicate truncation explicitly.
    assert "showing last 5 of 12" in block


def test_active_context_caps_per_entry_length():
    """Even within the recent window, a single progress entry must not
    blow past the per-entry char budget."""
    tracker = _make_tracker_with_active()
    huge_reason = "X" * 5000
    tracker.update_progress("sess-1", "bash", "irrelevant", reason=huge_reason)
    block = tracker.format_context("chat-1")
    assert block is not None
    # The full 5000-char reason MUST NOT appear verbatim.
    assert huge_reason not in block
    # But the truncated prefix should.
    assert "X" * 100 in block
    # And we should see the ellipsis sentinel.
    assert "…" in block


def test_clear_history_for_chat_removes_finished():
    tracker = _make_tracker_with_active()
    tracker.finalize("sess-1", {"success": True, "report": "done"})
    assert tracker.format_recent_finished("chat-1") is not None
    tracker.clear_history_for_chat("chat-1")
    assert tracker.format_recent_finished("chat-1") is None


def test_clear_all_removes_all_history():
    tracker = _make_tracker_with_active()
    tracker.finalize("sess-1", {"success": True, "report": "done"})
    tracker.clear_all()
    assert tracker.format_recent_finished("chat-1") is None


def test_clear_history_does_not_touch_active():
    tracker = _make_tracker_with_active()
    tracker.clear_history_for_chat("chat-1")
    # Active task should still be visible
    assert tracker.format_context("chat-1") is not None


def test_idle_block_when_no_task():
    tracker = SubTaskTracker()
    block = tracker.format_idle("chat-1")
    assert "No sub-agent task is currently running" in block
    assert "execute_subtask" in block


def test_format_recent_finished_mentions_different_task_ok():
    """After wording change, the block must clarify that only the SAME
    task is prohibited, not new different tasks."""
    tracker = _make_tracker_with_active()
    tracker.finalize("sess-1", {"success": True, "report": "done"})
    block = tracker.format_recent_finished("chat-1")
    assert "THIS SAME task" in block
    assert "DIFFERENT new task" in block
