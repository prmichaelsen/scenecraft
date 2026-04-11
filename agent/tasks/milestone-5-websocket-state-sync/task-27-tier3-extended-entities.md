# Task 27: Tier 3 — Extended Entities (Markers, Effects, Tracks)

**Milestone**: [M5 - WebSocket State Sync](../../milestones/milestone-5-websocket-state-sync.md)  
**Design Reference**: [WebSocket State Sync](../../design/local.websocket-state-sync.md)  
**Estimated Time**: 4 hours  
**Status**: Not Started  
**Dependencies**: Task 26  

---

## Objective

Extend the WS `state_update` message to include markers, effects, suppressions, and tracks. Remove any remaining REST-based refresh patterns for non-timeline data.

---

## Steps

### 1. Extend `state_update` message format

Add optional arrays to the WS message:

```json
{
  "type": "state_update",
  "keyframes": [...],
  "transitions": [...],
  "deletedKeyframes": [...],
  "deletedTransitions": [...],
  "markers": [...],
  "deletedMarkers": [...],
  "effects": [...],
  "suppressions": [...],
  "tracks": [...]
}
```

### 2. Backend: Wire marker mutations

- `markers/add` → broadcast new marker
- `markers/update` → broadcast updated marker
- `markers/remove` → broadcast deleted marker ID

### 3. Backend: Wire track mutations

- `update-track` → broadcast updated track
- `add-track` → broadcast new track

### 4. Backend: Wire effect mutations (if applicable)

Effects/suppressions are currently persisted via `update-effects` which sends the full effects array. Consider whether delta updates make sense here or if the full array is small enough to keep as-is.

### 5. Frontend: Extend WS listener

Handle new entity types in the `state_update` handler:

```typescript
if (msg.markers?.length) {
  setMarkers((prev) => {
    const updated = [...prev]
    for (const m of msg.markers) {
      const idx = updated.findIndex((x) => x.id === m.id)
      if (idx >= 0) updated[idx] = m
      else updated.push(m)
    }
    return updated.filter((x) => !(msg.deletedMarkers ?? []).includes(x.id))
  })
}
```

### 6. Remove remaining REST refresh patterns

Search for any remaining places where marker/track/effect data is re-fetched via REST after mutations and replace with WS-based updates.

---

## Verification

- [ ] Marker add/update/delete reflected via WS delta
- [ ] Track updates reflected via WS delta
- [ ] No REST refetches for any entity type during normal editing
- [ ] All entity types update across multiple tabs
