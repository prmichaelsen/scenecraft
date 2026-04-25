# Task 162: LightShow3DPanel Integration + Manual E2E

**Milestone**: [M19](../../milestones/milestone-19-light-show-scene-editor.md)
**Spec Reference**: [`local.light-show-scene-editor.md`](../../specs/local.light-show-scene-editor.md) — R49, R50; manual E2E in spec Behavior section
**Estimated Time**: 1 hour
**Dependencies**: tasks 159 (client), 160 (primitives), 161 (evaluator)
**Status**: Not Started

---

## Objective

Wire the scene editor into `LightShow3DPanel.tsx`. Fetch + WS-subscribe + reconnect-refetch (no periodic polling). Replace the existing `SceneRunner`'s scene resolution with the layered evaluator. Show the active layer label in the diagnostic bar. Verify end-to-end with a manual rotating-head test.

---

## Steps

### 1. State + fetch hooks in `LightShow3DPanel`

```ts
const [scenes, setScenes] = useState<SceneRow[]>([])
const [placements, setPlacements] = useState<PlacementRow[]>([])
const [liveOverride, setLiveOverride] = useState<LiveOverrideRow>({ active: false })

// Build a Map keyed by id for O(1) lookup in the evaluator
const scenesById = useMemo(() => new Map(scenes.map(s => [s.id, s])), [scenes])
```

### 2. Fetch + WS + reconnect-refetch (R49)

```ts
const { connected } = useScenecraftSocket()
const prevConnectedRef = useRef(connected)

const refetchAll = useCallback(async () => {
  if (!projectName) return
  const [s, p, l] = await Promise.all([
    fetchScenes(projectName, { limit: 500 }),
    fetchPlacements(projectName, { limit: 1000 }),
    fetchLiveOverride(projectName),
  ])
  setScenes(s.scenes)
  setPlacements(p.placements)
  setLiveOverride(l)
}, [projectName])

// Mount + projectName change
useEffect(() => { void refetchAll() }, [refetchAll])

// WS event-driven refetch
useEffect(() => {
  if (!projectName) return
  const unsub = subscribePluginEvent('light_show', 'changed', (msg) => {
    if (msg.projectName !== projectName) return
    const kind = msg.payload?.kind
    if (kind === 'scenes') {
      fetchScenes(projectName, { limit: 500 }).then(r => setScenes(r.scenes)).catch(()=>{})
    } else if (kind === 'placements') {
      fetchPlacements(projectName, { limit: 1000 }).then(r => setPlacements(r.placements)).catch(()=>{})
    } else if (kind === 'live') {
      fetchLiveOverride(projectName).then(setLiveOverride).catch(()=>{})
    }
  })
  return unsub
}, [projectName])

// Reconnect-driven refetch
useEffect(() => {
  if (!prevConnectedRef.current && connected) {
    void refetchAll()
  }
  prevConnectedRef.current = connected
}, [connected, refetchAll])
```

NO `setInterval` polling. The combination above covers R49.

### 3. Replace existing SceneRunner scene resolution

In the `useFrame` callback, swap from `getScene(activeSceneIdRef.current)?.apply(...)` to:

```ts
const result = evaluateLayeredScene({
  playheadTime: playheadRef.current,
  wallClockMs: performance.timeOrigin + performance.now(),  // or Date.now()
  scenesById,
  placements,
  liveOverride,
  states: stateRef.current,
  context: sceneContext,
  fallbackScene: getScene(activeSceneIdRef.current) ?? null,
  projectName,
})
activeLayerRef.current = result
```

Keep the existing fallback-via-dropdown affordance (R41 transitional). The dropdown still picks which fallback scene runs when nothing is scheduled.

### 4. Diagnostic bar update (R50)

In the existing diagnostic span:

```tsx
const layer = activeLayerRef.current
const layerLabel = (
  layer?.activeLayer === 'live'     ? `LIVE: ${layer.label}` :
  layer?.activeLayer === 'timeline' ? `TIMELINE: ${layer.label}` :
  layer?.activeLayer === 'fallback' ? `FALLBACK: ${layer.label}` :
  `IDLE`
)
diagDomRef.current.textContent = `... · ${layerLabel}`
```

### 5. Pre-existing override layer ordering

The old `set_fixture_state` per-channel overrides (`overridesRef`) currently apply AFTER the dropdown scene runs. They should now apply AFTER `evaluateLayeredScene` for ALL layers (live / timeline / fallback). The override layer wins per-channel. Verify the ordering in `useFrame`.

### 6. Manual E2E test

Run the engine + frontend dev servers. From chat:

1. `scenes.list_primitives` → confirm catalog returns
2. `scenes.set({scenes: [{label: "Slow Rotating Head", type: "rotating_head", params: {period_sec: 6}}]})` → capture the returned uuid
3. `scene_timeline.set({placements: [{scene_id: "<UUID>", start_time: 5, end_time: 15, fade_in_sec: 1, fade_out_sec: 2}]})` → placement created
4. Open the LightShow3DPanel; press play on the main timeline
5. **Verify**:
   - 0-5s: dropdown scene runs (FALLBACK label)
   - 5-6s: rotating-head fades in (TIMELINE label appears)
   - 6-13s: rotating-head full intensity, animated pan/tilt sinusoid
   - 13-15s: fades out
   - 15s+: dropdown scene resumes
6. Mid-play (e.g. at t=10s): `scene_live.activate({scene: {type: "static_color", params: {color: [1, 0, 0]}}, label: "Red Wash"})` → diag bar flips to LIVE; placement output suppressed
7. `scene_live.deactivate({fade_out_sec: 1})` → 1s fade out → timeline resumes (with placement still active in this case)
8. Scrub backward into the fade-in window (e.g. to t=5.5s) → verify intensity is mid-fade (deterministic, R48)
9. Restart the backend; refresh the panel; verify the row is gone (since deactivate completed) OR if you ran step 6 without step 7, verify the live override is still active after restart (R28)

### 7. tsc + sanity

```bash
cd scenecraft && npx tsc --noEmit 2>&1 | grep -i "light_show" | head
```

Should be clean. No new errors from this task.

---

## Verification

Spec edge tests covered (frontend side):
- [ ] `panel-refetches-on-ws-reconnect` (R49) — vitest with mocked socket connection state + mocked fetch counter

Manual E2E checks:
- [ ] Rotating-head animation visible 5-15s on the main timeline
- [ ] Diagnostic bar correctly shows `LIVE` / `TIMELINE` / `FALLBACK` per state
- [ ] Live override deactivate fade visibly completes; timeline resumes
- [ ] Scrub determinism: same playhead → same fixture state every time
- [ ] No periodic 2s fetches in the network panel; only WS events + reconnect-driven refetches
- [ ] Override layer (per-fixture set_fixture_state) still wins per-channel after the new evaluator runs

Code quality:
- [ ] `tsc --noEmit` clean for `LightShow3DPanel.tsx`
- [ ] No regressions in fixtures / overrides / screens panels (existing functionality untouched)

---

## Notes

- The `activeLayerRef` ensures the diagnostic bar text update doesn't trigger React re-renders for the 3D canvas (per the existing convention in this file).
- If the evaluator deletes a finished live override mid-frame, the next WS-driven refetch picks up `active: false` and the panel naturally falls back to timeline / fallback. No special handling needed in the panel.
- This task closes the milestone — once it's done with the manual E2E checks passing, M19 is complete.
