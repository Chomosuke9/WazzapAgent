from __future__ import annotations

import asyncio
import atexit
import signal
from urllib.parse import urlsplit, urlunsplit

from dotenv import load_dotenv

# Step 28: the bridge is a WaSocket CLIENT (Node is the WS server).
from wasocket import make_wa_socket

from .accounts import load_accounts
from .account_supervisor import AccountSupervisor
from .config import ws_transport_options, direct_invoke_port as direct_invoke_base_port_cfg
from .db import (
    checkpoint_all_dbs as db_checkpoint_all_dbs,
)
from .db import (
    close_all_connections as db_close_all_connections,
)
from .log import setup_logging
from .session import AgentSession
from .subagent.config import SUBAGENT_WEBHOOK_PORT, subagent_webhook_url_env

load_dotenv()

logger = setup_logging()


def _resolve_webhook_url(webhook_port: int, index: int = 0) -> str:
    """Compose this account's sub-agent callback URL.

    A configured remote ``SUBAGENT_WEBHOOK_URL`` is preserved byte-for-byte,
    including an explicit public/reverse-proxy port. ``{port}`` and ``{index}``
    placeholders opt into per-account expansion. For backward compatibility,
    additional accounts on a loopback URL use their local offset port.
    """
    configured = subagent_webhook_url_env()
    if configured and configured.strip():
        value = configured.strip()
        if "{port}" in value or "{index}" in value:
            return value.replace("{port}", str(webhook_port)).replace("{index}", str(index))
        parts = urlsplit(value)
        if (
            (parts.hostname or "").lower() in {"localhost", "127.0.0.1", "::1"}
            and (index > 0 or parts.port is None)
        ):
            host = parts.hostname or "localhost"
            if ":" in host and not host.startswith("["):
                host = f"[{host}]"
            userinfo = ""
            if parts.username:
                userinfo = parts.username
                if parts.password:
                    userinfo += f":{parts.password}"
                userinfo += "@"
            return urlunsplit((
                parts.scheme or "http",
                f"{userinfo}{host}:{webhook_port}",
                parts.path or "/subagent/callback",
                parts.query,
                parts.fragment,
            ))
        # Remote/public URLs are authoritative; never replace their proxy port
        # with the bridge's unrelated local bind port.
        return value
    return f"http://localhost:{webhook_port}/subagent/callback"


def build_session(
    account, slot: int, base_webhook_port: int = SUBAGENT_WEBHOOK_PORT
) -> AgentSession:
    """Construct (but do not start) an :class:`AgentSession` for ``account``.

    Resolves the Step-32 per-session sub-agent webhook PORT COLLISION: N sessions
    each starting a webhook server on the same ``SUBAGENT_WEBHOOK_PORT`` would
    fail to bind. We give each account a distinct port ``base + slot`` (so the
    first/only account keeps the configured ``SUBAGENT_WEBHOOK_PORT`` and the
    single-account boot is byte-for-byte unchanged) and a matching per-account
    callback URL so the sub-agent calls back into the right session's server.

    A remote multi-account deployment should include a ``{port}`` or
    ``{index}`` placeholder in ``SUBAGENT_WEBHOOK_URL`` so its proxy can route
    each account to the matching local webhook server.
    """
    sock = make_wa_socket(
        account.folder_path,
        auth_token=account.ws_token,
        **ws_transport_options(),
    )
    webhook_port = base_webhook_port + slot
    webhook_url = _resolve_webhook_url(webhook_port, index=slot)
    # Direct-invoke endpoint port mirrors the webhook per-account offset
    # (base + slot) so N accounts don't collide; slot 0 keeps the configured
    # base. Disabled entirely unless DIRECT_INVOKE_API_KEY is set (start() no-op).
    direct_invoke_port = direct_invoke_base_port_cfg() + slot
    session = AgentSession(
        sock,
        webhook_port=webhook_port,
        webhook_url=webhook_url,
        direct_invoke_port=direct_invoke_port,
    )
    session.register()
    return session


async def main():
    # Register cleanup handlers so SQLite connections are closed cleanly on exit,
    # preventing WAL file corruption from unclean shutdowns.
    atexit.register(db_close_all_connections)

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _handle_signal(sig):
        logger.info("Received signal %s, triggering shutdown...", sig)
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _handle_signal, sig)
        except NotImplementedError:
            # Windows doesn't support add_signal_handler
            pass

    supervisor = AccountSupervisor(
        # Polling must be silent; the supervisor itself logs only actual
        # lifecycle/config changes instead of one "Loaded N accounts" per second.
        loader=lambda: load_accounts(log=False),
        session_builder=build_session,
        callback_url_for_slot=lambda slot: _resolve_webhook_url(
            SUBAGENT_WEBHOOK_PORT + slot,
            index=slot,
        ),
    )

    try:
        # Reconcile atomically-written catalog changes without restarting the
        # bridge process; each tenant still owns an isolated AgentSession.
        await supervisor.run(stop_event)
    finally:
        logger.info("Shutting down...")
        # Final cleanup
        try:
            db_checkpoint_all_dbs()
            db_close_all_connections()
            atexit.unregister(db_close_all_connections)
        except Exception as exc:
            logger.error("Error during final cleanup: %s", exc)


if __name__ == "__main__":
    asyncio.run(main())
