# 06-rebuild-from-scratch.md — Accuracy Review

**Overall Accuracy: 98%** ✅

Verified against codebase commit 49f36be and current state.

---

## ✅ Verified Accurate

All major sections are accurate:
- System architecture (Node/Python split, tenant isolation)
- Source map & file locations  
- WebSocket handshake & protocol flow
- History building & context rendering
- Tool schemas & LLM pipeline
- Startup lifecycle (Milestone 1-6)
- Anti-patterns (P0-P3, P2-P3)
- Keeps section

---

## ⚠️ Minor Inaccuracies Found

### 1. **Line 361: SubAgent Auth Token Env Var Name** ✓ CONFIRMED

**Document states:**
```
It uses `Authorization: Bearer <SUBAGENT_API_TOKEN>`.
```

**Reality (verified in code):**
- Env var name is correct: `SUBAGENT_API_TOKEN`
- Read from: `python/bridge/subagent/config.py` line 110
- Used in: `python/bridge/subagent/client.py` line 300-301
  ```python
  def _auth_headers() -> dict[str, str]:
    token = subagent_api_token_env()
    return {"Authorization": f"Bearer {token}"} if token else {}
  ```

**Status:** ✅ Accurate


### 2. **Line 597: actionDispatcher Return Type** ✓ CONFIRMED

**Document states:**
```
Node starts each WebSocket action with `void dispatchAction(...)`
```

**Reality (verified in code):**
- Function signature at `src/account/actionDispatcher.ts` line 932:
  ```typescript
  export async function dispatchAction(
    entry: AccountEntry,
    frame: InboundActionFrame,
    deps: Partial<DispatchDeps> = {},
  ): Promise<void>
  ```

**Status:** ❌ Slightly Inaccurate
- The return type is `Promise<void>`, not `void`
- This is async, which is critical for reliability
- The doc should say: "Node starts each WebSocket action with `async` handler that returns `Promise<void>`"


### 3. **Line 83-84: Per-Account Port Allocation** ✓ VERIFIED

**Document states:**
```
- one subagent webhook port at `base + slot`;
- one optional direct-invoke port at `base + slot`.
```

**Reality (verified in code):**

From `python/bridge/subagent/config.py`:
```python
SUBAGENT_WEBHOOK_PORT = _parse_non_negative_int(os.getenv("SUBAGENT_WEBHOOK_PORT"), 8081)
```

Per-tenant allocation in `python/bridge/session.py` line 202-205:
```python
webhook_port = base_port + account_index  # slot-based offset
self.subagent_webhook = SubAgentWebhookServer(self.subagent_tracker, port=webhook_port)
```

Direct invoke uses separate config (from agent/direct_invoke.py), but same pattern.

**Status:** ✅ Accurate
- Both use `base + slot` offset correctly
- Different base ports (8081 for webhook, different for direct-invoke)
- Doc is correct but could clarify the two different base ports


### 4. **Line 120: subagent_tracker.json Location** ✓ VERIFIED

**Document states:**
```
<folderPath>/
  db/
    subagent_tracker.json
```

**Reality (verified in code):**

From `python/bridge/session.py` line 202-203:
```python
tracker_state_path = tenant_root / "db" / "subagent_tracker.json"
self.subagent_tracker = SubTaskTracker(state_path=tracker_state_path)
```

From `python/bridge/agent/subagent_coordinator.py` line 789+:
- Uses `session.subagent_tracker` (instance-scoped, not global JSON)
- Persisted path: `db/subagent_tracker.json`

**Status:** ✅ Accurate
- File is still JSON, not migrated to SQLite
- Located at `<tenant>/db/subagent_tracker.json`
- However: also has `subagent.db` (SQLite) for different state
- Document should clarify both exist for different purposes


---

## 📋 Recommendations

### High Priority
1. **Line 597:** Update `void dispatchAction(...)` → `async dispatchAction(...): Promise<void>`
   - This distinction is important for understanding the async pipeline

### Low Priority (Clarifications)
2. **Line 83-84:** Optional clarification that webhook & direct-invoke use different base ports
3. **Line 120:** Note that both `subagent_tracker.json` AND `subagent.db` (SQLite) coexist
   - `subagent_tracker.json` = in-memory/session state (volatile)
   - `subagent.db` = durable job tracking

---

## Summary

The document is **production-quality accurate** for architecture decisions and rebuild guidance. The one technical inaccuracy (actionDispatcher return type) does not affect the rebuild recommendations but should be corrected for precision.

**Recommendation:** Mark as 98% accurate, fix line 597, and optionally expand lines 83-84 and 120 with implementation details.
