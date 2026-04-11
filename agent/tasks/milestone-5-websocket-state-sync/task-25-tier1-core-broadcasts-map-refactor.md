# Task 25: Tier 1 — Core Mutation Broadcasts + Map Refactor

**Milestone**: [M5 - WebSocket State Sync](../../milestones/milestone-5-websocket-state-sync.md)  
**Design Reference**: [WebSocket State Sync](../../design/local.websocket-state-sync.md)  
**Estimated Time**: 8 hours  
**Status**: Not Started  

---

## Objective

Wire WebSocket state broadcasts into the 5 most frequent mutation handlers and refactor the frontend from array-based state to normalized Map stores. This captures ~80% of the network savings.

---

## Steps

### 1. Backend: `_broadcast_state_update()` helper

In `api_server.py` (or `ws_server.py`), add:

```python
def _broadcast_state_update(project_dir, keyframe_ids=None, transition_ids=None,
                            deleted_kf_ids=None, deleted_tr_ids=None):
    msg = {"type": "state_update"}
    if keyframe_ids:
        msg["keyframes"] = [_serialize_keyframe(get_keyframe(project_dir, kid)) for kid in keyframe_ids if get_keyframe(project_dir, kid)]
    if transition_ids:
        msg["transitions"] = [_serialize_transition(get_transition(project_dir, tid)) for tid in transition_ids if get_transition(project_dir, tid)]
    if deleted_kf_ids:
        msg["deletedKeyframes"] = deleted_kf_ids
    if deleted_tr_ids:
        msg["deletedTransitions"] = deleted_tr_ids
    _broadcast(msg)
```

Need `_serialize_keyframe()` and `_serialize_transition()` helpers that produce the same JSON shape as the `/keyframes` GET endpoint. Extract from the existing GET handler.

### 2. Backend: Wire into 5 core mutations

Add `_broadcast_state_update()` calls at the end of:

1. **Move keyframe** (`update-keyframe-timestamp`) — broadcast the moved kf + its adjacent transitions
2. **Add keyframe** (`add-keyframe`) — broadcast the new kf + auto-created transitions
3. **Delete keyframe** (`delete-keyframe`) — broadcast deleted kf ID + affected transitions
4. **Update transition style** (`update-transition-style`) — broadcast the updated tr
5. **Select video candidate** (`select-transitions`) — broadcast the updated tr

### 3. Frontend: Normalized Map stores

In `Timeline.tsx`, replace:

```typescript
// Before:
const [localKeyframes, setLocalKeyframes] = useState(data.keyframes)
const [localTransitions, setLocalTransitions] = useState(data.transitions)

// After:
const [kfMap, setKfMap] = useState(() => new Map(data.keyframes.map((kf) => [kf.id, kf])))
const [trMap, setTrMap] = useState(() => new Map(data.transitions.map((tr) => [tr.id, tr])))
const keyframes = useMemo(() => [...kfMap.values()].sort((a, b) => a.timeSeconds - b.timeSeconds), [kfMap])
const localTransitions = useMemo(() => [...trMap.values()], [trMap])
```

Update all `setLocalKeyframes`/`setLocalTransitions` call sites to use `setKfMap`/`setTrMap`.

### 4. Frontend: WS `state_update` listener

Add a `useEffect` that subscribes to WS messages:

```typescript
useEffect(() => {
  return subscribeAll((msg) => {
    if (msg.type !== 'state_update') return
    if (msg.keyframes?.length) {
      setKfMap((prev) => {
        const next = new Map(prev)
        for (const kf of msg.keyframes) {
          const withTime = { ...kf, timeSeconds: timestampToSeconds(kf.timestamp) }
          const old = next.get(kf.id)
          if (old && old.selected !== kf.selected) invalidateEntry(`kf:${kf.id}`)
          next.set(kf.id, withTime)
        }
        return next
      })
    }
    if (msg.transitions?.length) {
      setTrMap((prev) => {
        const next = new Map(prev)
        for (const tr of msg.transitions) next.set(tr.id, tr)
        return next
      })
    }
    for (const id of msg.deletedKeyframes ?? []) {
      setKfMap((prev) => { const next = new Map(prev); next.delete(id); return next })
    }
    for (const id of msg.deletedTransitions ?? []) {
      setTrMap((prev) => { const next = new Map(prev); next.delete(id); return next })
    }
  })
}, [subscribeAll])
```

### 5. Frontend: Remove `refreshTimeline()` from 5 handlers

Remove the `refreshTimeline()` call from each of the 5 mutation handlers. The WS listener handles state updates.

### 6. Frontend: Add `state_update` to WS message type

In `useBeatlabSocket.ts`, add `state_update` to the `JobMessage` union type.

---

## Verification

- [ ] Move keyframe → no REST refresh, state updates via WS
- [ ] Add keyframe → new kf appears via WS delta
- [ ] Delete keyframe → kf removed via WS delta
- [ ] Update transition style → tr updates via WS delta
- [ ] Select video → tr updates via WS delta
- [ ] Frame cache invalidated on selected variant change
- [ ] Network tab shows no `/keyframes` fetch after the 5 mutations
- [ ] Multiple tabs both receive updates
