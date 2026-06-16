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
from . import settings_repository
from . import models_repository
from . import moderation_repository
from . import stats_repository
from . import activation_repository
from . import scheduled_tasks_repository

# Re-export every name (public and single-underscore private) from the shared
# core and each per-domain repository, so the package namespace mirrors the
# original single ``bridge.db`` module exactly.
_submodules = (
    core,
    settings_repository,
    models_repository,
    moderation_repository,
    stats_repository,
    activation_repository,
    scheduled_tasks_repository,
)
for _mod in _submodules:
    for _name, _val in vars(_mod).items():
        if _name.startswith('__'):
            continue
        globals()[_name] = _val

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
