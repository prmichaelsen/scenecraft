# WebSocket State Sync

**Concept**: Replace full-data REST polling with WebSocket-pushed delta updates after mutations, reducing network transfer from ~240 MB/hour to ~5 MB/hour during editing  
**Created**: 2026-04-11  
**Status**: Design Specification  

---

## Overview

The editor currently re-fetches ALL keyframes and transitions (~2.4 MB) via REST after every mutation (add/delete/move keyframe, update transition style, select video, etc.). With ~100 edits per hour, this creates ~240 MB of redundant data transfer. This design replaces that pattern with WebSocket-pushed deltas: the backend broadcasts only the changed entities after each mutation, and the frontend patches local state in-place.

---

## Problem Statement

- `refreshTimeline()` fetches the full `/keyframes` endpoint (~2.4 MB for 1000 kfs + 500 trs) after every edit
- Called from ~25 code paths in Timeline.tsx
- A single keyframe move triggers a 2.4 MB download to update one field on one object
- Heavy editing sessions produce ~240 MB/hour of redundant network traffic
- `fetchMeta()` also fetches the entire keyframes endpoint just to read 4 meta fields

---

## Solution

**REST for writes + initial load. WebSocket for state subscriptions.**

### Architecture

```
┌─────────────┐     REST POST (mutation)      ┌──────────────┐
│   Frontend   │ ──────────────────────────── │    Backend    │
│              │                               │              │
│  Map<id, kf> │ ◄──── WS: state_update ───── │  SQLite DB   │
│  Map<id, tr> │     (changed entities only)   │              │
└─────────────┘                               └──────────────┘
       │                                              │
       │ On reconnect: full REST refresh              │
       └──────────────────────────────────────────────┘
```

### Flow

1. Frontend sends REST mutation (e.g., `POST /add-keyframe`)
2. Backend executes mutation against SQLite
3. Backend queries affected entities from DB
4. Backend broadcasts `state_update` via WebSocket to ALL connected clients
5. Frontend receives delta, patches normalized Map stores
6. `refreshTimeline()` is eliminated

### What Stays on REST

- Initial page load (`getEditorData`) — full data fetch
- Reconnect after WS disconnect — full refresh to catch up
- File operations (upload, video generation kickoff)
- Commands that don't affect timeline state (checkpoint, export, etc.)

---

## Implementation

### WS Message Format

```json
{
  "type": "state_update",
  "keyframes": [
    { "id": "kf_123", "timestamp": "28:35.7", "prompt": "...", ... }
  ],
  "transitions": [
    { "id": "tr_456", "from": "kf_123", "to": "kf_789", ... }
  ],
  "deletedKeyframes": ["kf_999"],
  "deletedTransitions": ["tr_888"]
}
```

- **Full objects** (not partial patches) — simple, correct, ~1-2.5 KB per entity
- **Separate arrays** per entity type — mirrors frontend state structure
- **Delete arrays** — list of IDs to remove from local stores
- **No version/sequence tracking** — server-authoritative, last-write-wins

### Backend: Broadcast Helper

```python
# ws_server.py or api_server.py

def _broadcast_state_update(project_dir, keyframe_ids=None, transition_ids=None,
                            deleted_kf_ids=None, deleted_tr_ids=None):
    """Broadcast changed entities to all WS clients."""
    msg = {"type": "state_update"}
    
    if keyframe_ids:
        kfs = [_serialize_keyframe(get_keyframe(project_dir, kid)) for kid in keyframe_ids]
        msg["keyframes"] = kfs
    
    if transition_ids:
        trs = [_serialize_transition(get_transition(project_dir, tid)) for tid in transition_ids]
        msg["transitions"] = trs
    
    if deleted_kf_ids:
        msg["deletedKeyframes"] = deleted_kf_ids
    
    if deleted_tr_ids:
        msg["deletedTransitions"] = deleted_tr_ids
    
    _broadcast(msg)
```

Wire into every mutation handler in `api_server.py`:

```python
# Example: add-keyframe handler
kf_id = add_keyframe(project_dir, ...)
# Auto-created transitions
new_tr_ids = [tr["id"] for tr in get_transitions_for_keyframe(project_dir, kf_id)]
_broadcast_state_update(project_dir, keyframe_ids=[kf_id], transition_ids=new_tr_ids)
```

### Frontend: Normalized Map Store

Replace array-based state with Maps:

```typescript
// Before:
const [localKeyframes, setLocalKeyframes] = useState<KeyframeWithTime[]>(data.keyframes)
const [localTransitions, setLocalTransitions] = useState<Transition[]>(data.transitions)

// After:
const [kfMap, setKfMap] = useState<Map<string, KeyframeWithTime>>(() =>
  new Map(data.keyframes.map((kf) => [kf.id, kf]))
)
const [trMap, setTrMap] = useState<Map<string, Transition>>(() =>
  new Map(data.transitions.map((tr) => [tr.id, tr]))
)

// Derived sorted arrays (used by all existing rendering code):
const keyframes = useMemo(
  () => [...kfMap.values()].sort((a, b) => a.timeSeconds - b.timeSeconds),
  [kfMap]
)
const localTransitions = useMemo(
  () => [...trMap.values()],
  [trMap]
)
```

### Frontend: WS Subscription

```typescript
// In Timeline.tsx, replace refreshTimeline with WS listener:
useEffect(() => {
  return subscribeAll((msg) => {
    if (msg.type !== 'state_update') return
    const update = msg as StateUpdateMessage

    if (update.keyframes?.length) {
      setKfMap((prev) => {
        const next = new Map(prev)
        for (const kf of update.keyframes) {
          const withTime = { ...kf, timeSeconds: timestampToSeconds(kf.timestamp) }
          // Invalidate frame cache if selected variant changed
          const old = next.get(kf.id)
          if (old && old.selected !== kf.selected) invalidateEntry(`kf:${kf.id}`)
          next.set(kf.id, withTime)
        }
        return next
      })
    }

    if (update.transitions?.length) {
      setTrMap((prev) => {
        const next = new Map(prev)
        for (const tr of update.transitions) next.set(tr.id, tr)
        return next
      })
    }

    for (const id of update.deletedKeyframes ?? []) {
      setKfMap((prev) => { const next = new Map(prev); next.delete(id); return next })
    }
    for (const id of update.deletedTransitions ?? []) {
      setTrMap((prev) => { const next = new Map(prev); next.delete(id); return next })
    }
  })
}, [subscribeAll])
```

### Frontend: Reconnect Fallback

```typescript
// On WS reconnect, do one full REST refresh to catch up:
useEffect(() => {
  return subscribeAll((msg) => {
    if (msg.type === 'connected') {
      getTimelineData({ data: { name: data.projectName } }).then((tl) => {
        setKfMap(new Map(tl.keyframes.map((kf) => [kf.id, kf])))
        setTrMap(new Map(tl.transitions.map((tr) => [tr.id, tr])))
      })
    }
  })
}, [subscribeAll, data.projectName])
```

### Multi-Tab Support

Free — the backend broadcasts to ALL connected WS clients. Both tabs receive the same `state_update` and patch their local state independently.

---

## Tiered Rollout

### Tier 1: Core Mutations (highest impact)

**Backend:**
- Add `_broadcast_state_update()` helper
- Wire into: move kf, add kf, delete kf, update tr style, select video

**Frontend:**
- Refactor `localKeyframes`/`localTransitions` to normalized Maps
- Add WS `state_update` listener with patch logic
- Remove `refreshTimeline()` from the 5 wired mutation handlers

**Estimated savings:** ~80% of current traffic

### Tier 2: All Mutations

**Backend:**
- Wire broadcast into: delete tr, paste group, undo/redo, batch delete, unlink kf, split tr, drag-drop, assign image, duplicate kf, restore kf/tr

**Frontend:**
- Remove ALL remaining `refreshTimeline()` calls
- Add WS reconnect → full REST refresh fallback

**Estimated savings:** ~95%+ (only initial load + reconnect use REST)

### Tier 3: Extended Entities

- Extend `state_update` to include markers, effects, suppressions, tracks
- Dedicated `state_update` sub-types or additional arrays in the message
- Remove any remaining REST-based refresh patterns for non-timeline data

---

## Benefits

- **~95% reduction** in network transfer during editing (~240 MB/hr → ~12 MB/hr)
- **Lower latency** — state updates arrive immediately after mutation (no round-trip poll)
- **Multi-tab sync** for free — all clients receive broadcasts
- **Eliminates `refreshTimeline()`** — the 25+ call sites are replaced by one WS listener
- **O(1) patching** with normalized Map stores

---

## Trade-offs

- **Backend complexity** — every mutation handler needs a broadcast call (mitigated: one helper function, mechanical additions)
- **WS reliability** — if WS disconnects mid-edit, state could be stale until reconnect refresh (mitigated: reconnect + full refresh fallback)
- **Map refactor** — ~20 call sites change from array setters to Map setters (mitigated: derived arrays make downstream code unchanged)
- **No conflict detection** — two tabs editing the same entity overwrite each other silently (acceptable: single-user tool, last-write-wins)

---

## Dependencies

- Existing WS infrastructure (`ws_server.py` with `_broadcast()`, `useBeatlabSocket` hook)
- Existing entity serialization in `api_server.py` (keyframe/transition JSON format)
- `getTimelineData` SSR function (kept for initial load + reconnect)

---

## Testing Strategy

- Verify each Tier 1 mutation handler broadcasts correct entities
- Verify frontend patches Map correctly (add, update, delete)
- Verify derived arrays (`keyframes`, `localTransitions`) update after Map patch
- Verify frame cache invalidation on selected variant change via delta
- Verify reconnect triggers full REST refresh
- Verify multi-tab: edit in tab A, confirm tab B receives delta
- Measure network traffic before/after (Chrome DevTools Network tab)

---

## Key Design Decisions

### Architecture

| Decision | Choice | Rationale |
|---|---|---|
| State sync channel | WS push (not REST poll) | Eliminates 2.4 MB refetch per edit, real-time delivery |
| Mutation channel | REST POST (unchanged) | Commands are request/response, not subscriptions |
| Initial load | REST (unchanged) | SSR requires server-side fetch |
| Reconnect | Full REST refresh | Catch up on missed WS messages simply |

### Data Format

| Decision | Choice | Rationale |
|---|---|---|
| Delta granularity | Full objects (not partial patches) | Simple, 1-2.5 KB per entity, avoids property-level diffing |
| Payload structure | Separate arrays per entity type | Mirrors frontend state, type-safe, no switch-on-type |
| Delete representation | ID arrays (`deletedKeyframes`, `deletedTransitions`) | Lightweight, unambiguous |
| Version tracking | None (MVP) | Single-user, server-authoritative, messages arrive in order |

### Frontend State

| Decision | Choice | Rationale |
|---|---|---|
| State shape | Normalized `Map<id, entity>` | O(1) patching, derived sorted arrays via useMemo |
| Conflict detection | None | Single-user tool, last-write-wins acceptable |
| Multi-tab | Free via WS broadcast to all clients | No extra lift needed |

### Rollout

| Decision | Choice | Rationale |
|---|---|---|
| Approach | Tiered (3 tiers) | Huge refactor, each tier independently shippable |
| Tier 1 scope | 5 most frequent mutations + Map refactor | Captures ~80% of savings with smallest scope |

---

## Future Considerations

- **Sequence numbers**: add monotonic seq for duplicate/reorder protection if multi-user
- **Partial patches**: property-level diffs for very large entities (unlikely needed)
- **Presence**: extend WS to show cursor position of other editors
- **Offline support**: queue mutations locally, replay on reconnect
- **Compression**: gzip WS frames for large paste-group broadcasts

---

**Status**: Design Specification  
**Recommendation**: Create task documents for Tier 1 implementation — backend broadcast helper + frontend Map refactor + WS listener  
**Related Documents**: [Clarification 5](../clarifications/clarification-5-delta-timeline-updates.md)  
