"""Back-compat shim (Step 10).

The Step-29 ``action_ack`` hydration logic now lives in its single home
:mod:`bridge.agent.ack_hydrator`. This module re-exports
:func:`handle_action_ack` so existing importers (and ``test_hydration``) keep
working unchanged.
"""
from __future__ import annotations

from ..agent.ack_hydrator import handle_action_ack

__all__ = ["handle_action_ack"]
