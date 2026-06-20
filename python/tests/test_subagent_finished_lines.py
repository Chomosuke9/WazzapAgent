"""Unit tests for ``_build_subtask_finished_lines`` — the ``[SUBTASK FINISHED]``
block shown to LLM2 on the sub-agent re-invoke.

Request-2 behaviour: a successful task that produced NO file gets a hint telling
LLM2 it may re-dispatch RIGHT NOW if a file was expected, while a task that DID
stage files (or whose files were dropped for being too large, or that failed)
does not get that note.

Discipline (matching the suite): no pytest-asyncio; the helper is pure.
"""
from __future__ import annotations

from bridge.agent.subagent_coordinator import _build_subtask_finished_lines

_NO_FILE_MARKER = "did NOT include any file"


def _text(**kwargs) -> str:
    return "\n".join(_build_subtask_finished_lines(**kwargs))


def test_completed_without_file_adds_reinvoke_hint():
    text = _text(
        report="Did the analysis.",
        completed=True,
        file_list_text="",
        content_dropped=False,
        has_staged_files=False,
    )
    assert "[SUBTASK FINISHED]" in text
    assert "Success: True" in text
    assert _NO_FILE_MARKER in text
    assert "execute_subtask" in text
    assert "RIGHT NOW" in text


def test_completed_with_file_has_no_hint():
    text = _text(
        report="Here is your file.",
        completed=True,
        file_list_text="Output files attached (1):\n- out.pdf (document, 1.2 KB)",
        content_dropped=False,
        has_staged_files=True,
    )
    assert "out.pdf" in text
    assert _NO_FILE_MARKER not in text


def test_dropped_note_takes_precedence_over_no_file_hint():
    # Files were produced but dropped (too large): show the 'too large' note,
    # NOT the 'no file' hint, even though nothing was staged.
    text = _text(
        report="Made a huge file.",
        completed=True,
        file_list_text="",
        content_dropped=True,
        has_staged_files=False,
    )
    assert "too" in text and "large" in text
    assert _NO_FILE_MARKER not in text


def test_failed_task_has_no_no_file_hint():
    # A failed task (completed=False) without files should not nag about a
    # missing file — the failure itself is the story.
    text = _text(
        report="Could not finish.",
        completed=False,
        file_list_text="",
        content_dropped=False,
        has_staged_files=False,
    )
    assert "Success: False" in text
    assert _NO_FILE_MARKER not in text


def test_missing_report_falls_back_to_no_report():
    text = _text(
        report=None,
        completed=True,
        file_list_text="",
        content_dropped=False,
        has_staged_files=True,
    )
    assert "Result: No report" in text
