# Task 141: Scene List Panel, Candidate Tools, End-to-End Polish

**Milestone**: [M17 - Track Contribution Point and Light Show Plugin](../../milestones/milestone-17-track-contribution-point-and-light-show-plugin.md)
**Design Reference**: [local.track-contribution-point-and-light-show-plugin.md § Part 5 + § Key Design Decisions (candidates)](../../design/local.track-contribution-point-and-light-show-plugin.md)
**Estimated Time**: 6 hours
**Dependencies**: task-138 (backend), task-140 (UniverseContext + 3D panel)
**Status**: Not Started

---

## Objective

Ship the Scene List panel with hover-triggered 3D preview override, wire up the transition candidate MCP tools (add/select/generate), and complete the end-to-end MCP authoring flow. Verify the full experience works: chat creates a rig, scene, track, cues, transition, and the 3D preview reflects everything in real time.

---

## Context

Scene authoring at M17 is tools-first — no visual DSL editor. Users need at least a browsing UI to discover and preview scenes. The Scene List is minimal: a scrollable list of scenes, hoverable for preview. Clicking opens the scene's details (read-only at M17); future milestones add editing.

The candidate tools close the loop on the "generate options, hotswap, pick winner" flow that already works for video transitions — bringing the same ergonomics to lighting.

---

## Steps

### 1. Scene List panel

`src/plugins/light_show/SceneListPanel.tsx`:

- Fetch scenes on mount (GET `/api/projects/:name/plugins/light_show/scenes`)
- Render a scrollable list: one row per scene with label, parameter count, and (if derived) a link to the parent
- Hover behavior: on `onMouseEnter`, call `universe.setOverride({ sceneId, params: defaults })` and the 3D panel loops the scene with default params. On `onMouseLeave`, call `universe.clearOverride()`.
- Click: show scene details in a side pane (label, description, parameter schema, animation JSON pretty-printed — read-only)
- Filter: simple text filter on label / description

### 2. Override behavior in the evaluator

When `UniverseContext.override` is set, the composer bypasses tracks/transitions and evaluates just the overridden scene with default params and a looped internal clock:

```ts
if (store.override) {
  const scene = store.scenesById.get(store.override.sceneId)!
  const sceneTime = (performance.now() / 1000) % sceneLoopDuration
  const output = evaluateScene(scene, store.override.params, fixtures, profiles, sceneTime)
  // Apply output directly to universe buffer (no merge, no overlays)
} else {
  // Normal playback-driven composition
}
```

### 3. Candidate MCP tools

Implement in `scenecraft-engine/src/scenecraft/plugins/light_show/tools.py` + `rest.py`:

- `add_transition_candidate(transition_id, scene_id, params_snapshot)` → inserts into `light_show__transition_candidates`
- `select_transition_candidate(transition_id, candidate_id)` → sets `is_selected = 1` on the chosen row, clears others; updates `light_show__transitions.scene_id` to the candidate's scene_id
- `generate_transition_candidates(transition_id, n=3)` → LLM-driven: calls `plugin_api.call_service` with OpenAI or Anthropic (whichever is configured via BYO env var per task-128 pattern); prompt includes scene catalog and the tr's time position context; parses N scene+params proposals, inserts each as a candidate, returns them

### 4. Register panel

In `src/plugins/light_show/index.ts`:

```ts
PluginHost.registerPanel({
  id: 'light_show.scene_list',
  title: 'Light Show Scenes',
  Component: SceneListPanel,
})
```

Add to default workspace (next to the 3D preview panel).

### 5. End-to-end MCP flow test

Manual + scripted verification. Bring up scenecraft with a fresh project; via chat:

```
1. "Create a universe and set up a demo lighting rig"
   → LLM calls light_show.set_rig_layout with demo positions

2. "Add a light show track called 'Main Wash'"
   → light_show.add_track

3. "At time 0 and time 8, add cues on the Main Wash track"
   → light_show.add_cue × 2

4. "Between those cues, add a rainbow_sweep scene with rate 0.5"
   → light_show.add_transition with scene_id = rainbow_sweep, params.rate = 0.5

5. "Play the timeline"
   → User hits spacebar; 3D preview shows rainbow sweep running

6. "Generate 3 alternative scenes for this transition"
   → light_show.generate_transition_candidates
   → 3 candidates appear

7. "Hotswap to candidate 2"
   → light_show.select_transition_candidate
   → Preview updates to the new scene

8. Hover `comet_burst` in Scene List panel
   → Preview shows comet_burst in loop

9. Leave hover
   → Preview reverts to the playhead-driven Main Wash track
```

All 9 steps complete without errors; 3D preview reflects every state change correctly.

### 6. Candidate UI affordance

Minimal UI: in the transition inspector (shown when a tr is selected on a timeline track), list the candidates with a "select" button per candidate. Click a candidate → fires `select_transition_candidate` → preview updates.

### 7. Error surfaces

- Deleting a fixture referenced by a scene's `fixture_ref` parameter → handle gracefully in evaluator (skip missing fixtures, log once)
- Scene with an `animation` JSON that fails to parse → evaluator renders zero channel output, surface a warning in an inspector field
- Plugin deactivation mid-playback → 3D panel shows "Light show plugin inactive" placeholder; does not crash

### 8. Tests

- Scene List panel: fetch, render, filter, hover triggers override, unhover clears
- Candidate flow: add, select (exclusivity), generate (mock LLM response)
- End-to-end: scripted version of step 5 above (programmatic MCP invocations, verify resulting DB state + universe buffer)

---

## Verification

- [ ] Scene List panel registered and visible in workspace
- [ ] Hover-preview behavior: enters override on mouse enter, exits on mouse leave
- [ ] Scene detail view (read-only) shows label, params, animation JSON
- [ ] `add_transition_candidate` MCP tool works
- [ ] `select_transition_candidate` MCP tool works (exclusive `is_selected` flag)
- [ ] `generate_transition_candidates` MCP tool calls out via `call_service` to the configured LLM provider
- [ ] Candidate selection reflects in 3D preview
- [ ] End-to-end flow (9 steps above) completes without errors
- [ ] Error surfaces are graceful (missing fixtures, bad JSON, plugin deactivated)
- [ ] Tests pass

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Preview panel mode | Hover-triggered override, no mode toggle | Natural authoring gesture; no chrome clutter |
| Candidate selection | Exclusive `is_selected = 1` flag on one row | Matches video `tr_candidates` pattern; single-selection semantics |
| Candidate generation | LLM via `call_service` (BYO mode for M17) | Consistent with existing scenecraft LLM plumbing |
| Scene List filtering | Simple client-side text filter on label/description | Sufficient at M17 seed volume (~15 scenes); server-side filtering is trivial follow-up |
| No scene editing UI | Tools-first per design | Scope boundary; visual editor is post-M17 |

---

## Notes

- `generate_transition_candidates` prompt design is not fully specified here — iterate with actual LLM responses. Prompt should include: scene catalog summary (ids + descriptions + param schemas), the tr's time duration, user intent (optional parameter "goal" the LLM responds to).
- Consider rate limits and cost for `generate_transition_candidates`. Spend tracking via `plugin_api.record_spend` consistent with M16's generate_music pattern.
- Candidate snapshots store params at generation time; re-selecting a candidate restores both scene_id and params.

---

**Next Task**: None — this completes M17.
**Related Design Docs**: [local.track-contribution-point-and-light-show-plugin.md](../../design/local.track-contribution-point-and-light-show-plugin.md)
