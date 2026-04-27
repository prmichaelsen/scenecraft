# Spec: Editor State Context & Selection Mutex

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Retroactive — describes current behavior as of commit `392960b`

---

## Purpose

Define the exact observable behavior of `EditorStateContext` — the React context that coordinates the editor's single-selection invariant (the "selection mutex") across five mutually exclusive entity types and exposes panel-level action callbacks (delete / data-change) to property panels.

## Source

Retroactive black-box spec derived from:
- `src/components/editor/EditorStateContext.tsx` (full read)
- Consumer usage in `src/components/editor/EditorPanelLayout.tsx` (esp. `AutoActivatePropertiesEffect`)
- Consumer scan in `src/components/editor/KeyframePanel.tsx`, `src/components/editor/TransitionPanel.tsx`
- `agent/reports/audit-2-architectural-deep-dive.md` §1D unit 9, §2 "Selection Mutex" invariant

## Scope

### In scope
- The shape of `useEditorState()` — fields, setters, callback slots
- The **selection mutex**: only one of `selectedKeyframe` / `selectedTransition` / `trackPropertiesId` / `selectedAudioClipId` / `selectedAudioTrackId` may be non-null at a time
- Setter semantics: setting one non-null entity clears all others; setting `null` is a no-op for the other four
- `registerCallbacks` semantics: last-call-wins replacement of the callback bundle
- Default values exposed when no `EditorStateProvider` is mounted
- Auto-activation side effect consumed by `AutoActivatePropertiesEffect` (out-of-context observable behavior)

### Out of scope
- `CurrentTimeContext` (playhead / `isPlaying` / `seekRef`) — separate context, separate spec
- `EditorDataContext` (project data: keyframes, transitions, tracks, clips) — separate spec
- `JobStateContext`, `PreviewContext`, `ContextMenuProvider` — separate specs
- Panel-local selection state (e.g. `KeyframePanel.selectedIdx`, `TransitionPanel.selectedSegId`) — these are variant/segment pickers scoped inside a panel, not part of the cross-panel mutex
- Multi-select (shift/cmd selection across keyframes/transitions/etc.) — **not implemented**; see R-7
- Persistence of selection across page reload — not implemented
- Undo/redo of selection changes — not implemented

---

## Requirements

1. **R1**. `useEditorState()` returns an object containing five selection fields, five setters, four callback slots, and a `registerCallbacks` function (exact shape below).
2. **R2**. At most one of the five selection fields is non-null at any time observable between renders (selection mutex).
3. **R3**. Calling `setSelectedKeyframe(kf)` with a non-null `kf` sets `selectedKeyframe=kf` and clears `selectedTransition`, `trackPropertiesId`, `selectedAudioClipId`, `selectedAudioTrackId` to `null`.
4. **R4**. Calling `setSelectedTransition(tr)` with a non-null `tr` sets `selectedTransition=tr` and clears the other four.
5. **R5**. Calling `setTrackPropertiesId(id)` with a non-null `id` sets `trackPropertiesId=id` and clears the other four.
6. **R6**. Calling `setSelectedAudioClipId(id)` with a non-null `id` sets `selectedAudioClipId=id` and clears the other four.
7. **R7**. Calling `setSelectedAudioTrackId(id)` with a non-null `id` sets `selectedAudioTrackId=id` and clears the other four.
8. **R8**. Calling any setter with `null` sets only that field to `null` and does NOT mutate the other four fields.
9. **R9**. No multi-select state is exposed. There is no `selectedKeyframes: KeyframeWithTime[]`, no shift/cmd selection array, no anchor-based range selection. The context holds one scalar per entity type.
10. **R10**. `registerCallbacks(cbs)` replaces the entire callback bundle: after the call, `onKeyframeDelete`, `onKeyframeDataChange`, `onTransitionDelete`, `onTransitionDataChange` each resolve to `cbs.onKeyframeDelete ?? null`, etc. Keys omitted from `cbs` become `null` (NOT preserved from the prior bundle).
11. **R11**. When no `EditorStateProvider` is mounted above a consumer, `useEditorState()` returns the default value: all five selection fields `null`, all four callback slots `null`, all setters are no-ops, `registerCallbacks` is a no-op. No exception is thrown.
12. **R12**. The returned setters (`setSelectedKeyframe`, etc.) and `registerCallbacks` are stable references across renders of the provider (wrapped in `useCallback` with empty deps) and safe to include in effect dependency arrays without causing loops.
13. **R13**. The context does NOT hold, expose, or mutate: playhead time, `isPlaying`, project data, job state, preview URL, or context-menu visibility. Those live in sibling contexts.
14. **R14**. Entity payload types: `selectedKeyframe` is `KeyframeWithTime | null` (a `Keyframe` plus a derived numeric `timeSeconds`); `selectedTransition` is `Transition | null`; the three id fields are `string | null`. No integrity check is performed against `EditorDataContext` — a stale or foreign id is accepted verbatim (see R-15, OQ-2, OQ-3).
15. **R15**. `null` is the canonical "cleared" sentinel. Setters normalize `undefined` → `null` at entry (per OQ-5 resolution), so the mutex clear path fires correctly for both. Other falsy values are still out-of-contract for setters.
16. **R16 (new, OQ-2)**. The provider subscribes to `EditorDataContext` and auto-clears any selection slot whose underlying entity has been soft-deleted (`deleted_at` set) or is missing from the current data set. The clear writes `null` to that slot only; other slots are untouched.
17. **R17 (new, OQ-3)**. The provider resets ALL five selection slots to `null` when the project id changes. Wiring is either `<EditorStateProvider key={projectId}>` (remount) or an internal effect watching project id. Callbacks bundle is also reset to `{}`.
18. **R18 (new, OQ-4)**. `registerCallbacks` has no unmount detection. Callers MUST pair registration with cleanup inside the same effect (return-cleanup that calls `registerCallbacks({})` or a matching reset). The provider does NOT guard against orphaned callback references.
19. **R19 (new, OQ-6)**. The context `value` is wrapped in `useMemo` keyed on the five selection fields + the callback bundle. Consumers that read only unchanged fields do not re-render.

---

## Interfaces / Data Shapes

### TypeScript shape

```ts
export type KeyframeWithTime = Keyframe & { timeSeconds: number }

type EditorStateContextValue = {
  // Selection fields (mutex — at most one non-null)
  selectedKeyframe:      KeyframeWithTime | null
  selectedTransition:    Transition       | null
  trackPropertiesId:     string           | null
  selectedAudioClipId:   string           | null
  selectedAudioTrackId:  string           | null

  // Setters (each clears the other four when called with non-null)
  setSelectedKeyframe:     (kf: KeyframeWithTime | null) => void
  setSelectedTransition:   (tr: Transition       | null) => void
  setTrackPropertiesId:    (id: string           | null) => void
  setSelectedAudioClipId:  (id: string           | null) => void
  setSelectedAudioTrackId: (id: string           | null) => void

  // Callback slots — set by Timeline, read by property panels
  onKeyframeDelete:       (() => void) | null
  onKeyframeDataChange:   (() => void) | null
  onTransitionDelete:     (() => void) | null
  onTransitionDataChange: (() => void) | null

  // Bulk callback replacement (last-write-wins over the whole bundle)
  registerCallbacks: (cbs: {
    onKeyframeDelete?:       () => void
    onKeyframeDataChange?:   () => void
    onTransitionDelete?:     () => void
    onTransitionDataChange?: () => void
  }) => void
}
```

### Provider

```tsx
<EditorStateProvider>
  {/* tree */}
</EditorStateProvider>
```

- Holds five `useState<T | null>(null)` slots and one `useState<CallbackBundle>({})`.
- Setters are wrapped in `useCallback` with empty deps — stable across renders.
- No props, no imperative handle.

### Consumer hook

```ts
const state = useEditorState()
```

- Subscribes the consumer to re-render when any of the five selections or the callback bundle changes.
- Safe to call outside a provider (returns the default value; see R11).

### Mutex clearing matrix

Every setter, when called with a non-null argument, performs this clear pattern:

| Setter call (non-null)              | `selectedKeyframe` | `selectedTransition` | `trackPropertiesId` | `selectedAudioClipId` | `selectedAudioTrackId` |
|-------------------------------------|:---:|:---:|:---:|:---:|:---:|
| `setSelectedKeyframe(kf)`           | kf   | null | null | null | null |
| `setSelectedTransition(tr)`         | null | tr   | null | null | null |
| `setTrackPropertiesId(id)`          | null | null | id   | null | null |
| `setSelectedAudioClipId(id)`        | null | null | null | id   | null |
| `setSelectedAudioTrackId(id)`       | null | null | null | null | id   |
| any setter called with `null`       | *unchanged except that slot → null* |

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | Initial mount under provider | All five selections null; callback slots null; setters + `registerCallbacks` are defined functions | `initial-state-all-null` |
| 2 | Select a keyframe | `selectedKeyframe` becomes the keyframe; other four cleared | `select-keyframe-clears-others` |
| 3 | Select a transition | `selectedTransition` set; other four cleared | `select-transition-clears-others` |
| 4 | Set track properties id | `trackPropertiesId` set; other four cleared | `select-track-clears-others` |
| 5 | Select audio clip | `selectedAudioClipId` set; other four cleared | `select-audio-clip-clears-others` |
| 6 | Select audio track | `selectedAudioTrackId` set; other four cleared | `select-audio-track-clears-others` |
| 7 | Switch selection A → B (kf then tr) | After second call only transition is set | `switch-keyframe-to-transition` |
| 8 | Clear by passing null | Only that slot becomes null; others untouched | `set-null-does-not-clear-others` |
| 9 | Clear when nothing selected | No change; no error | `set-null-from-empty-is-noop` |
| 10 | `registerCallbacks({onKeyframeDelete})` | `onKeyframeDelete` slot resolves to the fn; other three callback slots null | `register-callbacks-partial-bundle` |
| 11 | `registerCallbacks({})` after partial bundle | All four callback slots become null (bundle is replaced, not merged) | `register-callbacks-replaces-bundle` |
| 12 | Consumer calls `useEditorState()` with no provider | Returns default: all null, no-op setters, no throw | `no-provider-returns-default` |
| 13 | `AutoActivatePropertiesEffect` observes any non-null selection | Calls `panelLayoutRef.current?.activatePanel('properties')` exactly once per transition to a selected state (effect dep array) | `auto-activate-on-any-selection` |
| 14 | All selections are null | `AutoActivatePropertiesEffect` does NOT call `activatePanel` | `auto-activate-skipped-when-empty` |
| 15 | Setter identity across renders | `setSelectedKeyframe` has referential equality across re-renders of the provider | `setters-are-stable-refs` |
| 16 | Two different setters called in the same render tick | Both `setState` calls are batched by React; final observable state has exactly the field from the **last** setter invocation set, all others null | `last-setter-in-tick-wins` |
| 17 | Same setter called twice in same tick with different values | Final observable state has the later value; the mutex still holds | `same-setter-twice-last-value-wins` |
| 18 | Selecting an entity that has been deleted from `EditorDataContext` | Provider subscribes to `EditorDataContext`; when selected entity has `deleted_at` set or is missing, the matching slot auto-clears to `null` | `selection-auto-clears-on-delete` |
| 19 | Selecting an entity from a different project | Provider resets all selection slots to `null` on project-id change (via `key={projectId}` remount or internal effect) | `selection-resets-on-project-change` |
| 20 | `registerCallbacks` invoked during component unmount (effect cleanup) | Contract: callers MUST pair registration with cleanup in the same effect; provider does NOT detect orphaned bundles | `register-callbacks-cleanup-is-caller-responsibility` |
| 21 | Setter called with `undefined` (violates TS type) | Normalized to `null` at setter entry; mutex clear triggers correctly | `setter-with-undefined-normalized-to-null` |
| 22 | Shift/cmd multi-select of keyframes | **Deferred** — single-select is current product shape; multi-select would require mutex refactor | → [OQ-1](#open-questions) |
| 23 | Consumer outside provider calls a setter | No-op (default setter is `() => {}`); state in any real provider elsewhere is unaffected | `no-provider-setter-is-noop` |
| 24 | Context exposes playhead time / data / jobs | Does NOT — those live in sibling contexts; `useEditorState()` has no such fields | `does-not-expose-foreign-state` |
| 25 | Re-render of provider with unchanged selection | Consumers do NOT re-render if their read slice is unchanged; context `value` is wrapped in `useMemo` keyed on the five selections + callback bundle | `value-identity-stable-via-memo` |

---

## Behavior

### Selection update flow (example: keyframe)

1. Consumer calls `setSelectedKeyframe(kf)`.
2. Provider calls `setSelectedKeyframeRaw(kf)` — React schedules a state update.
3. If `kf` is truthy, provider additionally calls `setSelectedTransitionRaw(null)`, `setTrackPropertiesIdRaw(null)`, `setSelectedAudioClipIdRaw(null)`, `setSelectedAudioTrackIdRaw(null)` (via the `clearAudioSelection` helper for the two audio fields).
4. React batches the five `setState` calls into one render.
5. On the next render, the context value literal is rebuilt with the new selection; consumers re-render.
6. `AutoActivatePropertiesEffect` observes the changed deps and calls `panelLayoutRef.current?.activatePanel('properties')`.

### Callback registration flow

1. `Timeline` (or another owner) calls `registerCallbacks({onKeyframeDelete, onKeyframeDataChange, onTransitionDelete, onTransitionDataChange})` inside an effect.
2. Provider calls `setCallbacks(cbs)` — the **entire** bundle is replaced (no merge).
3. On next render, context value exposes `cbs.onKeyframeDelete || null` etc. for each slot.
4. Property panels read the four slots and wire them to UI buttons.

### Default (no provider) flow

1. Consumer component is rendered without `<EditorStateProvider>` as an ancestor.
2. `useContext(EditorStateContext)` returns the default object literal from `createContext`.
3. All selection fields are `null`; setters are `() => {}`; `registerCallbacks` is `() => {}`; callback slots are `null`.
4. Calling any setter does nothing and does not throw.

---

## Acceptance Criteria

- [ ] `useEditorState()` returns exactly the 14 keys listed in the TypeScript shape (5 selections + 5 setters + 4 callback slots = 14, plus `registerCallbacks` = 15 keys total).
- [ ] All 16 base-case tests pass.
- [ ] All edge-case tests either pass or are marked `undefined` in this spec with a linked Open Question.
- [ ] The five mutex-clearing matrix rows are individually covered by tests 2–6.
- [ ] A render-time snapshot after any `setSelectedX(nonNull)` call has exactly one non-null selection field.
- [ ] `AutoActivatePropertiesEffect` calls `activatePanel('properties')` iff at least one of the five selection fields is truthy.
- [ ] No test asserts behavior for playhead, `isPlaying`, project data, job state, preview, or context-menu — those are out of scope.
- [ ] Consumer outside provider does not throw.

---

## Tests

### Base Cases

#### Test: `initial-state-all-null` (covers R1, R14)

**Given**: a fresh `<EditorStateProvider>` mounted with a single consumer.
**When**: the consumer reads `useEditorState()` on first render.
**Then** (assertions):
- **kf-null**: `selectedKeyframe === null`.
- **tr-null**: `selectedTransition === null`.
- **track-null**: `trackPropertiesId === null`.
- **clip-null**: `selectedAudioClipId === null`.
- **audio-track-null**: `selectedAudioTrackId === null`.
- **cb-slots-null**: all four `on*` callback slots are `null`.
- **setters-fns**: all five setters + `registerCallbacks` are functions.

#### Test: `select-keyframe-clears-others` (covers R2, R3)

**Given**: a provider in the initial state.
**When**: consumer calls `setSelectedKeyframe(kf)` with a non-null `KeyframeWithTime`.
**Then**:
- **kf-set**: `selectedKeyframe === kf` after commit.
- **tr-cleared**: `selectedTransition === null`.
- **track-cleared**: `trackPropertiesId === null`.
- **clip-cleared**: `selectedAudioClipId === null`.
- **audio-track-cleared**: `selectedAudioTrackId === null`.

#### Test: `select-transition-clears-others` (covers R2, R4)

**Given**: a provider with some other selection already active (e.g., a keyframe).
**When**: consumer calls `setSelectedTransition(tr)`.
**Then**:
- **tr-set**: `selectedTransition === tr`.
- **others-cleared**: the other four selection fields are `null`.

#### Test: `select-track-clears-others` (covers R2, R5)

**Given**: provider with an audio clip selected.
**When**: `setTrackPropertiesId('track-42')` is called.
**Then**:
- **track-set**: `trackPropertiesId === 'track-42'`.
- **others-cleared**: the other four are `null`.

#### Test: `select-audio-clip-clears-others` (covers R2, R6)

**Given**: provider with a transition selected.
**When**: `setSelectedAudioClipId('clip-7')` is called.
**Then**:
- **clip-set**: `selectedAudioClipId === 'clip-7'`.
- **others-cleared**: the other four are `null`.

#### Test: `select-audio-track-clears-others` (covers R2, R7)

**Given**: provider with an audio clip selected.
**When**: `setSelectedAudioTrackId('at-1')` is called.
**Then**:
- **audio-track-set**: `selectedAudioTrackId === 'at-1'`.
- **clip-cleared**: `selectedAudioClipId === null`.
- **kf-cleared**, **tr-cleared**, **track-cleared**: all `null`.

#### Test: `switch-keyframe-to-transition` (covers R2, R3, R4)

**Given**: provider starts with `selectedKeyframe` set.
**When**: in a later render, `setSelectedTransition(tr)` is called.
**Then**:
- **only-tr-set**: exactly one selection is non-null (the transition).
- **kf-now-null**: `selectedKeyframe === null`.

#### Test: `set-null-does-not-clear-others` (covers R8)

**Given**: provider with `selectedTransition` set to a non-null value.
**When**: `setSelectedKeyframe(null)` is called.
**Then**:
- **tr-preserved**: `selectedTransition` is unchanged and still non-null.
- **kf-still-null**: `selectedKeyframe` remains `null`.
- **negative-no-wipe**: the other three selection fields are NOT reset by the null call.

#### Test: `set-null-from-empty-is-noop` (covers R8)

**Given**: provider in its initial all-null state.
**When**: `setSelectedAudioClipId(null)` is called.
**Then**:
- **still-all-null**: every selection field is `null`.
- **no-throw**: the call returns normally.

#### Test: `register-callbacks-partial-bundle` (covers R10)

**Given**: fresh provider.
**When**: `registerCallbacks({ onKeyframeDelete: fnA, onTransitionDelete: fnB })`.
**Then**:
- **kf-delete-wired**: `onKeyframeDelete === fnA`.
- **tr-delete-wired**: `onTransitionDelete === fnB`.
- **kf-change-null**: `onKeyframeDataChange === null`.
- **tr-change-null**: `onTransitionDataChange === null`.

#### Test: `register-callbacks-replaces-bundle` (covers R10)

**Given**: provider that has previously been called with `registerCallbacks({onKeyframeDelete: fnA, onKeyframeDataChange: fnB})`.
**When**: `registerCallbacks({})` is called next.
**Then**:
- **kf-delete-cleared**: `onKeyframeDelete === null`.
- **kf-change-cleared**: `onKeyframeDataChange === null`.
- **negative-no-merge**: previously registered callbacks do NOT survive — the empty bundle replaced them wholesale.

#### Test: `no-provider-returns-default` (covers R11)

**Given**: a component rendered with NO `<EditorStateProvider>` ancestor.
**When**: the component calls `useEditorState()`.
**Then**:
- **no-throw**: rendering completes without error.
- **all-null-defaults**: all five selections and all four callback slots are `null`.
- **setters-are-fns**: all five setters and `registerCallbacks` are functions (from the default-value object passed to `createContext`).

#### Test: `no-provider-setter-is-noop` (covers R11)

**Given**: consumer outside any provider.
**When**: consumer calls `setSelectedKeyframe(kf)` where `kf` is a valid object.
**Then**:
- **no-throw**: returns normally.
- **no-state-change**: on next render, `selectedKeyframe` is still `null` (default setter is `() => {}`).

#### Test: `auto-activate-on-any-selection` (covers R1, plus `AutoActivatePropertiesEffect` contract)

**Given**: an `<EditorStateProvider>` with `AutoActivatePropertiesEffect` mounted under it and a spy on `panelLayoutRef.current.activatePanel`.
**When**: `setSelectedTransition(tr)` is called.
**Then**:
- **activate-called**: `activatePanel` was called with argument `'properties'`.
- **once-per-transition**: `activatePanel` was called exactly once for this state change (effect dep array collapses to a single invocation per commit).

#### Test: `auto-activate-skipped-when-empty` (covers `AutoActivatePropertiesEffect` negative)

**Given**: provider freshly mounted; all selections null.
**When**: the first render commits and `AutoActivatePropertiesEffect`'s effect runs.
**Then**:
- **activate-not-called**: `activatePanel('properties')` was NOT called, because the guard `if (selectedKeyframe || selectedTransition || ...)` is false.

#### Test: `does-not-expose-foreign-state` (covers R13)

**Given**: provider mounted.
**When**: consumer inspects the keys of `useEditorState()`.
**Then**:
- **no-currenttime-key**: no key named `currentTime`, `isPlaying`, `seekRef`, `seek`.
- **no-data-key**: no key named `keyframes`, `transitions`, `tracks`, `clips`, `data`.
- **no-job-key**: no key named `jobs`, `activeJobs`, `jobState`.
- **no-preview-key**: no key named `preview`, `previewUrl`.
- **no-menu-key**: no key named `contextMenu`.

### Edge Cases

#### Test: `setters-are-stable-refs` (covers R12)

**Given**: a provider; consumer captures setter identities on first render into refs.
**When**: provider re-renders due to an unrelated state change (e.g., `registerCallbacks({})`).
**Then**:
- **stable-kf-setter**: `setSelectedKeyframe` on second render `===` the captured ref.
- **stable-all-setters**: same for the other four setters and `registerCallbacks`.

#### Test: `last-setter-in-tick-wins` (covers R2)

**Given**: provider in initial state.
**When**: within a single synchronous event handler, consumer calls `setSelectedKeyframe(kf)` then `setSelectedTransition(tr)`.
**Then**:
- **tr-wins**: after React flushes, `selectedTransition === tr`.
- **kf-cleared**: `selectedKeyframe === null` — the second setter's mutex clear wiped what the first wrote.
- **one-commit**: React batches both calls into a single commit (no intermediate render with both set).

#### Test: `same-setter-twice-last-value-wins` (covers R2)

**Given**: provider in initial state.
**When**: in one tick, `setSelectedKeyframe(kfA)` then `setSelectedKeyframe(kfB)` are called.
**Then**:
- **kfB-wins**: `selectedKeyframe === kfB`.
- **others-still-null**: the other four remain `null`.

#### Test: `value-identity-stable-via-memo` (covers R19, OQ-6)

**Given**: a provider; consumer captures `useEditorState()` reference on first render.
**When**: parent re-renders the provider with NO change to the five selection fields and NO change to the callback bundle.
**Then**:
- **value-reference-stable**: on the second render, the returned value object `===` the first render's value (stable via `useMemo`).
- **no-consumer-rerender**: a consumer that reads the same fields does NOT re-render in response to the provider's parent re-render.

#### Test: `selection-auto-clears-on-delete` (covers R16, OQ-2)

**Given**: provider with `selectedKeyframe = kf_7`; `EditorDataContext` then emits an update where `kf_7` has `deleted_at` set (or kf_7 is absent from the current data set).
**When**: the data-context update commits.
**Then**:
- **kf-cleared**: `selectedKeyframe === null` on the next render.
- **others-unchanged**: the other four selection slots remain as they were (all `null`).
- **callback-slots-unchanged**: callback bundle is unchanged.

#### Test: `selection-resets-on-project-change` (covers R17, OQ-3)

**Given**: provider under project A with `selectedTransition` set; callbacks registered.
**When**: the ambient project id changes to B (either via `key={projectId}` remount or an internal effect firing).
**Then**:
- **all-selections-null**: all five selection slots are `null`.
- **callbacks-reset**: all four callback slots are `null`.

#### Test: `register-callbacks-cleanup-is-caller-responsibility` (covers R18, OQ-4)

**Given**: an owner component that registers callbacks in a `useEffect` and unmounts without calling `registerCallbacks({})` in its cleanup.
**When**: After unmount, the provider still holds the bundle.
**Then**:
- **bundle-still-present**: `onKeyframeDelete` still resolves to the unmounted owner's closure (provider does not auto-detect).
- **contract-documented**: this is the codified contract — caller, not provider, is responsible for cleanup.

#### Test: `setter-with-undefined-normalized-to-null` (covers R15, OQ-5)

**Given**: provider with `selectedTransition` set (non-null).
**When**: consumer calls `setSelectedKeyframe(undefined as any)`.
**Then**:
- **kf-null**: `selectedKeyframe === null` (normalized, not `undefined`).
- **mutex-clears-do-not-fire**: because the normalized value is `null`, mutex clears do NOT run; `selectedTransition` remains unchanged (matches `setSelectedKeyframe(null)` semantics per R8).

#### Test: `selection-survives-unrelated-rerender`

**Given**: provider with `selectedKeyframe` set.
**When**: a sibling component re-renders (no setter call).
**Then**:
- **kf-preserved**: `selectedKeyframe` still points to the same object.
- **others-still-null**: no accidental clearing.

#### Test: `callbacks-survive-selection-changes`

**Given**: provider with callbacks registered and `selectedKeyframe` set.
**When**: `setSelectedKeyframe(null)` is called.
**Then**:
- **cb-slots-intact**: all four callback slots are unchanged.
- **negative-selection-does-not-touch-callbacks**: selection setters do not implicitly clear callbacks.

#### Test: `no-multi-select-surface`

**Given**: the context value shape.
**When**: consumer inspects keys.
**Then**:
- **no-array-selection**: there is no key named `selectedKeyframes`, `selectedTransitions`, etc. (arrays).
- **no-shift-anchor**: there is no key for a shift-click anchor.
- **no-multi-setter**: there is no `addToSelection` / `toggleSelection` / `setSelectedKeyframes` function.

---

## Non-Goals

- Multi-select across any entity type (arrays, shift/cmd anchors, range selection).
- Selection integrity checks against `EditorDataContext` (deleted entity, foreign project).
- Persistence of selection across reloads.
- Undo/redo of selection changes.
- Memoization of the context value literal (perf optimization deferred; see OQ-6).
- Decoupling `registerCallbacks` from the provider's `useState` (e.g., switching to a ref would change the re-render semantics).
- Cross-entity composite selection (e.g., "a transition AND its two keyframes").

---

## Open Questions

### Resolved

**OQ-2 (resolved)**: Stale-id selection. **Decision**: provider subscribes to `EditorDataContext` and auto-clears a selection slot when the selected entity has `deleted_at` set or is missing. **Tests**: `selection-auto-clears-on-delete`.

**OQ-3 (resolved)**: Cross-project selection. **Decision**: provider resets on project-id change (via `key={projectId}` or internal effect). **Tests**: `selection-resets-on-project-change`.

**OQ-4 (resolved)**: `registerCallbacks` during unmount. **Decision**: codify — callers MUST pair registration with cleanup in the same effect; provider does not detect orphaned bundles. **Tests**: `register-callbacks-cleanup-is-caller-responsibility`.

**OQ-5 (resolved)**: Setter called with `undefined`. **Decision**: normalize `undefined` → `null` at setter entry; mutex clear triggers correctly. **Tests**: `setter-with-undefined-normalized-to-null`.

**OQ-6 (resolved)**: Value identity churn. **Decision**: wrap context value in `useMemo` keyed on selections + callback bundle. Pure perf hygiene; no behavior change. **Tests**: `value-identity-stable-via-memo`.

**OQ-7 (resolved)**: Provider-less behavior. **Decision**: codify — intentional escape hatch for Storybook / isolated component rendering. Keep as-is. **Tests**: `no-provider-returns-default` (already present).

### Deferred

- **OQ-1 (multi-select)**: **Deferred** — single-select is the current product shape; multi-select would require a mutex refactor (arrays per type or discriminated union). Behavior table row #22.
- **OQ-8 (audio clip + audio track simultaneously)**: **Deferred** — not required today; composite selection is a future refactor if UX needs it.

---

## Related Artifacts

- **Audit**: `agent/reports/audit-2-architectural-deep-dive.md` §1D unit 9, §2 "Selection Mutex" invariant
- **Source**: `src/components/editor/EditorStateContext.tsx`
- **Consumers**: `src/components/editor/EditorPanelLayout.tsx` (`AutoActivatePropertiesEffect`), `src/components/editor/KeyframePanel.tsx`, `src/components/editor/TransitionPanel.tsx`
- **Sibling contexts (out of scope, separate specs)**: `CurrentTimeContext`, `EditorDataContext`, `JobStateContext`, `PreviewContext`, `ContextMenuProvider`
- **Related spec targets**: `timeline-composition-and-playback-loop` (audit §5 #11), `video-and-transition-tracks` (#12), `audio-lane-and-clip-editing` (#13)

---

## Notes

- This is a **retroactive** spec: the system exists and ships. Requirements were derived by reading the implementation, not by design. Open Questions capture places where the implementation is silent — those are the places where code behavior should be treated as incidental until the team decides.
- The selection mutex is enforced by *setter convention*, not by a single reducer. Two setters cannot be called "simultaneously" within one React tick in a way that produces an inconsistent render, because React batches state updates — but the last setter's clears overwrite any earlier setter's writes. Tests `last-setter-in-tick-wins` and `same-setter-twice-last-value-wins` pin this.
- The provider is NOT memoized. Every render produces a fresh `value` literal. Consumers re-render even when their read slice is unchanged. This is a known perf shape and not a goal to change without a profiling-driven motive.
