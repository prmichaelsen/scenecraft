# Task 26: Tier 2 — All Mutations + Reconnect Fallback

**Milestone**: [M5 - WebSocket State Sync](../../milestones/milestone-5-websocket-state-sync.md)  
**Design Reference**: [WebSocket State Sync](../../design/local.websocket-state-sync.md)  
**Estimated Time**: 6 hours  
**Status**: Not Started  
**Dependencies**: Task 25  

---

## Objective

Wire `_broadcast_state_update()` into ALL remaining mutation handlers in `api_server.py` and remove ALL remaining `refreshTimeline()` calls from the frontend. Add WS reconnect → full REST refresh fallback.

---

## Steps

### 1. Backend: Wire remaining mutation handlers

Add `_broadcast_state_update()` to every handler that modifies keyframes or transitions:

- `delete-transition` → deleted tr ID
- `paste-group` → all new kfs + trs
- `undo` / `redo` → all affected kfs + trs (query from undo log)
- `batch-delete-keyframes` → deleted kf IDs + affected trs
- `unlink-keyframe` → deleted tr IDs
- `split-transition` → new kf + new trs + modified original tr
- `duplicate-keyframe` → new kf + new trs
- `restore-keyframe` / `restore-transition` → restored entities
- `assign-keyframe-image` → updated kf
- `assign-pool-video` → updated tr
- `update-keyframe-prompt` → updated kf
- `update-keyframe-label` → updated kf
- `drag-drop-keyframe` → updated kf + affected trs
- `copy-transition-style` → updated target tr

### 2. Frontend: Remove ALL `refreshTimeline()` calls

Search for every remaining `refreshTimeline()` call in Timeline.tsx and remove it. The WS `state_update` listener (from Task 25) handles all state updates.

Keep `refreshTimeline` as a function but rename to `fullRefresh` — used only for reconnect.

### 3. Frontend: WS reconnect fallback

When the WebSocket reconnects after a disconnect, do one full REST refresh:

```typescript
useEffect(() => {
  return subscribeAll((msg) => {
    if (msg.type === 'connected') {
      // Reconnected — full refresh to catch up on missed deltas
      fullRefresh()
    }
  })
}, [subscribeAll, fullRefresh])
```

### 4. Backend: Undo/redo broadcast

The undo system executes inverse SQL operations. After `undo_execute()`, query the affected entity IDs from the undo log and broadcast them:

```python
affected = undo_execute(project_dir)  # returns list of (table, id, operation)
kf_ids = [id for table, id, op in affected if table == 'keyframes']
tr_ids = [id for table, id, op in affected if table == 'transitions']
deleted_kf = [id for table, id, op in affected if table == 'keyframes' and op == 'DELETE']
deleted_tr = [id for table, id, op in affected if table == 'transitions' and op == 'DELETE']
_broadcast_state_update(project_dir, kf_ids, tr_ids, deleted_kf, deleted_tr)
```

---

## Verification

- [ ] Every mutation handler has a broadcast call
- [ ] Zero `refreshTimeline()` calls remain (grep confirms)
- [ ] WS disconnect + reconnect triggers full refresh and recovers state
- [ ] Undo/redo updates state via WS delta
- [ ] Paste-group sends all new entities in one WS message
- [ ] Batch delete sends all deleted IDs in one WS message
- [ ] Network tab shows zero `/keyframes` fetches during normal editing
