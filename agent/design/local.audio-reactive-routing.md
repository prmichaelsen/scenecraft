# Audio-Reactive Routing & Instrument Profiles

**Concept**: Per-fixture audio source + envelope-shape + sensitivity routing for the light_show plugin — let an individual fixture react to a specific track (drum stem, bass stem, etc.) through a profile-shaped envelope (kick-snap, bass-glow, etc.) at a per-fixture sensitivity multiplier, instead of every fixture reacting uniformly to the master bus.
**Created**: 2026-04-26
**Status**: Proposal

---

## Overview

Today's audio-reactive scenes (`beat_strobe`, `kick_pulse`, `beat_color_chase`) drive every fixture from the master bus's full-spectrum and low-band RMS envelopes. That's correct as a default but flat as an aesthetic — every fixture pulses on every kick the same way, every par flashes blue→white in sync. Real lighting design routes specific musical elements to specific fixtures: front pars react to kick, side movers ride the bassline, hats fixtures shimmer with high-end, vocals colour the back wash.

This document specifies the smallest data + runtime change that unlocks per-fixture audio routing. Three coupled features:

1. **Track routing** — each fixture optionally references a specific track (typically a stem produced by `isolate_vocals` / future `stem_splitter`); null = master bus.
2. **Instrument profiles** — each fixture optionally selects a named profile (`kick`, `bass`, `snare`, `hats`, `guitar`, `vocals`, `pad`, `master_full`) that bundles `(frequency band, attack time, release time, gamma curve, gate threshold)` into one parameter set. The profile encapsulates "how do I listen to this thing" — band selection lives inside the profile, not next to it.
3. **Sensitivity** — each fixture optionally has a linear gain multiplier on its profile-shaped envelope output. Default `1.0` reproduces today's behavior; `0.0` mutes reactivity without unrouting; `>1.0` pushes the fixture toward saturation. Distinct from `gamma` (curve shape) and `gate` (threshold), which are profile-level engineering decisions about a kind of instrument; sensitivity is a per-installation taste knob about a specific fixture.

Existing scenes that read `masterLevel` keep working unchanged (global-behavior path). New scenes — and existing scenes when retrofitted — read `audioByFixture[id]` for per-fixture profile-shaped audio (routed-behavior path). Both paths coexist; a single scene can mix them (base wash on master + accent on routed).

---

## Problem Statement

The frontend AudioMixer already exposes per-track analysers — every track has a `trackGain → ChannelSplitter → {analyserL, analyserR}` sidechain (CHANGELOG `0.23.0`), accessible via `mixer.getTrackAnalysers(id)`. The master bus has the same treatment via `mixer.getMasterAnalysers()`. Today only the master analyser is consumed: `MasterBusSampler` (in `LightShow3DPanel.tsx`) computes full RMS + low-band RMS, applies an asymmetric envelope (~8ms attack / ~180ms release), and writes to `masterLevel` / `masterLowLevel` refs. `SceneContext` exposes those two scalars; scenes read them.

The plumbing is uniform across fixtures by design. To go per-fixture, we need:

1. **Storage**: a place to record per-fixture routing intent. The DB schema (`light_show__fixtures` per the M17 design) doesn't have audio routing fields.
2. **Sampling**: a generalization of `MasterBusSampler` that walks the rig, identifies unique `(track, profile)` pairs referenced, and computes one envelope per pair per frame.
3. **Scene API**: an extension of `SceneContext` that carries per-fixture audio, alongside the existing `masterLevel` / `masterLowLevel` for the global path.
4. **Shaping**: a profile abstraction so a fixture routed to the bass stem with the `kick` profile looks meaningfully different from the same fixture routed to the bass stem with the `bass` profile — fast attack + low compression vs slow attack + linear, both reading the same band.
5. **A way to set routing**: schema columns are inert without a write path. Chat tool first; properties-panel UI later.

Without these, "a fixture that reacts only to the kick" requires either a custom scene per-rig (terrible) or hand-tuning every scene's logic to inspect fixture IDs (also terrible).

---

## Solution

### Data model

Three nullable columns added to `light_show__fixtures`:

```sql
ALTER TABLE light_show__fixtures
  ADD COLUMN audio_track_id TEXT;       -- nullable; null = react to master bus
ALTER TABLE light_show__fixtures
  ADD COLUMN audio_profile TEXT;        -- nullable; null = 'master_full'
ALTER TABLE light_show__fixtures
  ADD COLUMN audio_sensitivity REAL;    -- nullable; null = 1.0 (full profile output)
```

All default null so existing fixtures keep behaving exactly as today. A non-null `audio_track_id` references an `audio_tracks.id` in the same project DB. A non-null `audio_profile` references one of the hardcoded preset names below. A non-null `audio_sensitivity` is a linear multiplier (typically 0.0..2.0, no hard upper bound; the runtime saturates the final output at 1.0).

No `audio_band` column — the profile owns band selection, that decision was tried and discarded. Bundling `(band, envelope, curve, gate)` into one named profile is conceptually cleaner and lets a user say "kick" once instead of specifying band+attack+release+gamma+gate every time.

Sensitivity intentionally lives **outside** the profile, on the fixture row directly. Profiles are shared engineering decisions (a "kick" responds the way a kick responds, regardless of which fixture is consuming it); sensitivity is per-installation taste (a fixture aimed at the back wall needs more gain to read across the room than the same fixture in someone's face). Coupling them inside the profile would force a proliferation of `kick_loud` / `kick_quiet` presets to cover what's really a one-axis fixture-level adjustment.

### Instrument profiles (hardcoded TS, MVP)

Eight presets, each = `(band, attack α, release α, gamma, gate)`:

```ts
type AudioProfile = {
  band: 'sub' | 'low' | 'mid_low' | 'mid' | 'mid_high' | 'high' | 'full'
  attack: number   // alpha 0..1; 0.95 ≈ 3ms (instant), 0.30 ≈ 150ms (smooth)
  release: number  // alpha 0..1; 0.05 ≈ 600ms (slow), 0.15 ≈ 200ms (medium)
  gamma: number    // <1 = punchy/expanded, 1 = linear, >1 = compressed
  gate: number     // floor 0..1; output below this clamps to 0
}

const PROFILES: Record<string, AudioProfile> = {
  kick:        { band: 'sub',     attack: 0.95, release: 0.15, gamma: 0.6, gate: 0.0  },
  bass:        { band: 'low',     attack: 0.30, release: 0.05, gamma: 1.0, gate: 0.0  },
  snare:       { band: 'mid_low', attack: 0.95, release: 0.10, gamma: 0.7, gate: 0.05 },
  hats:        { band: 'high',    attack: 0.95, release: 0.30, gamma: 0.5, gate: 0.10 },
  guitar:      { band: 'mid',     attack: 0.50, release: 0.08, gamma: 0.8, gate: 0.05 },
  vocals:      { band: 'mid',     attack: 0.30, release: 0.05, gamma: 1.0, gate: 0.03 },
  pad:         { band: 'full',    attack: 0.20, release: 0.03, gamma: 1.0, gate: 0.0  },
  master_full: { band: 'full',    attack: 0.85, release: 0.08, gamma: 1.0, gate: 0.0  },
}
```

`master_full` reproduces the current default behavior exactly — same band, same envelope coefficients as today's `masterLevel`. Migrating an existing fixture to `audio_profile = 'master_full'` is a no-op.

Frequency bands map to FFT bin ranges as a function of `analyser.context.sampleRate` and `analyser.fftSize` (computed per frame so it auto-adjusts):

| Band | Hz range |
|---|---|
| `sub` | 0 - 80 |
| `low` | 80 - 200 |
| `mid_low` | 200 - 400 |
| `mid` | 400 - 2000 |
| `mid_high` | 2000 - 5000 |
| `high` | 5000+ |
| `full` | all |

### Runtime sampler

`MasterBusSampler` generalizes to a multi-bus sampler keyed on `(track, profile)` tuples:

```ts
// Per frame:
//   1. Walk the rig, collect unique keys: `${track ?? 'master'}::${profile ?? 'master_full'}`.
//      Sensitivity is NOT part of the key — it's a per-fixture multiplier
//      applied at fixture-resolution time, not at envelope-computation time.
//   2. For each unique key:
//      a. Resolve analyser: master bus or mixer.getTrackAnalysers(track_id).left.
//      b. analyser.getByteFrequencyData(buf).
//      c. raw = sumBins(buf, profileBandRange) / binCount.
//      d. envelope = prev + (raw - prev) * (raw > prev ? profile.attack : profile.release).
//      e. shaped = pow(envelope, profile.gamma).
//      f. gated = shaped > profile.gate ? shaped : 0.
//      g. envelopeByKey[key] = gated; persist envelope as new prev.
//   3. masterLevel / masterLowLevel computed as today (no change to global path).
//   4. Per fixture:
//      a. raw = envelopeByKey[fixture's key].
//      b. scaled = raw * (fixture.audio_sensitivity ?? 1.0).
//      c. audioByFixture[fixture.id] = Math.min(1, scaled).   // saturate at 1.0
```

The cost scales with **unique `(track, profile)` pairs the rig references**, not with fixture count. Eight fixtures all on `(drums-stem, kick)` = one envelope computation, eight reads. Each of those eight fixtures may carry its own sensitivity multiplier — that's a single multiply + clamp at fixture-resolution time, free relative to the analyser sample. The `getByteFrequencyData` call is the dominant cost per analyser; everything downstream is trivial arithmetic.

Master-bus envelopes (`masterLevel`, `masterLowLevel`) are still computed unconditionally — keeps the global path free of routing-config dependencies and is cheap (the master analyser is the same one we already use).

### Scene API

`SceneContext` extends with one field; everything else stays identical:

```ts
interface SceneContext {
  // unchanged — global path. Scenes that don't care about routing use these.
  masterLevel: number
  masterLowLevel: number

  // unchanged — beat data from pre-analysis
  beatIndex: number
  beatAge: number
  lastBeatIntensity: number
  isPlaying: boolean

  // NEW — per-fixture audio after routing + profile shaping. Empty record
  // when no fixtures are routed; scenes that consume this should fall back
  // to masterLevel for unrouted fixtures.
  audioByFixture: Record<string, number>
}
```

Three scene patterns now coexist cleanly:

```ts
// Global — every fixture sees overall energy. Today's behavior.
for (const s of states) s.intensity = 0.15 + 0.85 * context.masterLowLevel

// Per-fixture — each fixture reacts to its routed track+profile.
for (const s of states) {
  const audio = context.audioByFixture[s.id] ?? context.masterLevel
  s.intensity = 0.25 + 0.75 * audio
}

// Mixed — base wash on master, accent on routed.
for (const s of states) {
  const wash = 0.2 * context.masterLevel
  const punch = 0.6 * (context.audioByFixture[s.id] ?? 0)
  s.intensity = 0.15 + wash + punch
}
```

Existing scenes (the three audio-reactive ones in `audio-scenes.ts`) keep working unchanged — they consume `masterLevel` / `masterLowLevel` and don't care about routing. They can be retrofitted to the per-fixture path opportunistically; not a forced migration.

### Routing surface

Two ways to set routing, in priority order:

1. **Chat tool** (MVP): `light_show.route_fixture(fixture_id, track_id?, profile?, sensitivity?)` registered on the plugin's chat surface. User says "route the front-left par to the bass track, kick profile, sensitivity 1.5" — agent looks up the fixture by label, looks up the track by name, calls the tool, the tool issues a row update via the engine's plugin_api. Leverages existing chat infrastructure — no new UI surface. Each kwarg is independent; passing only `sensitivity=0.7` adjusts the multiplier without changing track or profile.
2. **Properties panel** (deferred): clicking a fixture in the 3D preview opens a sidebar with track + profile dropdowns. Real UI work; fits the larger "fixture properties" panel that doesn't exist yet. Post-MVP.

DB-edited routing also works (the user has already edited `light_show__fixtures` directly to pin the RockPar 50 to address 1) but isn't a primary surface — chat-tool covers the common case more ergonomically.

---

## Implementation

### Engine changes

`scenecraft-engine/src/scenecraft/db.py`:

```python
# Add to the existing migration that creates light_show__fixtures
ALTER TABLE light_show__fixtures ADD COLUMN audio_track_id TEXT REFERENCES audio_tracks(id) ON DELETE SET NULL;
ALTER TABLE light_show__fixtures ADD COLUMN audio_profile TEXT;
ALTER TABLE light_show__fixtures ADD COLUMN audio_sensitivity REAL;
CREATE INDEX IF NOT EXISTS idx_light_show_fixtures_audio_track ON light_show__fixtures(audio_track_id);
```

The migration must be idempotent — `oktoberfest_show_01` and `test` already need to be brought up to the existing schema before this migration can run. That's a separate cleanup task already noted in the previous design pass; this design assumes it lands first.

`scenecraft-engine/src/scenecraft/plugins/light_show/routes.py`:

- `GET /api/projects/:name/plugins/light_show/fixtures` — return rows now include `audio_track_id`, `audio_profile` fields.
- `PUT /api/projects/:name/plugins/light_show/fixtures` — bulk upsert accepts the new fields.
- `POST /api/projects/:name/plugins/light_show/fixtures/:id/audio` — single-fixture routing update; powers the chat tool.

`scenecraft-engine/src/scenecraft/plugins/light_show/chat_tools.py` (new or existing):

```python
@tool(name="route_fixture", plugin="light_show")
def route_fixture(
    fixture_id: str,
    track_id: str | None = None,
    profile: str | None = None,
    sensitivity: float | None = None,
) -> dict:
    """Route a light_show fixture's audio reactivity to a specific track
    and/or instrument profile, optionally scaling the response with a
    linear sensitivity multiplier. Pass None for any kwarg to clear that
    field (track → master bus; profile → master_full; sensitivity → 1.0)."""
    # validation:
    #   - profile in PROFILE_NAMES
    #   - track_id exists in audio_tracks
    #   - sensitivity is finite, non-negative; warn (don't reject) if > 4.0
    # call plugin_api.upsert_light_show_fixture_audio(
    #     fixture_id, track_id, profile, sensitivity)
    # return updated row
```

Engine-side profile name validation requires a constant list shared with the frontend. Two options: hardcode the same list in Python (drift risk) or expose it as an HTTP endpoint the frontend reads at startup (DRY but more plumbing). For MVP, hardcode in both — drift concern is small at 8 names.

### Frontend changes

`src/plugins/light_show/audio-profiles.ts` (new):

```ts
// The PROFILES record from the Solution section, plus:

export function profileBandRange(profile: AudioProfile, sampleRate: number, fftSize: number): [number, number] {
  // Returns [startBin, endBin] for sumBins to walk.
}

export function applyProfileEnvelope(
  prev: number,
  raw: number,
  profile: AudioProfile,
): number {
  const env = prev + (raw - prev) * (raw > prev ? profile.attack : profile.release)
  const shaped = Math.pow(env, profile.gamma)
  return shaped > profile.gate ? shaped : 0
}

export const PROFILE_NAMES = Object.keys(PROFILES) as readonly string[]
```

`src/plugins/light_show/scene-types.ts`:

```ts
export interface SceneContext {
  // ... existing fields ...
  audioByFixture: Record<string, number>
}
```

`src/plugins/light_show/LightShow3DPanel.tsx` — `MasterBusSampler` becomes a multi-bus sampler. Reads the rig + AudioMixer per frame, walks unique `(track, profile)` keys, samples each, writes envelopes to a ref. SceneRunner reads the ref into `audioByFixture` on each `apply` call.

`src/plugins/light_show/light-show-client.ts` — fixture API types extend with `audioTrackId`, `audioProfile`, `audioSensitivity`. Existing rig fetch/upsert handlers wire these through.

`src/plugins/light_show/audio-scenes.ts` — optionally retrofit `kick_pulse` and `beat_strobe` to consume per-fixture audio with master fallback. Not required for the feature to ship; existing scenes keep working unchanged. A new scene like `routed_pulse` that fully exercises per-fixture routing makes a good MVP demo.

### Migration

For the dev-box `big_words` project: the migration runs on engine startup, fixtures get null routing, behavior unchanged. User then uses the chat tool (or direct DB edit, as today) to route fixtures.

For projects with stale schemas (`oktoberfest_show_01`, `test`): the prior schema migration must complete first. Out of scope here.

---

## Benefits

- **Per-fixture musical differentiation.** The realistic stage-lighting use case ("front pars on kick, side movers on bass") becomes one chat message instead of a custom scene per rig.
- **Profiles encapsulate envelope design.** A user (or chat agent) doesn't have to think about attack/release/gamma — they pick "kick" or "bass" and it sounds right. The envelope shapes are tuned once, in one file.
- **Coexists with global behavior.** Scenes that don't care about routing keep working. No forced migration of existing scenes.
- **Sampling cost scales sublinearly.** N fixtures all on the same `(track, profile)` = one envelope, N reads. Adding fixtures doesn't proportionally increase per-frame cost.
- **Profile abstraction is composable.** Same profile + different track = different sound source, same shaping. Same track + different profile = same source, different shaping. Two-axis differentiation from one schema column each.
- **No frontend tests blocked.** Existing audio-reactive code is small and the new code is pure-functional (band sum, envelope step, profile lookup) — easy to add unit coverage when we add vitest, but not blocking.

---

## Trade-offs

- **Hardcoded profiles aren't user-customizable at MVP.** A user who wants a slightly snappier `bass` (more like `kick`) can't tune it — they pick `kick` instead, or they wait for DB-backed profiles. Mitigation: 8 presets cover the canonical instrument set; "I want a slow, smooth bass" is `bass`, "I want a snappier bass" is `kick`. Real custom envelopes wait for post-MVP.
- **Profile/track decoupling means combinatorial test surface.** 8 profiles × N tracks = many pairs to potentially debug. Mitigation: per-profile envelope behavior is independent of track content; testing each profile against a known waveform (white noise burst, sine) covers profile correctness, then track routing is just analyser selection.
- **No scene-level `audioByKey` lookup.** A scene that wants "kick-shaped master, applied uniformly" can't ask for it directly — has to either route every fixture to `(master, kick)` or implement the profile shaping inline. Mitigation: the routing path covers it ergonomically; explicit decision to keep API surface narrow (option 1 from the chat-design exchange).
- **DB column drift between projects.** `oktoberfest_show_01` and `test` already lag the schema; this migration adds two more columns to keep in sync. Mitigation: the schema-migration system already needs to handle these stale projects before this design lands; one-time pain.
- **Chat-tool-only routing UX is rough for non-chat users.** A user without the embed chat agent has to edit the DB directly. Mitigation: properties panel is post-MVP and explicitly noted as the UI follow-up; same trade-off the rest of the editor makes today.

---

## Dependencies

- `light_show__fixtures` schema (M17 design) — already in place on `big_words`.
- AudioMixer per-track analysers (CHANGELOG `0.23.0`) — already in place.
- `MasterBusSampler` (commit `d6264fa`, version `0.24.0`) — already in place; this design generalizes it.
- Project DB migration system (`db.py`) — already in place; this design adds two columns.
- Existing schema must already be migrated on the project being tested (`big_words` is current; `oktoberfest_show_01` and `test` are not).
- Engine plugin chat-tool registration (existing) — extends with `route_fixture`.

---

## Testing Strategy

- **Profile envelope unit tests** (Python or future vitest): for each profile, feed a known input sequence (impulse, ramp, sine), assert envelope output matches expected curve within tolerance. Profiles are pure functions; tests are deterministic.
- **Sampler integration test**: mock AudioMixer with synthetic analysers, instantiate sampler with a 4-fixture rig referencing 2 unique `(track, profile)` pairs, advance 10 frames, assert `audioByFixture` envelope values match per-pair envelopes.
- **End-to-end smoke**: in `big_words`, route one fixture to a stem, run a scene that reads `audioByFixture`, confirm visible per-fixture differentiation in the 3D preview during playback.
- **Regression test**: existing audio-reactive scenes (`beat_strobe`, `kick_pulse`, `beat_color_chase`) produce identical output for unrouted rigs — `master_full` profile + null track = today's behavior bit-for-bit.

---

## Migration Path

1. Engine: add `audio_track_id` + `audio_profile` + `audio_sensitivity` columns to `light_show__fixtures`. Idempotent ALTER TABLE; runs on next engine startup against any project DB.
2. Engine: extend fixture routes to read/write the new fields. No client breakage — frontend tolerates missing fields today.
3. Engine: add `light_show.route_fixture(...)` chat tool.
4. Frontend: add `audio-profiles.ts` with the 8 presets and helper functions.
5. Frontend: extend `MasterBusSampler` to walk unique `(track, profile)` keys per frame. Compute `audioByFixture` ref. Master path stays unchanged.
6. Frontend: extend `SceneContext` with `audioByFixture`.
7. Frontend: optionally retrofit one or two existing scenes (`kick_pulse` is the natural fit) to demonstrate per-fixture routing. Add a new `routed_pulse` scene as the MVP demo.
8. Build, ship, route the dev-box RockPar 50 + a few moving heads to different stems via the chat tool, confirm visible differentiation.

The migration is purely additive — null defaults preserve existing behavior, no fixture or scene needs to change to keep working. Routing is opt-in per fixture.

---

## Key Design Decisions

### Audio Routing

| Decision | Choice | Rationale |
|---|---|---|
| Routing granularity | Per-fixture | Aligns with MA3-style "Sound" attribute on a fixture; matches user mental model ("this fixture reacts to drums") |
| Storage | Three nullable columns on `light_show__fixtures` (`audio_track_id`, `audio_profile`, `audio_sensitivity`) | Smallest viable; null defaults preserve existing behavior; no separate table needed for the routing relation |
| Master bus reference | `audio_track_id = NULL` | Simpler than a special "master" sentinel row in `audio_tracks`; null is the unambiguous "default" signal |
| Sensitivity placement | Per-fixture column, not in the profile | Profile = engineering decision about an instrument kind (shared); sensitivity = per-installation taste about one fixture (specific). Coupling them would force `kick_loud` / `kick_quiet` profile proliferation for what's a one-axis adjustment |
| Sensitivity range | 0.0..~2.0, default 1.0, output saturated at 1.0 | 0 = clean "mute reactivity" without unrouting; 1.0 = today's behavior unchanged; >1.0 = push toward always-on; saturation prevents accidental clipping above 1.0 from breaking scene math that assumes 0..1 inputs |

### Instrument Profiles

| Decision | Choice | Rationale |
|---|---|---|
| Profile abstraction | Bundles `(band, attack, release, gamma, gate)` into a named preset | User picks "kick" or "bass" instead of dialing 5 parameters; envelope shapes are tuned once in one file |
| MVP customization | Hardcoded TS presets, no DB-backed customization | "MVP before infra"; 8 presets cover the canonical instrument set; DB-backed profile authoring is post-MVP |
| Initial preset count | 8 (`kick`, `bass`, `snare`, `hats`, `guitar`, `vocals`, `pad`, `master_full`) | Covers the standard rock / electronic stage band plus master-bus fallback; more presets are additive when needed |
| Band selection | Inside the profile | Tried `audio_band` as a separate column, dropped — bundling band with envelope shape is conceptually cleaner; "kick" implies "sub-band" |
| `master_full` profile | Reproduces today's master-bus envelope exactly | Migration to explicit profile is a no-op; existing scenes keep producing identical output |

### Scene API

| Decision | Choice | Rationale |
|---|---|---|
| Per-fixture audio shape | `Record<fixture_id, number>` (single scalar after profile shaping) | Profile already chose band + applied envelope; scene doesn't need band metadata |
| Master path | Unchanged (`masterLevel`, `masterLowLevel` stay) | Existing scenes keep working; global behavior is a first-class path, not a fallback |
| Scene-level `audioByKey` | Not added | Routing path covers the use case ergonomically; keeps API surface narrow |
| Mixed scenes | Supported (read both `masterLevel` and `audioByFixture`) | Real lighting design often mixes — base wash on overall energy + accent on routed audio |

### Routing Surface

| Decision | Choice | Rationale |
|---|---|---|
| Primary UX | Chat-tool (`light_show.route_fixture`) | Leverages existing embed chat agent; no new UI surface to design or build |
| Secondary UX | Properties panel (deferred, post-MVP) | Real UI work; deferred until the broader fixture-properties panel is scoped |
| Direct DB edit | Tolerated, not primary | Works today (user already does it for the rig); chat-tool is more ergonomic but not exclusive |

### Sampling Cost

| Decision | Choice | Rationale |
|---|---|---|
| Sampler key | `(track, profile)` tuple | N fixtures on same pair = one sample, N reads; cost scales with unique pairs not fixtures |
| Master path always sampled | Yes | Cheap (existing analyser); avoids routing-config-dependence in the global path |
| Lazy vs eager profile computation | Eager — all referenced pairs computed every frame | Simpler control flow; the cost is dominated by `getByteFrequencyData` which we'd call anyway for each track |

---

## Future Considerations

- **DB-backed profile customization.** Once a real user wants a custom envelope shape that none of the presets approximate, add a `light_show__audio_profiles` table keyed by name; runtime falls back to the hardcoded presets when the table is empty or the name isn't found.
- **Stem-aware track auto-routing.** When stem-splitter lands and a project has labeled stems (`drums`, `bass`, `vocals`, `other`), expose a "route by stem-label" action that auto-assigns fixtures to stems based on heuristics or fixture-group conventions. Saves manual routing for typical setups.
- **Properties-panel UI.** Click-to-route from the 3D preview. Track + profile dropdowns; preview the envelope shape in a small waveform. Real UI work, fits the broader fixture-properties surface.
- **Profile composition.** A profile could optionally chain another profile's envelope as a side-chain — e.g., "bass profile, gated by kick profile" produces "bass that only fires when kick fires." Speculative; revisit if a use case actually needs it.
- **Multi-band per profile.** A profile could expose multiple envelopes (bass+presence, kick+air) and a scene could read multiple per fixture. Currently profiles produce one scalar per fixture per frame; widening to a vector is additive.
- **Scene-DSL audio expressions.** When the scene DSL lands (mirroring GrandMA3 phasers per the M17 design), audio profiles become first-class operands: `intensity = 0.2 + 0.8 * audio.fixture.kick` reads naturally. Today's scenes are TypeScript and consume context fields directly; the DSL design has to incorporate `audioByFixture` semantics.
- **Audio-reactive routing diagnostics.** A debug overlay in the 3D preview that displays each fixture's current envelope value would help dial in profile choices. Cheap to add (just a text label).
- **Profile presets shared between rigs.** A rig template could ship default routing (front pars→kick, side movers→bass) so a user importing the template gets sensible audio reactivity for free. Depends on the rig-template feature, currently absent.

---

**Status**: Proposal — ready to implement. Schema changes are additive and idempotent; profile presets are pure-functional and isolated; scene API extension is non-breaking.
**Recommendation**: Implement in one task spanning both `scenecraft-engine` (schema + chat tool) and `scenecraft` (sampler + scene API + profile presets). Estimated half-day to one-day, including the smoke test against the dev-box rig.
**Related Documents**:
- `agent/design/local.track-contribution-point-and-light-show-plugin.md` — M17 light_show plugin architecture; this design extends the fixtures schema it pinned
- `agent/design/local.audio-streaming-and-mixing.md` — AudioMixer architecture; this design consumes the per-track analysers it created
- `../scenecraft-engine/agent/design/local.hosted-mode-architecture.md` — hosted-mode auth model; orthogonal but referenced for completeness
