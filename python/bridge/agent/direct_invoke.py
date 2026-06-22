"""``DirectInvokeServer`` — authenticated HTTP endpoint to make the bot send a
message FIRST.

A small per-account aiohttp server exposing ``/post``. On a valid, authenticated
request it injects a ``#system`` turn into the target chat's history and
re-invokes LLM2 (via the shared
:class:`~bridge.agent.chat_reinvoker.ChatReinvoker`, routed through the session's
``submit`` callback) so the bot proactively sends a message — e.g. triggered
from a smartwatch so a WhatsApp notification arrives.

Request (GET or POST ``/post``)::

    /post?q=<prompt>&jid=<target chat jid>&key=<api key>

  - ``q``    the prompt, injected as a ``#system`` history turn (NOT a LangChain
             system message — the bot's own history-builder system turn).
  - ``jid``  the target chat (``...@g.us`` / ``...@s.whatsapp.net`` / ``...@lid``;
             a bare phone number is normalised to ``<digits>@s.whatsapp.net``).
  - ``key``  the shared secret (``DIRECT_INVOKE_API_KEY``). May instead be sent
             as ``X-Api-Key: <key>`` or ``Authorization: Bearer <key>`` (a
             header keeps the secret out of URLs / proxy logs).

POST callers may alternatively send ``q`` / ``jid`` / ``key`` in a JSON or form
body (query-string values take precedence).

SECURITY: this endpoint can make the bot send arbitrary messages, so it is
FAIL-CLOSED — it does not start unless ``DIRECT_INVOKE_API_KEY`` is set, every
request is checked with a constant-time comparison, and it binds loopback
(``127.0.0.1``) by default. The aiohttp access log is disabled so the key (when
passed in the query string) is never written to logs. Expose it beyond loopback
only behind a firewall / reverse proxy.

The LLM2 re-invoke is dispatched as a background task by the injected ``submit``
callback (so a slow model never blocks the HTTP response); a successful request
returns ``202 Accepted`` immediately.
"""
from __future__ import annotations

import hmac
import re
from typing import Callable, Optional

try:
  from aiohttp import web
except ImportError:  # pragma: no cover - import-time guard
  # Mirrors subagent/webhook_server.py: keep the import succeeding so callers
  # that never start the server don't blow up; ``start()`` logs + no-ops if
  # aiohttp is genuinely missing at runtime.
  web = None  # type: ignore

from ..log import setup_logging

logger = setup_logging()


# Accepted WhatsApp JID suffixes. A value ending with one of these is taken
# as-is; anything else is treated as a (possibly formatted) phone number.
_JID_SUFFIXES = ("@g.us", "@s.whatsapp.net", "@lid", "@c.us", "@broadcast")

# Hard cap on the request body we will read (defensive; the prompt itself is
# additionally bounded by ``max_chars``). 1 MiB is plenty for a text prompt.
_CLIENT_MAX_SIZE = 1 * 1024 * 1024


def normalize_jid(raw: Optional[str]) -> Optional[str]:
  """Return a WhatsApp JID for *raw*, or ``None`` if it can't be one.

  Accepts a full JID (any known suffix) verbatim. Otherwise, if the value is
  essentially a phone number (digits, optionally with ``+``/spaces/dashes/
  parentheses), it is normalised to ``<digits>@s.whatsapp.net`` so callers can
  pass a bare number for a DM.
  """
  jid = (raw or "").strip()
  if not jid:
    return None
  if jid.endswith(_JID_SUFFIXES):
    return jid
  compact = re.sub(r"[\s\-()]", "", jid)
  if compact.startswith("+"):
    compact = compact[1:]
  if compact.isdigit() and compact:
    return f"{compact}@s.whatsapp.net"
  return None


def _bearer_token(auth_header: Optional[str]) -> Optional[str]:
  """Extract ``<token>`` from an ``Authorization: Bearer <token>`` header."""
  if not auth_header:
    return None
  parts = auth_header.split(None, 1)
  if len(parts) == 2 and parts[0].lower() == "bearer":
    return parts[1].strip() or None
  return None


class DirectInvokeServer:
  """Per-account HTTP ``/post`` endpoint that triggers a bot-first message.

  :param submit: ``(chat_id, prompt) -> None`` — called (already authenticated)
    to schedule the LLM2 re-invoke as a background task. MUST NOT block.
  :param api_key: the shared secret; when falsy the server is DISABLED.
  :param host: bind host (default-resolved by the caller; loopback recommended).
  :param port: bind port.
  :param max_chars: maximum accepted length of ``q`` (longer ⇒ 413).
  """

  def __init__(
    self,
    *,
    submit: Callable[[str, str], None],
    api_key: Optional[str],
    host: str,
    port: int,
    max_chars: int,
  ) -> None:
    self._submit = submit
    self._api_key = api_key or None
    self._host = host
    self._port = port
    self._max_chars = max_chars
    self._runner = None
    self._site = None

  @property
  def enabled(self) -> bool:
    return bool(self._api_key)

  def _build_app(self):
    """Build the aiohttp application (routes + limits). Shared by :meth:`start`
    and by tests that drive the endpoint through a real ``TestClient``."""
    app = web.Application(client_max_size=_CLIENT_MAX_SIZE)
    app.router.add_route("GET", "/post", self._handle_post)
    app.router.add_route("POST", "/post", self._handle_post)
    app.router.add_get("/health", self._handle_health)
    return app

  async def start(self) -> None:
    """Start the endpoint, unless disabled (no API key) or aiohttp is missing.

    Fail-closed: with no ``DIRECT_INVOKE_API_KEY`` the server never binds, so
    the bot can't be driven by an unauthenticated caller.
    """
    if not self._api_key:
      logger.info(
        "Direct-invoke endpoint disabled (set DIRECT_INVOKE_API_KEY to enable)"
      )
      return
    if web is None:
      logger.error(
        "Direct-invoke endpoint requires aiohttp but it is not installed; "
        "endpoint disabled. Install via `pip install -r requirements.txt`."
      )
      return
    # access_log=None: the API key may arrive in the query string, and aiohttp's
    # default access logger writes the full request line (path + query). Disable
    # it so the secret is never persisted to logs.
    self._runner = web.AppRunner(self._build_app(), access_log=None)
    try:
      await self._runner.setup()
      self._site = web.TCPSite(self._runner, self._host, self._port)
      await self._site.start()
    except Exception as err:  # pylint: disable=broad-except
      # An optional endpoint must never crash the bridge boot (e.g. the port is
      # already in use). Log loudly, clean up, and leave it disabled — the core
      # WhatsApp pipeline keeps running. In multi-account this also prevents one
      # account's bind failure from tearing down the others via asyncio.gather.
      logger.error(
        "Direct-invoke endpoint failed to bind %s:%s — endpoint disabled: %s",
        self._host, self._port, err,
      )
      await self.stop()
      return
    logger.info(
      "Direct-invoke endpoint started on %s:%s (GET/POST /post)",
      self._host, self._port,
    )

  async def stop(self) -> None:
    """Stop the endpoint if it is running (idempotent)."""
    if self._site is not None:
      await self._site.stop()
      self._site = None
    if self._runner is not None:
      await self._runner.cleanup()
      self._runner = None

  # ------------------------------------------------------------------ #
  # Request handling
  # ------------------------------------------------------------------ #

  async def _read_params(self, request) -> dict:
    """Collect request params from the query string, then (POST only) merge in
    JSON / form-body fields WITHOUT overriding query values."""
    params = dict(request.query)
    if request.method == "POST" and request.body_exists:
      ctype = (request.headers.get("Content-Type") or "").lower()
      try:
        if "application/json" in ctype:
          body = await request.json()
          if isinstance(body, dict):
            for key, value in body.items():
              params.setdefault(key, value)
        elif (
          "application/x-www-form-urlencoded" in ctype
          or "multipart/form-data" in ctype
        ):
          form = await request.post()
          for key, value in form.items():
            params.setdefault(key, value)
      except Exception:  # pylint: disable=broad-except
        # Malformed body — fall back to query params only.
        logger.debug("direct-invoke: ignoring unparseable request body")
    return params

  def _authorized(self, request, params: dict) -> bool:
    """Constant-time check of the provided key against the configured secret.

    Looks in ``X-Api-Key``, then ``Authorization: Bearer``, then the ``key``
    query/body param. Always compares (even when no key was provided) so the
    code path is uniform.
    """
    if not self._api_key:
      return False
    provided = (
      request.headers.get("X-Api-Key")
      or _bearer_token(request.headers.get("Authorization"))
      or params.get("key")
      or ""
    )
    if not isinstance(provided, str):
      return False
    return hmac.compare_digest(provided, self._api_key)

  async def _handle_post(self, request):
    params = await self._read_params(request)

    if not self._authorized(request, params):
      logger.warning(
        "direct-invoke: unauthorized request from %s",
        request.remote,
      )
      return web.json_response({"status": "unauthorized"}, status=401)

    q = params.get("q")
    if not isinstance(q, str) or not q.strip():
      return web.json_response({"status": "missing_q"}, status=400)
    if len(q) > self._max_chars:
      return web.json_response(
        {"status": "prompt_too_long", "max_chars": self._max_chars},
        status=413,
      )

    jid = normalize_jid(params.get("jid") if isinstance(params.get("jid"), str) else None)
    if jid is None:
      return web.json_response({"status": "invalid_jid"}, status=400)

    try:
      self._submit(jid, q)
    except Exception as err:  # pylint: disable=broad-except
      logger.exception("direct-invoke: failed to submit jid=%s: %s", jid, err)
      return web.json_response({"status": "error"}, status=500)

    logger.info("direct-invoke: accepted jid=%s chars=%d", jid, len(q))
    return web.json_response({"status": "accepted", "jid": jid}, status=202)

  async def _handle_health(self, request):
    return web.json_response({"status": "ok", "enabled": self.enabled})
