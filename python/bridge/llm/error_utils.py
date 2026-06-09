"""Shared error-inspection utilities for the LLM pipeline."""
from __future__ import annotations


def _is_timeout_error(err: Exception) -> bool:
  current: BaseException | None = err
  depth = 0
  while current is not None and depth < 8:
    if "timeout" in type(current).__name__.lower():
      return True
    current = current.__cause__ or current.__context__
    depth += 1
  return False


def _error_chain(err: Exception, limit: int = 8) -> list[str]:
  chain: list[str] = []
  current: BaseException | None = err
  depth = 0
  while current is not None and depth < limit:
    chain.append(type(current).__name__)
    current = current.__cause__ or current.__context__
    depth += 1
  return chain
