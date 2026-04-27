# Audit Report: Scenecraft Architectural Deep Dive

**Audit**: #2
**Date**: 2026-04-27
**Subject**: Conceptual unit inventory — core components, responsibilities, boundaries, encapsulation, invariants. Prepared as the substrate for retroactive `@acp.spec` generation across the app surface.

**Method**: Six parallel investigations, one per subsystem (plugin system, data model, chat/agent, editor UI, audio, VCS+auth). Each investigation reported conceptual units with responsibility / public surface / encapsulation / collaborators / boundary leaks / code pointers. This report synthesizes them.

---

## Summary

Scenecraft is a layered system with reasonably clean boundaries at the top (plugin contributions, context providers, content-addressed VCS) and looser boundaries deep in the editor (Timeline reaches across track internals, AudioTrack doubles as playback master). The backend enforces a **R9a invariant** (plugins never touch raw DB) via a `plugin_api` allowlist facade — but enforcement is naming-convention only, not runtime. The frontend uses a **hybrid composition model**: React contexts for selection/data/playback state; module singletons (`audio-mixer-ref`, `playback-sync-ref`) for cross-panel coordination that sibling panels can't express through a provider tree.

**64 conceptual units identified** across 6 subsystems. **~15 boundary leaks** of varying severity. Leaks concentrate in three places: (1) **Timeline ↔ tracks** (tight coupling, 4200 LOC of orchestration), (2) **AudioTrack ↔ Timeline** (HTMLAudioElement is master clock, Timeline seeks via ref), (3) **plugin_api ↔ raw DB** (R9a honored by convention, not enforcement).

**What the system defines**: a content-addressed media pool, a declarative timeline (keyframes + transitions + audio clips + effects + curves), a per-project SQLite DB plus server-wide auth/spend DB, a VSCode-style plugin model with typed providers, a WebAudio-backed live mixer that is *bit-identical* with the offline renderer via a shared `mix-graph`, an LLM chat layer with destructive-op elicitation and job-event streaming over WS, and a content-addressed DAG-based VCS with refs/sessions/branches.

---

## 1. Conceptual Units Catalog

### 1A. Plugin System (13 units)

| # | Unit | Responsibility | Key code |
|---|---|---|---|
| 1 | **PluginHost (Python)** | Static process-wide registry; lifecycle (register/deactivate/reload); dispatches operations, MCP tools, REST routes | `plugin_host.py:135–501` |
| 2 | **PluginHost (TypeScript)** | Mirror registry for frontend panels/operations/context-menus; Disposable LIFO cleanup | `plugin-host.ts:155–337` |
| 3 | **PluginContext** | Per-plugin activation container; holds subscriptions + parsed manifest | `plugin_host.py:63–77` |
| 4 | **PluginManifest** | YAML schema parser + validator; introspection before activation | `plugin_manifest.py:245–283` |
| 5 | **Disposable Pattern** | VSCode-style resource cleanup contract; LIFO firing on deactivation | `plugin_host.py:20–59` |
| 6 | **plugin_api Allowlist** | R9a enforcer (by re-export); narrow facade gating core-table writes | `plugin_api/__init__.py:1–485` |
| 7 | **OperationRegistry** | Maps operation_id → handler; drives entity-type context menus + chat tools | `plugin_host.py:386–417` |
| 8 | **MCPToolRegistry** | Maps `{plugin}__{tool_id}` → handler; enforces double-underscore namespacing; tracks destructive flag | `plugin_host.py:422–453` |
| 9 | **RESTEndpointRegistry** | Per-HTTP-method route tables; auto-prefix plugin namespace; regex match | `plugin_host.py:456–481` |
| 10 | **ReplicateProvider** | Typed facade for ML predictions; owns HTTP/auth/polling/spend; no raw DB | `providers/replicate.py:1–463` |
| 11 | **SpendLedgerAPI** | `record_spend()` helper; plugin-attributed, unit-agnostic | `plugin_api/__init__.py:259–309` |
| 12 | **WSBroadcast** | Plugin → frontend event fanout; namespaced `{plugin_id}__{event_type}` | `plugin_api/__init__.py:172–224` |
| 13 | **ManifestHandlerResolver** | Walks dotted paths (`backend:mod.fn`) to resolve handler callables | `plugin_manifest.py:307–341` |

### 1B. Data Model (27 tables + 4 access units)

**Core tables (project.db)**:

| Table | Entity | Discriminator / FK |
|---|---|---|
| `keyframes` | Timeline scene markers | soft-delete via `deleted_at` |
| `transitions` | Keyframe-to-keyframe animations | `from_kf`, `to_kf`; `slots ≥ 1` |
| `pool_segments` | Content-addressed media | `variant_kind` discriminator (NULL / music / foley / lipsync) |
| `tr_candidates` | N video variants per transition slot | junction table |
| `audio_tracks` | Render-bus destination, DAW-style | volume_curve JSON |
| `audio_clips` | Playable audio segment on a track | `track_id`, `selected` (→pool_segments), `deleted_at` |
| `audio_candidates` | Alternate audio sources per clip | junction table |
| `audio_clip_links` | Audio ↔ transition cross-domain binding | one-to-many both sides |
| `pool_segment_tags` | Normalized tag table (merge-friendly) | — |
| `track_effects` | Per-track or master-bus DSP | `track_id` NULL = master |
| `effect_curves` | Per-param automation | `(effect_id, param_name)` unique |
| `checkpoints` | Pre-VCS snapshots | superseded by commits but not cleaned |

**Plugin sidecar tables** (`<plugin_id>__<table>` convention):

- `generate_music__{generations, tracks}`
- `generate_foley__{generations, tracks}`
- `transcribe__{runs, segments}`
- `audio_isolations`, `isolation_stems`
- `light_show__{fixtures, overrides, screens, scenes, scene_placements, live_override}`

**Server tables (server.db)**: `spend_ledger`, `api_keys`, `users`, `orgs`, `org_members`, `login_codes`

**Non-SQLite persistence (.scenecraft/)**:

| Unit | Responsibility | Invariant |
|---|---|---|
| **Object Store** | Content-addressed SQLite-blob store; SHA-256 keyed | Write-once; dedup on hash; immutable |
| **Commits** | Immutable {db_hash, parents, author, msg, ts} DAG | Canonical JSON; deterministic hash |
| **Refs** | Named branch pointers → commit hashes | One file per branch; no multi-ref atomicity |
| **Sessions** | Per-user working copy tied to project/branch commit | Reused if branch hasn't advanced |

### 1C. Chat / Agent Subsystem (9 units)

| # | Unit | Responsibility |
|---|---|---|
| 1 | **Tool Registry** (`CHAT_TOOLS`) | 40+ built-in tools + plugin-contributed; JSON-schema inputs |
| 2 | **Tool Dispatcher** (`_execute_tool`) | Routes tool_use → handler; returns `(result, is_error)`; plugin-namespaced tools branch to PluginHost |
| 3 | **Destructive Gate** (`_is_destructive`) | Regex + allowlist + plugin flag; triggers elicitation |
| 4 | **Elicitation Pipeline** | Emits `elicitation` WS event; blocks on future; 300s timeout; accept→execute / decline→error result |
| 5 | **Stream Handler** (`_stream_response`) | Iterates Claude response; emits `chunk`/`tool_call`/`tool_progress`/`tool_result`/`message`/`complete` |
| 6 | **JobManager** (singleton) | Thread-safe job registry; broadcasts `job_started`/`progress`/`completed`/`failed` to all `/ws/jobs` clients |
| 7 | **JobStateContext** (frontend) | React store keyed by entityKey; auto-dedup; auto-expire (30s complete / 10s fail) |
| 8 | **MCPBridge** | Async OAuth-gated Remember MCP tools; fire-and-forget connect; degrades to built-in only on failure |
| 9 | **Chat History** | Persisted turns; 50-message context window for Claude; 10-iteration tool loop cap |

### 1D. Editor UI (14 units)

| # | Unit | Responsibility |
|---|---|---|
| 1 | **EditorPanelLayout** | Orchestrate custom panel tree (`@/components/panel-layout`); persistence; per-panel error boundaries |
| 2 | **PanelLayout** (first-party) | Own split/group tree data model + renderer; drag-resize (ResizeSash), collapse, tab switching, lock — no third-party layout lib |
| 3 | **Timeline** | 4200 LOC orchestrator: composes VideoTrack/TransitionTrack/AudioTrack/RulesTrack/Playhead |
| 4 | **VideoTrack** | Keyframe clips + drag-select |
| 5 | **TransitionTrack** | Transition clips; 1800 LOC; mutates rects during drag; reaches into Timeline state |
| 6 | **AudioTrack / AudioLane** | Holds HTMLAudioElement; drives playhead via `timeupdate`; renders waveforms |
| 7 | **RulesTrack** | Section bands + beat grid + suppressions (read-only overlay) |
| 8 | **Playhead** | Scrub cursor + drag handler; seeks via `seekRef` |
| 9 | **EditorStateContext** | Selection mutex across kf / tr / track / audio_clip / audio_track |
| 10 | **EditorDataContext** | Immutable project data from loader |
| 11 | **CurrentTimeContext** | Split high-freq `currentTime` from low-freq `isPlaying`; action refs decouple seek from renders |
| 12 | **JobStateContext** | In-flight job tracking; see §1C |
| 13 | **PreviewContext** | Hover-preview URL + video scrub state |
| 14 | **ContextMenuProvider** | Context-menu visibility state |

Plus **2 module singletons**: `audio-mixer-ref`, `playback-sync-ref` — intentional bypass of React tree for cross-panel access (panels are DOM siblings in the first-party `PanelLayout` tree, not descendants of a common provider).

**Custom panel-layout module** (`src/components/panel-layout/`): `PanelLayout.tsx`, `PanelGroup.tsx`, `SplitContainer.tsx`, `ResizeSash.tsx`, `types.ts`, `validate.ts`. Migrated off dockview; `dockview-react` lingering in `package.json` is a stale dep to remove.

### 1E. Audio Subsystem (12 units)

| # | Unit | Responsibility | Invariant |
|---|---|---|---|
| 1 | **AudioMixer** | Manage live WebAudio graph; activate clips on seek; sync playhead to speaker time | Graph is source of truth |
| 2 | **MixGraph** (shared) | Crossfade curves, clip/track volume scheduling, solo/mute rules | Live and offline produce bit-identical output |
| 3 | **MixRender** (offline) | Render `[start, end)` to PCM via OfflineAudioContext; reuses live graph builder | Offline clock ≡ 0 at startTimeS |
| 4 | **EffectRegistry** | 17 effect types with param specs + builder factories | `EFFECT_TYPES` immutable, animatable flags per effect |
| 5 | **TrackChain** | Wire serial effects + pan + gain + parallel send taps | gain after effects; sends fan-out from gain |
| 6 | **SendBusGraph** | Reverb/delay/echo buses; uniform `{input,output,setParam,scheduleCurve,dispose}` | Buses independent; pre-muted until user unmutes |
| 7 | **BypassManager** | Toggle effect enable/disable without rebuilding chain; preserve scheduled curves | No graph reconstruction on bypass |
| 8 | **CurveScheduler** | Sample clip/track curves → AudioParam ramps | Clip curves normalized [0,1]; track curves absolute sec |
| 9 | **WaveformCache** | Fetch float16 peaks from backend; de-dupe concurrent requests | Server-side computation; unbounded cache |
| 10 | **Mute/Solo Logic** | Track mute → 0; any solo → unmuted disabled | Applied at trackGain; shared live/offline |
| 11 | **Crossfade** | Equal-power curves on overlapping clips (cos/sin) | Scheduled after activation; re-triggered on seek |
| 12 | **Overlap Resolution** | Compute trim/split/delete ops on drop; DaVinci winner-takes-all | Left-trim advances source_offset; right-trim does not |

### 1F. VCS + Auth (11 units)

| # | Unit | Responsibility | Invariant |
|---|---|---|---|
| 1 | **Object Store** | Content-addressed SQLite-blob store | Write-once; dedup on hash |
| 2 | **Commits** | Immutable DAG entries | Deterministic hash via canonical JSON |
| 3 | **Refs** | Branch pointers | One file per branch |
| 4 | **Sessions** | Per-user working copies | Reused if branch unchanged |
| 5 | **Branches** | Create/list/delete/checkout | `main` always exists; can't delete current |
| 6 | **JWT Auth** | HS256 stateless tokens; 24h expiry; HttpOnly cookies | Secret never rotated; fingerprint supports pubkey revocation |
| 7 | **API Keys (double-gate)** | PBKDF2(600k) hashed; session + X-Scenecraft-API-Key header | Raw key shown once; hashed at rest |
| 8 | **User/Org Management** | Central identity in server.db; memberships + roles | Usernames are PKs |
| 9 | **REST+WS Auth Middleware** | Gate non-exempt endpoints | Exempt: /auth/login, /auth/logout, /oauth/callback |
| 10 | **Spend Ledger Writes** | Via `plugin_api.record_spend` only | Immutable; unit-agnostic (can't sum different units) |
| 11 | **Login Codes** | Short-lived (5min) SSH-to-browser handshake codes | Single-use; consumed on GET /auth/login |

---

## 2. Key Invariants

| ID | Invariant | Enforcement |
|---|---|---|
| **R9a** | Plugins never touch raw DB; only `plugin_api` surface | By convention (naming); NOT runtime-enforced |
| **Audio = Frontend** | Mix analysis + final bounce render via OfflineAudioContext cloning the live graph; never reimplement mixer in Python | Via shared `mix-graph.ts`; bit-identical guarantee |
| **Pool-first** | All imported/generated media lands in `pool_segments`; candidates reference pool | Enforced by DAL (no alternate ingest path) |
| **Immutable VCS** | Objects + commits never mutated after write | Content-addressing makes mutation invisible |
| **Selection Mutex** | Only one entity type selected at a time (kf XOR tr XOR track XOR audio_clip XOR audio_track) | EditorStateContext setters clear others |
| **Generation Jobs Survive Disconnect** | Don't cancel Imagen/Veo/Replicate on WS close | attach_polling for reattach |
| **Playback Master = AudioTrack** | HTMLAudioElement `timeupdate` drives playhead; Timeline seeks via `seekRef` | Coupling by design; leaks into Timeline lifecycle |
| **Destructive Ops Gated** | Tool matches `_DESTRUCTIVE_TOOL_PATTERNS` or plugin flag → WS elicitation → user accept | `_is_destructive` before every `_execute_tool` |
| **Plugin Sidecar Prefix** | Plugin-owned tables named `<plugin_id>__<table>` | By convention; no SQL-level CHECK constraint |
| **Server.db Isolation** | Only spend_ledger / api_keys / users / orgs cross project boundary | Enforced by `plugin_api.record_spend` being the only write path |

---

## 3. Boundary Leaks (ranked by severity)

| # | Leak | Severity | Location |
|---|---|---|---|
| 1 | **R9a not runtime-enforced** — plugins can `from scenecraft.db import get_db` and bypass allowlist | CRITICAL | `plugin_api/__init__.py` |
| 2 | **`record_spend(plugin_id)` trusts caller identity** — in-process code can cross-attribute spend. M17 TODO | HIGH | `plugin_api/__init__.py:259–309` |
| 3 | **Timeline ↔ AudioTrack coupling** — Timeline calls `seekRef.current?.()`; AudioTrack `timeupdate` drives playhead. Panel remount can stall playback | HIGH | `Timeline.tsx`, `AudioTrack.tsx` |
| 4 | **TransitionTrack 1800 LOC reaches into Timeline** — drags mutate rects; reads `allKeyframes`/`allTransitions` from parent | HIGH | `TransitionTrack.tsx` |
| 5 | **Plugin sidecar prefix unenforced** — if raw DB access is obtained, plugin can write to core tables or claim arbitrary prefix | MEDIUM | `db.py` schema |
| 6 | **Decode cache module-global** — survives HMR; no invalidation when clip's file changes on disk | MEDIUM | `audio-mixer.ts` decode cache |
| 7 | **Checkpoint table parallel to commits** — both systems exist; checkpoints not cleaned | MEDIUM | `db.py` + `vcs/` split |
| 8 | **REST endpoint path shadowing** — crafty plugin regex could shadow core routes; mitigated by manifest validation requiring `/` prefix | LOW | `plugin_host.py:318` |
| 9 | **Frontend `frontend:...` handler refs not resolved at manifest parse time** — only on use | LOW | `plugin_manifest.py:307` |
| 10 | **Module singleton `audio-mixer-ref`** — intentional but hard to test; couples 3D preview to Timeline graph | LOW (intentional) | `audio-mixer-ref.ts` |
| 11 | **Session WC unlink swallows OSError** — locked file lingers | LOW | `sessions.py` checkout |
| 12 | **Pubkey fingerprint truncated SHA-256 (16 chars / 2^64)** | LOW | `bootstrap.py` |
| 13 | **Tool loop capped at 10 iterations** — Claude may stall mid-thought | LOW | `chat.py:5306` |
| 14 | **Chat history pruned at 50 messages** — may miss context in long sessions | LOW | `chat.py` |
| 15 | **No LRU eviction on decode cache** — long sessions accumulate buffers | LOW | `audio-mixer.ts` |

---

## 4. End-to-End Flow Examples

### "User types 'generate keyframe candidates for this transition'"

```
ChatPanel.handleSend
  → WS /ws/chat/{project}: {type:"message", content:"..."}
  → chat.py::_stream_response iterates Claude response
     → emits tool_call {name:"generate_keyframe_candidates"}
     → _is_destructive → true
     → emits elicitation event, blocks on future
  User clicks Accept
     → WS elicitation_response
     → _execute_tool → start_keyframe_generation
         → job_manager.create_job → emits job_started on /ws/jobs
         → daemon thread runs generation (Imagen via providers/imagen)
         → on progress: job_manager.update_progress → emits job_progress
         → on done: job_manager.complete_job → emits job_completed
     → _await_generation_job polls every 1s, emits tool_progress
     → emits tool_result
  Frontend:
     - ChatPanel.onMutation → router.invalidate
     - JobStateContext auto-deduped by entityKey
     - KeyframePanel re-renders with new candidates in pool
```

### "User drags a pool_segment onto an audio track"

```
AudioLane drop handler
  → POST /api/audio/candidates/{clip_id} {pool_segment_id, source:'imported'}
     → add_audio_candidate (plugin_api / DAL)
        → INSERT audio_candidates
  → POST /api/audio/clips/{clip_id}/assign
     → UPDATE audio_clips SET selected = pool_segment_id
  → Timeline re-reads via useEditorData
  → AudioMixer.rebuild picks up new clip
     → schedule clip curves on AudioParam
     → crossfade logic if overlap
     → src.start(when, offset, duration)
  → Speakers
```

### "Branch switch from main to feature-x on Machine B"

```
POST /api/branches/checkout {target:"feature-x"}
  → checkout_branch(session_id, "feature-x")
     → get_ref(feature-x) → def456
     → snapshot WC, hash abc123 == current commit → clean
     → copy .scenecraft/orgs/{org}/projects/{p}/objects/def456.db
       → .scenecraft/users/alice/sessions/video--feature-x.db
     → UPDATE sessions SET branch=feature-x, commit_hash=def456, working_copy=...
```

---

## 5. Proposed Spec Targets (20 specs)

Each row = one feature area to fan out as a `@acp.spec` worktree. Scope is deliberately narrow to keep spec proofable in one sitting. `undefined` rows expected — that's the goal.

### Backend / core (8)

| # | Spec target | Primary sources |
|---|---|---|
| 1 | **plugin-host-and-manifest** | plugin_host.py, plugin_manifest.py |
| 2 | **plugin-api-surface-and-r9a** | plugin_api/__init__.py |
| 3 | **replicate-provider** | plugin_api/providers/replicate.py |
| 4 | **chat-tool-dispatch-and-elicitation** | chat.py |
| 5 | **job-manager-and-ws-events** | ws_server.py, chat_generation.py |
| 6 | **pool-segments-and-variant-kind** | db.py pool segment section + candidates junctions |
| 7 | **vcs-object-store-commits-refs** | vcs/objects.py, vcs/branches.py |
| 8 | **auth-jwt-api-keys-double-gate** | auth.py, auth_middleware.py, bootstrap.py |

### Frontend editor (7)

| # | Spec target | Primary sources |
|---|---|---|
| 9 | **panel-layout-and-plugin-panel-host** | EditorPanelLayout.tsx, src/components/panel-layout/* (first-party), plugin-host.ts |
| 10 | **editor-state-selection-mutex** | EditorStateContext.tsx + all Property panels |
| 11 | **timeline-composition-and-playback-loop** | Timeline.tsx (top-level) + CurrentTimeContext.tsx |
| 12 | **video-and-transition-tracks** | VideoTrack.tsx, TransitionTrack.tsx |
| 13 | **audio-lane-and-clip-editing** | AudioLane.tsx, AudioTrack.tsx, audio-overlap.ts |
| 14 | **waveform-cache-and-rendering** | waveform-cache.ts, AudioWaveform.tsx |
| 15 | **chat-panel-and-job-state** | ChatPanel.tsx, JobStateContext.tsx, chat-client.ts |

### Audio engine + light show + misc (5)

| # | Spec target | Primary sources |
|---|---|---|
| 16 | **webaudio-mixer-and-mix-graph** | audio-mixer.ts, mix-graph.ts, mix-render.ts |
| 17 | **audio-effects-and-curve-scheduling** | audio-effect-types.ts, audio-graph.ts |
| 18 | **bounce-and-analysis** (bit-identical offline invariant) | mix-render.ts + bounce_audio.py + analyze_master_bus.py |
| 19 | **generate-foley-plugin** (end-to-end, both halves) | plugins/generate_foley/ × 2 |
| 20 | **light-show-dmx-output** | enttec-pro.ts, dmx-mapper.ts, plugins/light_show/ backend |

Note: three specs already exist (`local.light-show-scene-editor.md`, `local.music-generation-plugin.md`, `local.source-monitor-panel.md`); excluded from target list above.

---

## 6. Recommendations

1. **Spec the R9a-enforcement gap first** (spec #2 above). Current invariant is naming-convention; spec should either codify "naming-convention only" as the contract OR define the runtime enforcement mechanism (import hook / audit log / process boundary) as a requirement — the Behavior Table's `undefined` rows will surface exactly which.
2. **Spec Timeline↔AudioTrack coupling honestly.** Don't paper over the playback-master-is-AudioTrack design; write it into the spec as an explicit invariant so future refactors can't accidentally break it.
3. **The plugin sidecar prefix convention needs teeth or a spec acknowledging it's convention-only.** Either add a SQL CHECK on CREATE TABLE or write the spec stating plugins are trusted to self-prefix.
4. **Fan out 20 spec worktrees in parallel.** One branch per feature area (`spec/01-plugin-host`, etc.); no merges until user proofs each Behavior Table. Harvest specs back as PRs.
5. **Triage checkpoints vs commits** in a follow-up cleanup. Both persistence systems coexist; one should win.
6. **Resolve M9 numbering collision** (flagged in audit-1, still present): two milestones share `milestone_9`.

---

**Audit complete**: report saved at `agent/reports/audit-2-architectural-deep-dive.md`.
**Next**: use §5 as the fan-out list for parallel `@acp.spec` worktrees.
