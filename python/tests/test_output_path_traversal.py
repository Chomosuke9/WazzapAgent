"""Security regression: sub-agent output staging must not write outside the
per-session staging directory.

The base64 ``files_content`` branch of :func:`stage_output_files` previously
used the externally-supplied ``name`` verbatim as the destination filename, so
a crafted ``name`` like ``"../../evil"`` (the value comes from an unauthenticated
sub-agent webhook callback) could escape the staging dir and write to an
arbitrary path. These tests pin the basename-sanitisation + containment guard.
"""
from __future__ import annotations

import base64
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bridge.subagent.output import stage_output_files  # noqa: E402


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def test_base64_name_with_traversal_stays_inside_staging(tmp_path):
    base_dir = tmp_path / "staging"
    outside = tmp_path / "evil.txt"
    payload = b"pwned"

    result = stage_output_files(
        "sess-1",
        [],
        files_content=[{"name": "../../evil.txt", "content_base64": _b64(payload)}],
        base_dir=base_dir,
    )

    # The traversal target must NOT have been created.
    assert not outside.exists()
    # Every staged file must live under the per-session staging root.
    session_root = (base_dir / "sess-1").resolve()
    for sf in result.staged:
        assert Path(sf.path).resolve().is_relative_to(session_root)
    # The payload, if staged, was written under a sanitised basename.
    for sf in result.staged:
        assert "/" not in sf.name
        assert ".." not in Path(sf.path).parts


def test_base64_absolute_name_does_not_escape(tmp_path):
    base_dir = tmp_path / "staging"
    abs_target = tmp_path / "abs_escape.txt"

    result = stage_output_files(
        "sess-2",
        [],
        files_content=[{"name": str(abs_target), "content_base64": _b64(b"x")}],
        base_dir=base_dir,
    )

    assert not abs_target.exists()
    session_root = (base_dir / "sess-2").resolve()
    for sf in result.staged:
        assert Path(sf.path).resolve().is_relative_to(session_root)
