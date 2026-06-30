"""``bridge.db`` package — per-domain SQLite repositories over a shared core.

Step 11 split the former monolithic ``bridge/db.py`` into a shared
:mod:`~bridge.db.core` (connection getters, per-tenant ``ContextVar`` routing,
the ``_db_resilient`` decorator, the in-memory caches and the schema/migrations)
plus per-domain repository modules:

- :mod:`~bridge.db.settings_repository`  — prompt / permission / mode / triggers
  / subagent toggle / idle trigger
- :mod:`~bridge.db.models_repository`     — LLM2 model resolution + catalog CRUD
- :mod:`~bridge.db.moderation_repository` — mutes
- :mod:`~bridge.db.stats_repository`      — dashboard counters
- :mod:`~bridge.db.activation_repository` — activation safety-net read

Behaviour is unchanged: same SQL, schema, signatures, per-tenant routing,
caches and resilience. This package re-exports the **entire** public *and*
private surface of the old ``bridge.db`` module so every existing
``from bridge.db import X`` / ``from ..db import X`` caller keeps working
without edits.
"""
import sys
from types import ModuleType

from . import core

from .core import (
    # Tenant routing
    set_tenant_db_dir as set_tenant_db_dir,
    reset_tenant_db_dir as reset_tenant_db_dir,
    tenant_db_context as tenant_db_context,
    current_tenant_db_root as current_tenant_db_root,
    # DB path globals (tests monkeypatch these directly on the package)
    _SETTINGS_DB_PATH as _SETTINGS_DB_PATH,
    _STATS_DB_PATH as _STATS_DB_PATH,
    _MODERATION_DB_PATH as _MODERATION_DB_PATH,
    _LOCAL as _LOCAL,
    # Constants
    VALID_MODES as VALID_MODES,
    DEFAULT_MODE as DEFAULT_MODE,
    VALID_TRIGGERS as VALID_TRIGGERS,
    DEFAULT_TRIGGERS as DEFAULT_TRIGGERS,
    DEFAULT_SUBAGENT_ENABLED as DEFAULT_SUBAGENT_ENABLED,
    GLOBAL_CHAT_ID as GLOBAL_CHAT_ID,
    PROMPT_OVERRIDE_PATH as PROMPT_OVERRIDE_PATH,
    DB_BUSY_TIMEOUT_SECONDS as DB_BUSY_TIMEOUT_SECONDS,
    DB_BUSY_TIMEOUT_MS as DB_BUSY_TIMEOUT_MS,
    DB_OPERATION_RETRY_MAX as DB_OPERATION_RETRY_MAX,
    DB_OPERATION_RETRY_BASE_SECONDS as DB_OPERATION_RETRY_BASE_SECONDS,
    DB_RECOVERY_LOCK_STALE_SECONDS as DB_RECOVERY_LOCK_STALE_SECONDS,
    DB_RECOVERY_LOCK_WAIT_SECONDS as DB_RECOVERY_LOCK_WAIT_SECONDS,
    clear_llm2_model_cache as clear_llm2_model_cache,
    clear_default_llm2_model_cache as clear_default_llm2_model_cache,
    clear_subagent_enabled_cache as clear_subagent_enabled_cache,
    reset_settings_connection as reset_settings_connection,
    invalidate_chat_caches as invalidate_chat_caches,
    close_all_connections as close_all_connections,
    checkpoint_all_dbs as checkpoint_all_dbs,
    _tenant_key as _tenant_key,
    _tenant_cache_key as _tenant_cache_key,
    _db_resilient as _db_resilient,
    _cache_lock as _cache_lock,
    _MISSING as _MISSING,
    _prompt_cache as _prompt_cache,
    _permission_cache as _permission_cache,
    _mode_cache as _mode_cache,
    _triggers_cache as _triggers_cache,
    _subagent_enabled_cache as _subagent_enabled_cache,
    _memory_cache as _memory_cache,
    _mute_cache as _mute_cache,
    _llm2_model_cache as _llm2_model_cache,
    _default_llm2_model_cache as _default_llm2_model_cache,
    _ensure_split_ready as _ensure_split_ready,
    _get_settings_conn as _get_settings_conn,
    _get_stats_conn as _get_stats_conn,
    _get_moderation_conn as _get_moderation_conn,
    _get_setting_row as _get_setting_row,
    _get_global_setting_row as _get_global_setting_row,
    _ensure_chat_row as _ensure_chat_row,
    _pop_all_chat_caches as _pop_all_chat_caches,
    _DEFAULT_PROMPT_OVERRIDE as _DEFAULT_PROMPT_OVERRIDE,
    # Internal helpers (tests access these directly)
    _is_db_corruption_error as _is_db_corruption_error,
    _recover_corrupt_db as _recover_corrupt_db,
    _resolve_settings_db_path as _resolve_settings_db_path,
    _resolve_stats_db_path as _resolve_stats_db_path,
    _resolve_moderation_db_path as _resolve_moderation_db_path,
    _drop_cached_connection as _drop_cached_connection,
)
from .settings_repository import (
    get_prompt as get_prompt,
    set_prompt as set_prompt,
    get_join_prompt as get_join_prompt,
    get_memories as get_memories,
    get_participant_name as get_participant_name,
    get_permission as get_permission,
    set_permission as set_permission,
    clear_settings as clear_settings,
    permission_description as permission_description,
    permission_allows_delete as permission_allows_delete,
    permission_allows_mute as permission_allows_mute,
    permission_allows_kick as permission_allows_kick,
    get_mode as get_mode,
    set_mode as set_mode,
    get_triggers as get_triggers,
    set_triggers as set_triggers,
    get_subagent_enabled as get_subagent_enabled,
    set_subagent_enabled as set_subagent_enabled,
    get_idle_trigger as get_idle_trigger,
    set_idle_trigger as set_idle_trigger,
)
from .models_repository import (
    get_default_llm2_model as get_default_llm2_model,
    get_llm2_model as get_llm2_model,
    get_model_vision_support as get_model_vision_support,
    set_llm2_model as set_llm2_model,
    get_all_active_models as get_all_active_models,
    get_all_models as get_all_models,
    add_model as add_model,
    update_model as update_model,
    delete_model as delete_model,
)
from .moderation_repository import (
    add_mute as add_mute,
    remove_mute as remove_mute,
    clear_mutes as clear_mutes,
    is_muted as is_muted,
    is_mute_notified as is_mute_notified,
    mark_mute_notified as mark_mute_notified,
    get_mute_remaining_minutes as get_mute_remaining_minutes,
    list_active_mutes as list_active_mutes,
)
from .stats_repository import (
    upsert_stats_batch as upsert_stats_batch,
    upsert_user_stats_batch as upsert_user_stats_batch,
    get_stats as get_stats,
    get_top_users as get_top_users,
)
from .activation_repository import (
    is_chat_activated as is_chat_activated,
)
from .scheduled_tasks_repository import (
    ScheduledTask as ScheduledTask,
    add_scheduled_task as add_scheduled_task,
    list_scheduled_tasks as list_scheduled_tasks,
    delete_scheduled_task as delete_scheduled_task,
    ScheduledTasksRepository as ScheduledTasksRepository,
)

# Compatibility shim: the legacy single-module ``bridge.db`` kept its mutable
# state (DB-path globals ``_SETTINGS_DB_PATH`` / ``_STATS_DB_PATH`` /
# ``_MODERATION_DB_PATH``, the thread-local connection store ``_LOCAL`` and the
# default-model cache ``_default_llm2_model_cache``) as module globals. Tests
# and callers reassign / monkeypatch those *on the package*
# (e.g. ``monkeypatch.setattr(db, "_SETTINGS_DB_PATH", None)`` or
# ``db._LOCAL = type(db._LOCAL)()``). Now that the implementation lives in
# :mod:`bridge.db.core`, forward writes of any core-owned name to ``core`` so a
# reassignment is observed by the resolvers/connection layer exactly as it was
# before the split (monkeypatch's restore is forwarded the same way).
class _DbPackage(ModuleType):
    def __setattr__(self, name, value):  # type: ignore[no-untyped-def]
        if name in core.__dict__:
            setattr(core, name, value)
        ModuleType.__setattr__(self, name, value)


sys.modules[__name__].__class__ = _DbPackage
