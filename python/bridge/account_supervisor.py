"""Hot-reload supervisor for per-tenant AgentSession lifecycles."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Callable, Iterable, Protocol

from .accounts import AccountConfig
from .log import setup_logging

logger = setup_logging()


class WebhookLike(Protocol):
    async def start_persistent(self) -> None: ...
    async def stop_persistent(self) -> None: ...


class SessionLike(Protocol):
    subagent_webhook: WebhookLike

    async def run(self, node_url: str, stop_event: asyncio.Event) -> None: ...


@dataclass
class RunningAccount:
    config: AccountConfig
    slot: int
    session: SessionLike
    stop_event: asyncio.Event
    task: asyncio.Task


def assign_account_slots(
    accounts: Iterable[AccountConfig],
    running_slots: dict[str, int] | None = None,
) -> list[tuple[AccountConfig, int]]:
    """Assign collision-free slots while preserving active unpinned tenants."""
    account_list = list(accounts)
    running_slots = running_slots or {}
    used = {account.slot for account in account_list if account.slot is not None}
    if len(used) != sum(account.slot is not None for account in account_list):
        raise ValueError("duplicate account slot")

    assigned: list[tuple[AccountConfig, int]] = []
    for account in account_list:
        if account.slot is not None:
            slot = account.slot
        else:
            previous = running_slots.get(account.folder_path)
            if previous is not None and previous not in used:
                slot = previous
            else:
                slot = next((candidate for candidate in range(1000) if candidate not in used), -1)
                if slot < 0:
                    raise ValueError("no free account runtime slots remain")
        used.add(slot)
        assigned.append((account, slot))
    return assigned


class AccountSupervisor:
    """Reconcile the account catalog with live bridge sessions.

    The catalog is polled because the Node control panel writes it atomically.
    Existing sessions remain untouched when parsing a transient/manual invalid
    edit fails, and identical errors are logged only once.
    """

    def __init__(
        self,
        *,
        loader: Callable[[], list[AccountConfig]],
        session_builder: Callable[[AccountConfig, int], SessionLike],
        callback_url_for_slot: Callable[[int], str],
        poll_interval: float = 1.0,
        stop_timeout: float = 5.0,
    ) -> None:
        self._loader = loader
        self._session_builder = session_builder
        self._callback_url_for_slot = callback_url_for_slot
        self._poll_interval = max(0.1, poll_interval)
        self._stop_timeout = max(0.1, stop_timeout)
        self._running: dict[str, RunningAccount] = {}
        self._last_config_error: str | None = None

    @property
    def running(self) -> dict[str, RunningAccount]:
        return dict(self._running)

    def _plan(self, accounts: list[AccountConfig]) -> list[tuple[AccountConfig, int]]:
        slots = {folder: running.slot for folder, running in self._running.items()}
        planned = assign_account_slots(accounts, slots)
        urls = [self._callback_url_for_slot(slot) for _account, slot in planned]
        if len(urls) != len(set(urls)):
            duplicate = next(url for url in urls if urls.count(url) > 1)
            raise ValueError(
                "Duplicate sub-agent callback URL for multiple accounts: "
                f"{duplicate!r}. Include {{port}} or {{index}} in "
                "SUBAGENT_WEBHOOK_URL so each callback is routable."
            )
        return planned

    async def _start(self, account: AccountConfig, slot: int) -> None:
        session = self._session_builder(account, slot)
        try:
            await session.subagent_webhook.start_persistent()
        except Exception:
            # A bind can fail after partially allocating its runner/site. Keep
            # the failed tenant from leaking a listener between poll retries.
            try:
                await session.subagent_webhook.stop_persistent()
            except Exception:
                pass
            raise
        stop_event = asyncio.Event()
        task = asyncio.create_task(
            session.run(account.node_url, stop_event),
            name=f"account:{account.folder_path}",
        )
        running = RunningAccount(account, slot, session, stop_event, task)
        self._running[account.folder_path] = running

        def _report_done(done: asyncio.Task) -> None:
            if done.cancelled():
                return
            try:
                error = done.exception()
            except asyncio.CancelledError:
                return
            if error is not None:
                logger.error(
                    "Account session exited folder_path=%s error=%r",
                    account.folder_path,
                    error,
                )

        task.add_done_callback(_report_done)
        logger.info(
            "Account started folder_path=%s slot=%s node_url=%s",
            account.folder_path,
            slot,
            account.node_url,
        )

    async def _stop(self, folder_path: str) -> None:
        running = self._running.pop(folder_path, None)
        if running is None:
            return
        running.stop_event.set()
        try:
            await asyncio.wait_for(asyncio.shield(running.task), timeout=self._stop_timeout)
        except asyncio.TimeoutError:
            running.task.cancel()
            await asyncio.gather(running.task, return_exceptions=True)
        except Exception:
            # The done callback records the concrete session failure.
            pass
        try:
            await running.session.subagent_webhook.stop_persistent()
        except Exception as exc:
            logger.error(
                "Error stopping account webhook folder_path=%s error=%r",
                folder_path,
                exc,
            )
        logger.info("Account stopped folder_path=%s slot=%s", folder_path, running.slot)

    async def reconcile(self, accounts: list[AccountConfig]) -> None:
        planned = self._plan(accounts)
        desired = {account.folder_path: (account, slot) for account, slot in planned}

        stop_paths = [
            folder_path
            for folder_path, running in self._running.items()
            if folder_path not in desired
            or desired[folder_path][0].node_url != running.config.node_url
            or desired[folder_path][1] != running.slot
            or running.task.done()
        ]
        if stop_paths:
            await asyncio.gather(*(self._stop(folder_path) for folder_path in stop_paths))

        for account, slot in planned:
            if account.folder_path not in self._running:
                await self._start(account, slot)

    async def run(self, global_stop: asyncio.Event) -> None:
        try:
            accounts = self._loader()
            logger.info("Booting %d account(s)", len(accounts))
            await self.reconcile(accounts)
            while not global_stop.is_set():
                try:
                    await asyncio.wait_for(global_stop.wait(), timeout=self._poll_interval)
                    break
                except asyncio.TimeoutError:
                    pass
                try:
                    accounts = self._loader()
                    await self.reconcile(accounts)
                    if self._last_config_error is not None:
                        logger.info("Account catalog is valid again")
                    self._last_config_error = None
                except Exception as exc:
                    message = str(exc)
                    if message != self._last_config_error:
                        logger.error("Account catalog reload failed; keeping live sessions: %s", message)
                        self._last_config_error = message
        finally:
            if self._running:
                await asyncio.gather(*(self._stop(path) for path in list(self._running)))
