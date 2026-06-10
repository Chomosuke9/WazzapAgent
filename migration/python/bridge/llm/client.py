# File: python/bridge/llm/client.py
from __future__ import annotations

import os
from dataclasses import dataclass

from langchain_openai import ChatOpenAI

from ..config import _parse_positive_int, _parse_positive_float, _parse_non_negative_int, _parse_non_negative_float, _clean_env, _endpoint_base_url


@dataclass(frozen=True)
class LLM1Target:
  name: str
  model: str
  base_url: str
  api_key: str


def _llm1_history_limit() -> int:
  # Prefer LLM1-specific limit; fallback to global history limit.
  raw = os.getenv("LLM1_HISTORY_LIMIT")
  if raw is None or not raw.strip():
    raw = os.getenv("HISTORY_LIMIT")
  return _parse_positive_int(raw, 20)


def _llm1_message_max_chars() -> int:
  return _parse_positive_int(os.getenv("LLM1_MESSAGE_MAX_CHARS"), 500)


def _llm1_timeout(default: float = 8.0) -> float:
  return _parse_positive_float(os.getenv("LLM1_TIMEOUT"), default)


def _llm1_sdk_max_retries() -> int:
  return _parse_non_negative_int(os.getenv("LLM1_SDK_MAX_RETRIES"), 0)


def _llm1_temperature() -> float:
  return _parse_non_negative_float(os.getenv("LLM1_TEMPERATURE"), 0.0)


def _llm1_max_tokens() -> int | None:
  raw = os.getenv("LLM1_MAX_TOKENS")
  if raw is None:
    return None
  cleaned = raw.strip()
  if not cleaned:
    return None
  try:
    parsed = int(cleaned)
  except (TypeError, ValueError):
    return None
  return parsed if parsed > 0 else None


def _chat_base_url() -> str | None:
  return _endpoint_base_url(os.getenv("LLM1_ENDPOINT"))


def _llm1_targets() -> list[LLM1Target]:
  primary_model = _clean_env(os.getenv("LLM1_MODEL")) or "gpt-4o-mini"
  primary_url = _endpoint_base_url(os.getenv("LLM1_ENDPOINT"))
  primary_api_key = os.getenv("LLM1_API_KEY") or os.getenv("OPENAI_API_KEY", "")

  targets: list[LLM1Target] = []
  if primary_url:
    targets.append(
      LLM1Target(
        name="primary",
        model=primary_model,
        base_url=primary_url,
        api_key=primary_api_key,
      )
    )

  fallback_model_raw = _clean_env(os.getenv("LLM1_FALLBACK_MODEL"))
  fallback_url_raw = _clean_env(os.getenv("LLM1_FALLBACK_ENDPOINT"))
  fallback_api_key_raw = _clean_env(os.getenv("LLM1_FALLBACK_API_KEY"))
  fallback_enabled = any((fallback_model_raw, fallback_url_raw, fallback_api_key_raw))
  if not fallback_enabled:
    return targets

  fallback_url = _endpoint_base_url(fallback_url_raw) or primary_url
  if not fallback_url:
    return targets
  fallback_model = fallback_model_raw or primary_model
  fallback_api_key = fallback_api_key_raw or primary_api_key
  fallback_target = LLM1Target(
    name="fallback",
    model=fallback_model,
    base_url=fallback_url,
    api_key=fallback_api_key,
  )
  if targets:
    primary_target = targets[0]
    if (
      fallback_target.model == primary_target.model
      and fallback_target.base_url == primary_target.base_url
      and fallback_target.api_key == primary_target.api_key
    ):
      return targets
  targets.append(fallback_target)
  return targets


def get_llm1(
  *,
  model: str | None = None,
  base_url: str | None = None,
  api_key: str | None = None,
  timeout: float = 8.0,
) -> ChatOpenAI:
  resolved_model = model or _clean_env(os.getenv("LLM1_MODEL")) or "gpt-4o-mini"
  resolved_base_url = base_url if base_url is not None else _chat_base_url()
  resolved_api_key = api_key if api_key is not None else (os.getenv("LLM1_API_KEY") or os.getenv("OPENAI_API_KEY", ""))
  max_tokens = _llm1_max_tokens()
  kwargs = {
    "model": resolved_model,
    "api_key": resolved_api_key,
    "timeout": _llm1_timeout(timeout),
    "max_retries": _llm1_sdk_max_retries(),
    "temperature": _llm1_temperature(),
  }
  if max_tokens is not None:
    kwargs["max_tokens"] = max_tokens
  if resolved_base_url:
    kwargs["base_url"] = resolved_base_url
  return ChatOpenAI(
    **kwargs,
  )
