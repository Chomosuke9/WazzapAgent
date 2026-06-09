"""Strict-mode schema invariants for the execute_subtask tool.

OpenAI's strict tool-call mode rejects schemas where ``required`` does not
list every property name. Past regression: ``context_msg_ids`` was added as
a property but left out of ``required``, which made every LLM2 call fail
with::

    Invalid schema for function 'execute_subtask': In context=(),
    'required' is required to be supplied and to be an array including
    every key in properties. Missing 'context_msg_ids'.

These tests pin the contract so the regression can't return silently.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bridge.llm.schemas import LLM2_SUBAGENT_TOOL  # noqa: E402


def _params() -> dict:
    return LLM2_SUBAGENT_TOOL["function"]["parameters"]


def test_strict_mode_enabled():
    assert LLM2_SUBAGENT_TOOL["function"]["strict"] is True


def test_required_lists_every_property():
    params = _params()
    properties = set(params["properties"].keys())
    required = set(params["required"])
    missing = properties - required
    assert not missing, (
        f"strict mode demands every property be required, missing: {missing}"
    )


def test_no_extra_required_keys():
    params = _params()
    properties = set(params["properties"].keys())
    extra = set(params["required"]) - properties
    assert not extra, f"required lists keys not in properties: {extra}"


def test_additional_properties_disallowed():
    assert _params()["additionalProperties"] is False


def test_context_msg_ids_is_nullable_array():
    # The optionality of context_msg_ids is modeled via type=["array","null"]
    # because strict mode bans absent keys. If someone reverts to
    # type="array", LLMs that don't always pass it would error out.
    schema = _params()["properties"]["context_msg_ids"]
    assert "null" in schema["type"], (
        "context_msg_ids must accept null so callers can omit input files"
    )
    assert "array" in schema["type"]
