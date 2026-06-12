# File: python/bridge/llm/client.py
from __future__ import annotations

from dataclasses import dataclass

from langchain_openai import ChatOpenAI

from .. import config
from ..config import _clean_env, _endpoint_base_url  # noqa: F401  (re-exported via this module)


@dataclass(frozen=True)
class LLM1Target:
  name: str
  model: str
  base_url: str
  api_key: str


def _llm1_history_limit() -> int:
  # Prefer LLM1-specific limit; fallback to global history limit.
  return config.llm1_history_limit()


def _llm1_message_max_chars() -> int:
  return config.llm1_message_max_chars()


def _llm1_timeout(default: float = 8.0) -> float:
  return config.llm1_timeout(default)


def _llm1_sdk_max_retries() -> int:
  return config.llm1_sdk_max_retries()


def _llm1_temperature() -> float:
  return config.llm1_temperature()


def _llm1_max_tokens() -> int | None:
  return config.llm1_max_tokens()


def _chat_base_url() -> str | None:
  return config.llm1_endpoint_base_url()


def _llm1_targets() -> list[LLM1Target]:
  primary_model = config.llm1_model_clean() or "gpt-4o-mini"
  primary_url = config.llm1_endpoint_base_url()
  primary_api_key = config.llm1_api_key()

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

  fallback_model_raw = config.llm1_fallback_model_clean()
  fallback_url_raw = config.llm1_fallback_endpoint_clean()
  fallback_api_key_raw = config.llm1_fallback_api_key_clean()
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
  resolved_model = model or config.llm1_model_clean() or "gpt-4o-mini"
  resolved_base_url = base_url if base_url is not None else _chat_base_url()
  resolved_api_key = api_key if api_key is not None else config.llm1_api_key()
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
