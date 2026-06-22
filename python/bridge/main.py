from __future__ import annotations

import asyncio
import atexit
import signal
from urllib.parse import urlsplit, urlunsplit

from dotenv import load_dotenv

# Step 28: the bridge is a WaSocket CLIENT (Node is the WS server).
from wasocket import make_wa_socket

from .accounts import load_accounts
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


def _resolve_webhook_url(webhook_port: int) -> str:
    """Compose this account's sub-agent callback URL.

    Multi-account fix (audit Medium #4): a configured ``SUBAGENT_WEBHOOK_URL``
    is HONORED — its scheme / host / path / query are preserved so cross-machine
    deploys keep working — while the PORT is overridden with this account's
    ``base + index`` value (the existing, already-correct per-account port
    offset). Only when ``SUBAGENT_WEBHOOK_URL`` is unset do we fall back to
    ``http://localhost:<port>/subagent/callback`` (single-account behaviour
    unchanged: index 0 keeps the configured base port).
    """
    configured = subagent_webhook_url_env()
    if configured and configured.strip():
        parts = urlsplit(configured.strip())
        scheme = parts.scheme or "http"
        host = parts.hostname or "localhost"
        netloc = f"{host}:{webhook_port}"
        # Preserve userinfo if present (rare, but don't silently drop it).
        if parts.username:
            userinfo = parts.username
            if parts.password:
                userinfo += f":{parts.password}"
            netloc = f"{userinfo}@{netloc}"
        path = parts.path or "/subagent/callback"
        return urlunsplit((scheme, netloc, path, parts.query, parts.fragment))
    return f"http://localhost:{webhook_port}/subagent/callback"


def build_session(
    account, index: int, base_webhook_port: int = SUBAGENT_WEBHOOK_PORT
) -> AgentSession:
    """Construct (but do not start) an :class:`AgentSession` for ``account``.

    Resolves the Step-32 per-session sub-agent webhook PORT COLLISION: N sessions
    each starting a webhook server on the same ``SUBAGENT_WEBHOOK_PORT`` would
    fail to bind. We give each account a distinct port ``base + index`` (so the
    first/only account keeps the configured ``SUBAGENT_WEBHOOK_PORT`` and the
    single-account boot is byte-for-byte unchanged) and a matching per-account
    callback URL so the sub-agent calls back into the right session's server.

    The callback URL HONORS a configured ``SUBAGENT_WEBHOOK_URL`` (host/scheme
    from config, port from the per-account offset), falling back to localhost
    only when unset — so cross-machine sub-agent deploys work in multi-account.
    """
    sock = make_wa_socket(account.folder_path, **ws_transport_options())
    webhook_port = base_webhook_port + index
    webhook_url = _resolve_webhook_url(webhook_port)
    # Direct-invoke endpoint port mirrors the webhook per-account offset
    # (base + index) so N accounts don't collide; index 0 keeps the configured
    # base. Disabled entirely unless DIRECT_INVOKE_API_KEY is set (start() no-op).
    direct_invoke_port = direct_invoke_base_port_cfg() + index
    session = AgentSession(
        sock,
        webhook_port=webhook_port,
        webhook_url=webhook_url,
        direct_invoke_port=direct_invoke_port,
    )
    session.register()
    return session


async def main():
    # Step 33: multi-account boot. ``load_accounts()`` returns one
    # AccountConfig per tenant (folder_path + node_url), with a single-account
    # fallback that preserves the Step 32 behaviour. Each account gets its own
    # WaSocket + AgentSession; all connect to Node CONCURRENTLY via
    # ``asyncio.gather`` and run until a shutdown signal fires.
    accounts = load_accounts()
    logger.info("Booting %d account(s)", len(accounts))

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

    # Build one AgentSession per account and start each one's persistent
    # sub-agent webhook (per-account port resolves the collision).
    sessions: list[tuple[object, AgentSession]] = []
    for index, account in enumerate(accounts):
        session = build_session(account, index)
        logger.info(
            "Account %d: folder_path=%s node_url=%s webhook_port=%s",
            index,
            account.folder_path,
            account.node_url,
            session.subagent_webhook._port,
        )
        await session.subagent_webhook.start_persistent()
        sessions.append((account, session))

    try:
        # Run every account's connect→pump→shutdown lifecycle concurrently. Each
        # session.run blocks until stop_event fires; its finally flushes/closes.
        await asyncio.gather(
            *(
                session.run(account.node_url, stop_event)
                for account, session in sessions
            )
        )
    finally:
        logger.info("Shutting down...")
        # Stop every per-session persistent webhook server.
        for _account, session in sessions:
            try:
                await session.subagent_webhook.stop_persistent()
            except Exception as exc:
                logger.error("Error stopping webhook server: %s", exc)
        # Final cleanup
        try:
            db_checkpoint_all_dbs()
            db_close_all_connections()
            atexit.unregister(db_close_all_connections)
        except Exception as exc:
            logger.error("Error during final cleanup: %s", exc)


if __name__ == "__main__":
    asyncio.run(main())
