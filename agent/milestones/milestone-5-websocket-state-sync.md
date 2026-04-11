# Milestone 5: WebSocket State Sync

**Goal**: Replace full-data REST polling with WebSocket-pushed delta updates, reducing network transfer from ~240 MB/hour to ~12 MB/hour during editing  
**Created**: 2026-04-11  
**Status**: Not Started  
**Estimated Duration**: 2-3 weeks  
**Design Reference**: [WebSocket State Sync](../design/local.websocket-state-sync.md)  

---

## Overview

The editor currently re-fetches ALL keyframes and transitions (~2.4 MB) via REST after every mutation. This milestone replaces that pattern with WebSocket-pushed deltas: the backend broadcasts only changed entities after each mutation, and the frontend patches normalized Map stores in-place.

## Deliverables

1. Backend `_broadcast_state_update()` helper wired into all mutation handlers
2. Frontend normalized `Map<id, entity>` stores replacing array state
3. WS `state_update` listener that patches local state
4. `refreshTimeline()` eliminated (replaced by WS subscription)
5. Reconnect fallback (full REST refresh on WS reconnect)
6. Extended entity support (markers, effects, suppressions, tracks)

## Success Criteria

- [ ] No `refreshTimeline()` calls remain in Timeline.tsx
- [ ] Network transfer during editing reduced by >90% (measured via DevTools)
- [ ] Multi-tab editing works (edits in one tab appear in another)
- [ ] WS reconnect triggers full refresh and recovers state
- [ ] All existing editing operations work identically (no regressions)

## Tasks

| Task | Name | Est. Hours | Status |
|------|------|------------|--------|
| task-25 | Tier 1: Core mutation broadcasts + Map refactor | 8 | Not Started |
| task-26 | Tier 2: All mutations + reconnect fallback | 6 | Not Started |
| task-27 | Tier 3: Extended entities (markers, effects, tracks) | 4 | Not Started |
