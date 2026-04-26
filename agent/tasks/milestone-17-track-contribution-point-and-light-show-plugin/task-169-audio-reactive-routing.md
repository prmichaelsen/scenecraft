# Task 169: Per-Fixture Audio Routing + Instrument Profiles + Sensitivity

**Milestone**: [M17 - Track Contribution Point and Light Show Plugin](../../milestones/milestone-17-track-contribution-point-and-light-show-plugin.md)
**Design Reference**: [Audio-Reactive Routing & Instrument Profiles](../../design/local.audio-reactive-routing.md)
**Estimated Time**: 8 hours (half-day to one day, including smoke test)
**Dependencies**: task-138 (light show backend skeleton — `light_show__fixtures` table), task-140 (3D preview panel — `MasterBusSampler` in `LightShow3DPanel.tsx`). On the dev-box `big_words` project both already exist working, so this task can be exercised in production immediately.
**Status**: Not Started

---

## Objective

Add per-fixture audio reactivity routing to the light_show plugin: each fixture optionally routes its reactivity to a specific audio track (typically a stem) through a named instrument profile (kick / bass / snare / hats / guitar / vocals / pad / master_full) at a per-fixture sensitivity multiplier. Existing audio-reactive scenes that read `masterLevel` keep working bit-for-bit unchanged; new scenes consume `audioByFixture[id]` for per-fixture profile-shaped audio. Profiles are hardcoded TS presets (DB-backed customization deferred). Routing is settable via a `light_show.route_fixture` chat tool (properties-panel UI deferred).

---

## Context

Today's audio-reactive scenes (`beat_strobe`, `kick_pulse`, `beat_color_chase` in `src/plugins/light_show/audio-scenes.ts`) drive every fixture from the master bus's full-spectrum and low-band RMS envelopes. That's correct as a default but flat aesthetically — every fixture pulses the same way on every kick. Real lighting design routes specific musical elements to specific fixtures: front pars on kick, side movers on bass, hat fixtures on high-end, vocals colour the back wash.

The plumbing for per-track sampling already exists. CHANGELOG `0.23.0` shipped per-track analysers — every track in the AudioMixer has `trackGain → ChannelSplitter → {analyserL, analyserR}`, accessible via `mixer.getTrackAnalysers(id)`. Today only the master analyser is consumed by `MasterBusSampler`. This task generalises the sampler to walk unique `(track, profile)` pairs in the rig, computes one envelope per pair per frame, and per-fixture multiplies by that fixture's sensitivity before storing in `audioByFixture`. The cost scales with **unique pairs**, not fixture count — eight fixtures all on `(drums-stem, kick)` cost one sample, eight reads.

This is a cross-repo task: schema migration + chat tool + plugin_api method live in `scenecraft-engine`; profile presets + sampler generalisation + scene API live in `scenecraft`. Implement in one PR-pair; engine side ships first so the frontend has fields to read.

---

## Steps

### 1. Engine: schema migration

In `scenecraft-engine/src/scenecraft/db.py`, extend the migration that creates `light_show__fixtures` with three additive nullable columns:

```sql
ALTER TABLE light_show__fixtures ADD COLUMN audio_track_id TEXT REFERENCES audio_tracks(id) ON DELETE SET NULL;
ALTER TABLE light_show__fixtures ADD COLUMN audio_profile TEXT;
ALTER TABLE light_show__fixtures ADD COLUMN audio_sensitivity REAL;
CREATE INDEX IF NOT EXISTS idx_light_show_fixtures_audio_track ON light_show__fixtures(audio_track_id);
```

All three columns nullable; null defaults preserve today's behaviour exactly. Idempotent (`IF NOT EXISTS` semantics if your migration framework supports; otherwise the migration system's version gate handles re-run safety). Migration must run cleanly against existing project DBs that already have `light_show__fixtures` populated (e.g. `big_words`). Stale projects (`oktoberfest_show_01`, `test`) have a pre-existing schema-drift problem — that's separate cleanup, not this task.

### 2. Engine: extend fixture routes

In `scenecraft-engine/src/scenecraft/plugins/light_show/routes.py`:

- `GET /api/projects/:name/plugins/light_show/fixtures` — return rows now include `audio_track_id`, `audio_profile`, `audio_sensitivity` fields. Null when unset.
- `PUT /api/projects/:name/plugins/light_show/fixtures` (bulk upsert) — accept the three new fields; pass through to `plugin_api.upsert_light_show_fixtures`.

In `scenecraft-engine/src/scenecraft/plugins/light_show/plugin_api.py` (or wherever the plugin_api lives), add:

```python
def upsert_light_show_fixture_audio(
    project_dir: Path,
    fixture_id: str,
    track_id: str | None,
    profile: str | None,
    sensitivity: float | None,
) -> dict:
    """Update only the audio routing fields on a single fixture row.
    None means 'clear this field' (track → master bus, profile → master_full,
    sensitivity → 1.0 default at runtime). Returns the updated row."""
```

Add the corresponding endpoint:

- `POST /api/projects/:name/plugins/light_show/fixtures/:id/audio` — body `{track_id?, profile?, sensitivity?}`; calls `upsert_light_show_fixture_audio`; returns updated row.

### 3. Engine: chat tool

In `scenecraft-engine/src/scenecraft/plugins/light_show/chat_tools.py`:

```python
PROFILE_NAMES = {"kick", "bass", "snare", "hats", "guitar", "vocals", "pad", "master_full"}

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
    field (track → master bus; profile → master_full; sensitivity → 1.0).

    Args:
        fixture_id: ID of the fixture in the current project's
            light_show__fixtures table.
        track_id: ID of an audio track in the project, or None to use
            master bus.
        profile: One of {kick, bass, snare, hats, guitar, vocals, pad,
            master_full}, or None for default (master_full).
        sensitivity: Linear gain multiplier 0.0..~2.0, default 1.0.
            Output is saturated at 1.0 in the runtime regardless of input.
    """
    # Validation
    if profile is not None and profile not in PROFILE_NAMES:
        raise ValueError(f"profile must be one of {PROFILE_NAMES}")
    if sensitivity is not None:
        if not math.isfinite(sensitivity) or sensitivity < 0:
            raise ValueError("sensitivity must be finite and non-negative")
        if sensitivity > 4.0:
            warn(f"sensitivity={sensitivity} is unusually high; output saturates at 1.0")
    # track_id existence is verified by the upsert (FK constraint or explicit lookup)

    project_dir = current_project_dir()
    return plugin_api.upsert_light_show_fixture_audio(
        project_dir, fixture_id, track_id, profile, sensitivity,
    )
```

Each kwarg is independent; passing only `sensitivity=0.7` adjusts the multiplier without disturbing track or profile.

### 4. Frontend: profile presets module

Create `scenecraft/src/plugins/light_show/audio-profiles.ts`:

```ts
export type AudioBand = 'sub' | 'low' | 'mid_low' | 'mid' | 'mid_high' | 'high' | 'full'

export interface AudioProfile {
  band: AudioBand
  /** Envelope alpha 0..1; 0.95 ≈ 3ms (instant), 0.30 ≈ 150ms (smooth). */
  attack: number
  /** Envelope alpha 0..1; 0.05 ≈ 600ms (slow), 0.15 ≈ 200ms (medium). */
  release: number
  /** Power curve; <1 = punchy/expanded, 1 = linear, >1 = compressed. */
  gamma: number
  /** Floor 0..1; output below this clamps to 0. */
  gate: number
}

export const PROFILES: Record<string, AudioProfile> = {
  kick:        { band: 'sub',     attack: 0.95, release: 0.15, gamma: 0.6, gate: 0.0  },
  bass:        { band: 'low',     attack: 0.30, release: 0.05, gamma: 1.0, gate: 0.0  },
  snare:       { band: 'mid_low', attack: 0.95, release: 0.10, gamma: 0.7, gate: 0.05 },
  hats:        { band: 'high',    attack: 0.95, release: 0.30, gamma: 0.5, gate: 0.10 },
  guitar:      { band: 'mid',     attack: 0.50, release: 0.08, gamma: 0.8, gate: 0.05 },
  vocals:      { band: 'mid',     attack: 0.30, release: 0.05, gamma: 1.0, gate: 0.03 },
  pad:         { band: 'full',    attack: 0.20, release: 0.03, gamma: 1.0, gate: 0.0  },
  master_full: { band: 'full',    attack: 0.85, release: 0.08, gamma: 1.0, gate: 0.0  },
}

export const PROFILE_NAMES = Object.keys(PROFILES)

const BAND_RANGES_HZ: Record<AudioBand, [number, number] | 'full'> = {
  sub:      [0,    80],
  low:      [80,   200],
  mid_low:  [200,  400],
  mid:      [400,  2000],
  mid_high: [2000, 5000],
  high:     [5000, Infinity],
  full:     'full',
}

/** Returns [startBin, endBin) for the given band on the given analyser. */
export function profileBinRange(
  band: AudioBand,
  sampleRate: number,
  fftSize: number,
): [number, number] {
  const binCount = fftSize / 2
  const range = BAND_RANGES_HZ[band]
  if (range === 'full') return [0, binCount]
  const binHz = sampleRate / fftSize
  const start = Math.max(0, Math.floor(range[0] / binHz))
  const end = Math.min(binCount, Math.ceil(range[1] / binHz))
  return [start, Math.max(start + 1, end)]
}

/** RMS over a bin range of a Uint8 frequency-data buffer. */
export function bandRms(buf: Uint8Array, start: number, end: number): number {
  let sum = 0
  const n = end - start
  if (n <= 0) return 0
  for (let i = start; i < end; i++) {
    const v = buf[i] / 255
    sum += v * v
  }
  return Math.sqrt(sum / n)
}

/** One envelope step: asymmetric attack/release, then gamma curve, then gate. */
export function applyProfileEnvelope(
  prev: number,
  raw: number,
  profile: AudioProfile,
): number {
  const alpha = raw > prev ? profile.attack : profile.release
  const env = prev + (raw - prev) * alpha
  const shaped = Math.pow(env, profile.gamma)
  return shaped > profile.gate ? shaped : 0
}
```

Keep `PROFILE_NAMES` synchronised with the engine-side `PROFILE_NAMES` constant (drift risk is small at 8 names; review on every preset change).

### 5. Frontend: extend client types

In `scenecraft/src/plugins/light_show/light-show-client.ts` (or wherever `FixtureRow` is defined), extend the type:

```ts
export interface FixtureRow {
  // ... existing fields ...
  audio_track_id: string | null
  audio_profile: string | null
  audio_sensitivity: number | null
}
```

In `scenecraft/src/plugins/light_show/fixtures.ts`, extend `FixtureDef` with the same fields:

```ts
export interface FixtureDef {
  // ... existing fields ...
  audioTrackId?: string | null
  audioProfile?: string | null
  audioSensitivity?: number | null
}
```

The fetcher (`fetchFixtures`) maps `FixtureRow` → `FixtureDef` and passes the three fields through. Hardcoded `RIG` fallback leaves them undefined (fall back to defaults at runtime).

### 6. Frontend: generalise MasterBusSampler

Rename `MasterBusSampler` to `AudioReactivitySampler` (or keep the name and refactor in place — preserve the existing master-bus refs as outputs). In `scenecraft/src/plugins/light_show/LightShow3DPanel.tsx`:

- Add a third ref alongside `masterLevelRef` and `masterLowLevelRef`:
  ```ts
  const audioByFixtureRef = useRef<Record<string, number>>({})
  ```
- Inside the per-frame `useFrame`:
  1. Compute today's master-bus envelopes exactly as today (no change to global path; preserves existing scene behaviour bit-for-bit).
  2. Walk `rigRef.current` and collect unique `(track, profile)` keys: ``${f.audioTrackId ?? 'master'}::${f.audioProfile ?? 'master_full'}``. Skip fixtures where both fields are null AND profile would be `master_full` (they don't need a per-key envelope; they'll use the master refs). Optimization, not correctness — feel free to skip and always compute.
  3. Maintain a `Map<string, number>` of previous envelope values, one entry per `(track, profile)` key. New keys initialise to 0; keys no longer referenced are dropped (memory cleanup).
  4. For each unique key:
     - `analyser` = `mixer.getTrackAnalysers(track_id).left` if track set, else `mixer.getMasterAnalysers().left`. If null (mixer not yet mounted), bleed prev value to 0 like the existing master path.
     - Allocate / reuse a `Uint8Array` per analyser sized to `analyser.frequencyBinCount` (cache by analyser identity to avoid per-frame allocations).
     - `analyser.getByteFrequencyData(buf)`.
     - `[start, end] = profileBinRange(profile.band, analyser.context.sampleRate, analyser.fftSize)`.
     - `raw = bandRms(buf, start, end)`.
     - `next = applyProfileEnvelope(prev, raw, profile)`.
     - Store `next` as the new prev for this key.
  5. Build a fresh `audioByFixture` record:
     - For each fixture in `rigRef.current`:
       - `key = ${f.audioTrackId ?? 'master'}::${f.audioProfile ?? 'master_full'}`
       - `raw = envelopeByKey[key] ?? 0`
       - `sensitivity = f.audioSensitivity ?? 1.0`
       - `audioByFixture[f.id] = Math.min(1, raw * sensitivity)`
  6. Write to `audioByFixtureRef.current` at end of frame.

Cost considerations:
- The master analyser's `getByteFrequencyData` is already called once per frame today — that doesn't change.
- Each unique `(track, profile)` pair adds one `getByteFrequencyData` + one band sum + one envelope step. At typical rig sizes (≤16 fixtures, ≤4 unique pairs) this is negligible.
- Per-fixture multiply + clamp is free relative to the analyser sample.
- Buffer caching by analyser identity avoids per-frame `Uint8Array` allocation churn.

### 7. Frontend: extend SceneContext

In `scenecraft/src/plugins/light_show/scene-types.ts`, add one field:

```ts
export interface SceneContext {
  // ... existing fields unchanged: masterLevel, masterLowLevel, beatIndex,
  //     beatAge, lastBeatIntensity, isPlaying ...

  /** Per-fixture audio envelope after track + profile + sensitivity routing.
   *  Empty record on rigs with no routed fixtures; scenes that consume
   *  this should fall back to masterLevel for unrouted/unmapped fixtures. */
  audioByFixture: Record<string, number>
}
```

Update `SceneRunner` in `LightShow3DPanel.tsx` to read from `audioByFixtureRef.current` and include it on the per-frame `SceneContext` it passes to `scene.apply`. Preserve all existing context fields.

### 8. Frontend: add a demo scene that exercises per-fixture routing

In `scenecraft/src/plugins/light_show/audio-scenes.ts`, add one new scene:

```ts
const routedPulse: SceneDef = {
  id: 'routed_pulse',
  label: 'Routed Pulse (per-fixture audio)',
  apply: (_t, states, context) => {
    for (const s of states) {
      const audio = context.audioByFixture[s.id] ?? context.masterLevel
      if (s.role === 'par') {
        s.color = [1, 0.2, 0.2]
        s.intensity = 0.15 + 0.85 * audio
      } else {
        s.color = [1, 0.6, 0.3]
        s.intensity = 0.3 + 0.7 * audio
      }
      s.pan = 0
      s.tilt = 0
    }
  },
}

// Add to the SCENES export.
```

Existing scenes (`beat_strobe`, `kick_pulse`, `beat_color_chase`) keep reading `masterLevel` / `masterLowLevel` and stay unchanged — they're explicitly the "global behaviour" path. Don't retrofit them in this task; they can be opportunistically migrated to per-fixture later if a use case justifies it.

### 9. Smoke test against the dev-box `big_words` project

`big_words` already has:
- A RockPar 50 par fixture (`fixture_5`) pinned to DMX address 1, channel count 6, manually configured.
- Multiple stems (vocals isolation has run for at least some songs; check `audio_tracks` table for actual track IDs).

Test plan:
1. Build engine + frontend; restart engine (you, the user, restart per the no-auto-restart policy).
2. Open `https://patrycllc.scenecraft.online`, navigate to `big_words`'s editor, hard-refresh.
3. Confirm the LightShow status pill shows `(live)`.
4. Via the chat agent: "route fixture_5 to the bass track using the kick profile at sensitivity 1.5". Confirm via `GET /api/projects/big_words/plugins/light_show/fixtures` that the row updates.
5. Set scene to `routed_pulse`. Plug in ENTTEC, click DMX Output, pick the FTDI port.
6. Play audio. Verify the RockPar 50 pulses on bass-track kicks. Try other (track, profile) combinations via the chat agent and confirm visible per-fixture differentiation.

### 10. Regression check on existing scenes

Run `kick_pulse` and `beat_strobe` with no fixtures routed (default null fields). Output must be visually identical to the pre-task version — this is a smoke test of the "master_full profile = today's behaviour" claim. If anything looks different, audit the master-bus path; the global behaviour must not regress.

---

## Verification

- [ ] `light_show__fixtures` has three new nullable columns: `audio_track_id`, `audio_profile`, `audio_sensitivity` (verify via `PRAGMA table_info(light_show__fixtures)` on the project DB).
- [ ] Index `idx_light_show_fixtures_audio_track` exists.
- [ ] Migration is idempotent — re-running engine startup against an already-migrated project is a no-op.
- [ ] `GET /api/projects/:name/plugins/light_show/fixtures` returns the three new fields (null on existing rows).
- [ ] `PUT /api/projects/:name/plugins/light_show/fixtures` accepts the three new fields (verified by upserting a row with non-null values and confirming via subsequent GET).
- [ ] `POST /api/projects/:name/plugins/light_show/fixtures/:id/audio` accepts `{track_id?, profile?, sensitivity?}` body and updates the row.
- [ ] `light_show.route_fixture` chat tool registered, callable, validates inputs (rejects unknown profile, rejects negative/non-finite sensitivity, warns on sensitivity > 4.0).
- [ ] `audio-profiles.ts` exports the 8 presets with the values specified in the design.
- [ ] `master_full` profile reproduces today's master-bus envelope behaviour bit-for-bit when applied (verified by routing a fixture to (master, master_full, 1.0) and confirming output matches `masterLevel` for that frame).
- [ ] `bandRms` and `applyProfileEnvelope` are pure functions (deterministic, no side effects).
- [ ] `profileBinRange` correctly maps band → [start, end) bins for the test sample rates 44100 and 48000 with fftSize 2048.
- [ ] `MasterBusSampler` (or its renamed successor) walks unique `(track, profile)` keys, computes one envelope per key, multiplies per fixture by sensitivity, saturates at 1.0, writes to `audioByFixtureRef`.
- [ ] Fixtures with all three audio columns null produce `audioByFixture[id] = (master_full envelope) * 1.0`, identical to current `masterLevel`.
- [ ] Fixtures with a routed track + non-default profile produce per-key envelope output (verified visually with `routed_pulse` scene + chat-agent routing on the dev-box rig).
- [ ] Sensitivity multiplier scales output linearly up to 1.0 saturation (verified by routing the same fixture at sensitivity 0.5 vs 1.0 vs 1.5 and observing output magnitude).
- [ ] Sensitivity = 0.0 produces `audioByFixture[id] = 0` regardless of routing (clean mute).
- [ ] `SceneContext.audioByFixture` populated on every scene tick.
- [ ] `routed_pulse` scene visibly differentiates per-fixture intensity when fixtures are routed to distinct (track, profile) pairs.
- [ ] Existing scenes (`beat_strobe`, `kick_pulse`, `beat_color_chase`) produce visually identical output to the pre-task version when no fixtures are routed (regression).
- [ ] Per-frame cost has not regressed measurably for unrouted rigs (master path unchanged).
- [ ] `Uint8Array` for `getByteFrequencyData` is allocated once per analyser, cached for reuse — no per-frame allocation churn (verified by inspecting the sampler code, no `new Uint8Array` inside the per-frame loop).
- [ ] Engine and frontend `PROFILE_NAMES` lists agree (manually compared).

---

## Expected Output

**Files Modified (scenecraft-engine):**
- `src/scenecraft/db.py` — three ALTER TABLE statements on `light_show__fixtures` migration; new index.
- `src/scenecraft/plugins/light_show/routes.py` — fixture GET/PUT pass through three new fields; new POST `/fixtures/:id/audio` endpoint.
- `src/scenecraft/plugins/light_show/plugin_api.py` — new `upsert_light_show_fixture_audio` method.
- `src/scenecraft/plugins/light_show/chat_tools.py` (or wherever chat tools live) — new `route_fixture` tool registration.

**Files Created (scenecraft):**
- `src/plugins/light_show/audio-profiles.ts` — preset table, helper functions, type exports.

**Files Modified (scenecraft):**
- `src/plugins/light_show/light-show-client.ts` — `FixtureRow` extended with three fields.
- `src/plugins/light_show/fixtures.ts` — `FixtureDef` extended with three fields; `RIG` fallback unchanged.
- `src/plugins/light_show/LightShow3DPanel.tsx` — `MasterBusSampler` generalised; `audioByFixtureRef` added; SceneRunner threads `audioByFixture` into `SceneContext`.
- `src/plugins/light_show/scene-types.ts` — `SceneContext` extended with `audioByFixture`.
- `src/plugins/light_show/audio-scenes.ts` — new `routed_pulse` scene appended to `SCENES`.

**No files modified for existing scenes** (`beat_strobe`, `kick_pulse`, `beat_color_chase`) — they continue using `masterLevel` / `masterLowLevel`, fully backward-compatible.

---

## Key Design Decisions

### Audio Routing

| Decision | Choice | Rationale |
|---|---|---|
| Routing granularity | Per-fixture | Matches MA3-style "Sound" attribute; matches user mental model ("this fixture reacts to drums") |
| Storage | Three nullable columns on `light_show__fixtures` | Smallest viable; null defaults preserve existing behaviour; no separate routing table |
| Master bus reference | `audio_track_id = NULL` | Simpler than a sentinel "master" row in `audio_tracks`; null is the unambiguous default |

### Instrument Profiles

| Decision | Choice | Rationale |
|---|---|---|
| Profile abstraction | Named bundle of `(band, attack, release, gamma, gate)` | User picks "kick" or "bass", not 5 numeric knobs; envelope shapes tuned once in one file |
| MVP customisation | Hardcoded TS presets, no DB-backed customisation | "MVP before infra"; 8 presets cover canonical instrument set; DB-backed authoring is post-MVP |
| Initial preset count | 8 (`kick`, `bass`, `snare`, `hats`, `guitar`, `vocals`, `pad`, `master_full`) | Covers standard rock/electronic stage band plus master-bus fallback; more presets are additive |
| Band selection | Inside the profile | `audio_band` as a separate column was tried and discarded; bundling is cleaner |
| `master_full` profile | Reproduces today's master-bus envelope exactly | Migration is bit-for-bit a no-op for unrouted fixtures |

### Sensitivity

| Decision | Choice | Rationale |
|---|---|---|
| Placement | Per-fixture column, NOT in the profile | Profile = engineering decision about an instrument kind (shared); sensitivity = per-installation taste about one fixture (specific). Coupling them would force `kick_loud` / `kick_quiet` proliferation |
| Range | 0.0..~2.0, default 1.0, output saturated at 1.0 | 0 = clean "mute reactivity" without unrouting; 1.0 = today's behaviour; >1.0 = push toward always-on; saturation prevents accidental clipping above 1.0 from breaking 0..1 scene math |
| Application point | At fixture-resolution time, NOT inside the per-(track, profile) envelope | Eight fixtures with eight different sensitivities on the same (track, profile) cost one envelope sample, not eight |

### Scene API

| Decision | Choice | Rationale |
|---|---|---|
| Per-fixture audio shape | `Record<fixture_id, number>` (single scalar) | Profile already chose band + applied envelope + gamma + gate; sensitivity already applied; scene gets one number per fixture |
| Master path | Unchanged (`masterLevel`, `masterLowLevel` stay) | Existing scenes keep working; global behaviour is a first-class path, not a fallback |
| Scene-level `audioByKey` | Not added | Routing path covers the use case ergonomically; keeps API surface narrow |
| Mixed scenes | Supported (read both `masterLevel` and `audioByFixture`) | Real lighting design often mixes — base wash on overall energy + accent on routed audio |

### Routing Surface

| Decision | Choice | Rationale |
|---|---|---|
| Primary UX | Chat tool (`light_show.route_fixture`) | Leverages existing embed chat agent; no new UI surface |
| Secondary UX | Properties panel (deferred, post-MVP) | Real UI work; deferred until broader fixture-properties panel is scoped |
| Direct DB edit | Tolerated, not primary | Works today; chat tool is more ergonomic but not exclusive |

### Sampling

| Decision | Choice | Rationale |
|---|---|---|
| Sampler key | `(track, profile)` tuple | N fixtures on same pair = one sample, N reads; cost scales with unique pairs not fixtures |
| Master path always sampled | Yes | Cheap (existing analyser); avoids routing-config-dependence in global path |
| `Uint8Array` lifecycle | Cached per analyser, reused per frame | Avoids per-frame allocation churn at scale |

---

## Common Issues and Solutions

### Issue 1: Migration runs but rows still missing the new fields

**Symptom**: `GET .../fixtures` returns rows without `audio_track_id`, `audio_profile`, `audio_sensitivity`.
**Solution**: Migration framework didn't pick up the new ALTER. Verify the migration's version was bumped and the framework's version-gate logic re-runs. On the dev-box `big_words`, you may need to manually apply the ALTER once if the framework only runs on first-time creation.

### Issue 2: Stale-schema projects (`oktoberfest_show_01`, `test`) fail to start

**Symptom**: Engine errors on those projects with `no such column: dmx_address` or similar.
**Solution**: This task assumes the prior schema migration already landed on those projects. They have a pre-existing drift problem flagged in earlier session notes; resolve that separately before adding these columns.

### Issue 3: `mixer.getTrackAnalysers(track_id)` returns null mid-render

**Symptom**: `audioByFixture[id]` stays at 0 for routed fixtures even with audio playing.
**Solution**: Mixer track may be initialising late, or the `track_id` doesn't match a track in the current project. Bleed prev to 0 (same defensive behaviour as the existing master path) and continue. Verify the routed `track_id` exists in `audio_tracks`.

### Issue 4: Fixture sensitivity > 1.0 produces visible clipping artefacts

**Symptom**: Light intensity feels "stuck on full" during loud sections.
**Solution**: Expected behaviour — saturation at 1.0 is intentional. Lower sensitivity, or accept the always-on-during-loud-sections character (often desirable for "always-driving" looks).

### Issue 5: Existing scenes look subtly different after the change

**Symptom**: `kick_pulse` or `beat_strobe` produce different output than before the task lands.
**Solution**: The master-bus path was inadvertently disturbed. The global path must remain bit-for-bit unchanged — review the sampler refactor for changes to how `masterLevel` / `masterLowLevel` are computed; only the new `audioByFixture` path should be additive.

---

## Notes

- The bulk of the runtime work happens in `LightShow3DPanel.tsx`'s `MasterBusSampler` (or successor name). That's the load-bearing change; everything else is plumbing.
- This task is intentionally MVP — DB-backed profile customisation, properties-panel UI, multi-band per-profile output, and audio-reactive scene-DSL operands are all explicitly deferred per the design's *Future Considerations* section.
- The dev-box has all dependencies in place today (`big_words` has the schema, the panel exists, the AudioMixer has per-track analysers). Smoke test can run end-to-end without waiting for tasks 138/140 to complete formally.
- Keep `PROFILE_NAMES` synchronised between engine (Python) and frontend (TS). Drift risk is small at 8 names; review on every preset change.
- No frontend tests yet (`vitest` not installed per project memory). When `vitest` lands, profile envelope unit tests are the natural first-pass coverage.

---

**Next Task**: TBD
**Related Design Docs**:
- [Audio-Reactive Routing & Instrument Profiles](../../design/local.audio-reactive-routing.md)
- [Track Contribution Point + Light Show Plugin (M17)](../../design/local.track-contribution-point-and-light-show-plugin.md)
- [Audio Streaming and Mixing](../../design/local.audio-streaming-and-mixing.md)

**Estimated Completion Date**: TBD
