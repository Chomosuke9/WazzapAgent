# File: python/bridge/llm/tool_utils.py
"""Shared tool-call extraction utilities for LLM1 and LLM2."""
from __future__ import annotations

import json


def extract_tool_args(tool_call) -> dict:
  """Best-effort extraction of tool arguments across provider shapes."""
  raw_args = None
  raw_fn = None

  if isinstance(tool_call, dict):
    raw_args = (
      tool_call.get("args")
      or tool_call.get("arguments")
      or tool_call.get("input")
      or tool_call.get("parameters")
    )
    raw_fn = tool_call.get("function")
  else:
    raw_args = (
      getattr(tool_call, "args", None)
      or getattr(tool_call, "arguments", None)
      or getattr(tool_call, "input", None)
      or getattr(tool_call, "parameters", None)
    )
    raw_fn = getattr(tool_call, "function", None)

  # OpenAI-like shape: {"function": {"arguments": "..."}}
  if not raw_args and isinstance(raw_fn, dict):
    raw_args = (
      raw_fn.get("args")
      or raw_fn.get("arguments")
      or raw_fn.get("input")
      or raw_fn.get("parameters")
    )

  if isinstance(raw_args, str):
    try:
      raw_args = json.loads(raw_args)
    except json.JSONDecodeError:
      return {}

  return raw_args or {}


def get_tool_call_name(tc) -> str | None:
  """Extract tool name from a tool call object (dict or attribute-based)."""
  if isinstance(tc, dict):
    name = tc.get("name")
    if name:
      return str(name)
    fn = tc.get("function")
    if isinstance(fn, dict):
      return fn.get("name")
  else:
    name = getattr(tc, "name", None)
    if name:
      return str(name)
    fn = getattr(tc, "function", None)
    if isinstance(fn, dict):
      return fn.get("name")
  return None
