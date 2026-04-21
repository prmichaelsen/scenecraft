# Task 91: Multi-Track Mixdown + Equal-Power Crossfade

**Milestone**: [M9 - Audio Tracks and Audio Clips](../../milestones/milestone-9-audio-tracks-and-clips.md)  
**Design Reference**: [Audio Tracks and Audio Clips](../../design/local.audio-tracks-and-clips.md)  
**Estimated Time**: 6-8 hours  
**Dependencies**: Task 82 (schema)  
**Status**: Not Started  

---

## Objective

Replace `_mux_audio` in `narrative.py` with a multi-track mixdown that evaluates per-clip and per-track volume curves, detects same-track overlaps and applies equal-power crossfades, sums into a master, and muxes with the final video.

---

## Context

Design doc "Render Pipeline" and "Overlap Handling & Crossfades" are canonical. This is where the bulk of the audio rendering lives.

---

## Steps

### 1. `src/scenecraft/audio/mixdown.py`

```python
def render_project_audio(project_dir: Path, project_sr: int,
                         total_seconds: float) -> Path:
    """Returns a WAV path with all audio tracks mixed down."""
```

High-level:
1. Allocate `master = np.zeros((2, int(total_seconds*project_sr)), dtype=np.float32)`
2. For each enabled, non-muted audio track:
   a. Load clips, sorted by start_time
   b. For each clip: load samples, apply `source_offset` + length, evaluate clip curve → linear gain per sample → multiply
   c. Mix into `track_buf` at `start_time`; on overlap with an already-mixed clip, apply equal-power crossfade over the overlap region
   d. Evaluate track curve (seconds axis) → linear gain → multiply `track_buf`
   e. Apply track mute if any (full zero)
3. Sum all `track_buf` into `master`
4. Optional: peak-limiter at -0.1 dBFS to prevent clipping
5. Write WAV

### 2. `src/scenecraft/audio/curves.py`

```python
def evaluate_curve(curve_json: str, t: np.ndarray, x_normalised: bool,
                   length: float | None = None) -> np.ndarray:
    """Sample a dB curve at t positions. Returns dB values.
    If x_normalised=True, t ∈ [0, 1]; else t is in seconds and `length` optional.
    """

def db_to_linear(db: np.ndarray) -> np.ndarray:
    return np.power(10.0, db / 20.0)
```

Linear interpolation between curve points; outside endpoints, clamp to the nearest endpoint's y-value.

### 3. Equal-power crossfade

For two clips `L` and `R` overlapping over `[a, b]` (length `L_overlap`):
- `t = np.linspace(0, 1, n_samples)` across the overlap
- `gain_L = np.cos(t * np.pi / 2)`
- `gain_R = np.sin(t * np.pi / 2)`
- Sum of squares = `cos²(θ) + sin²(θ) = 1` → constant perceived loudness

Apply to samples in the overlap region, then continue normal mixing outside.

### 4. Integrate with `narrative.py` / `assemble_final`

Replace the `_mux_audio(schedule.audio_path)` call with:

```python
audio_wav = render_project_audio(project_dir, project_sr, total_seconds)
mux_video_and_audio(video_path, audio_wav, output_path)
```

Legacy single-audio-file path can be preserved behind a feature flag for one release if needed, but per the design the default flips to multi-track.

### 5. Tests

- Two non-overlapping clips: mixed cleanly, levels correct
- Two overlapping clips: equal-power crossfade sum-of-squares ≈ 1
- Muted track: zero contribution
- Clip with dB curve dipping to -60 at middle: output sample at midpoint ~60 dB below surrounding samples
- Track curve at absolute 10-20s reducing by 6 dB: clips in that range are half-amplitude

---

## Verification

- [ ] `render_project_audio` produces correct WAV for a hand-constructed project
- [ ] Equal-power crossfade: sum of squared gains measures ≈ 1 at each sample in overlap
- [ ] Clip + track curve compose (gains multiply)
- [ ] Muted track / muted clip contribute zero
- [ ] Final export uses mixdown; playback in player matches

---

**Next Task**: [Task 92: Veo auto-link](task-92-veo-auto-link.md)
