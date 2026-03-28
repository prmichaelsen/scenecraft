# YAML Schema Split: Narrative vs Timeline

**Concept**: Separate musical analysis (narrative) from visual timeline (keyframes + transitions) into independent YAML files so timelines can be replaced without losing musical notes
**Created**: 2026-03-28
**Status**: Design Specification

---

## Overview

The current `narrative_keyframes.yaml` conflates four concerns into one file: musical analysis, keyframes, transitions, and project config. This creates a problem when users want to swap the entire visual timeline (bulk import keyframes + transitions from another project) while preserving their musical analysis notes. This design splits the monolith into purpose-specific files.

---

## Problem Statement

- **Can't replace timeline without losing notes**: Importing a full set of keyframes + transitions from another project overwrites musical analysis, section notes, mood descriptions, and visual direction that took time to author.
- **Musical analysis is reusable**: The same section analysis (mood, energy, instruments, motifs) should drive multiple visual interpretations — different timelines exploring different aesthetics for the same music.
- **Multiple timelines**: Users want to experiment with different keyframe arrangements (branch-like) but the musical backbone stays constant. Currently this requires duplicating the entire YAML.
- **Single-file coupling**: Every API endpoint reads/writes the same file, making it impossible to atomically replace just the timeline portion.

---

## Solution

Split `narrative_keyframes.yaml` into separate files, each owning a specific concern:

```
.beatlab_work/project/
├── narrative.yaml          ← musical analysis (sections, moods, context)
├── timeline.yaml           ← keyframes + transitions + bin (the visual timeline)
├── project.yaml            ← project config (meta, watched_folders)
├── beats.json              ← auto-detected beats (unchanged)
└── beats.yaml              ← user effects + suppressions (unchanged)
```

### File Responsibilities

#### `narrative.yaml` — Musical Brain

The persistent musical analysis. Never blown away by timeline operations.

```yaml
sections:
  - id: section_1A
    label: "1A"
    start: "0:00"
    end: "0:25"
    mood: "dreamy, serene"
    energy: "low"
    instruments: ["soothing vocals", "ethereal pads"]
    motifs: ["PAD-VERSE-1A"]
    events: []
    visual_direction: "Slow, gentle, ethereal. Soft bloom/glow. Minimal movement."
    notes: |
      Ethereal Opening. No drums, no kicks, no percussion.
      Spacious reverb, airy atmosphere.
      Calm, meditative, wistful hopefulness.

  - id: section_1B
    label: "1B"
    start: "0:25"
    end: "0:50"
    mood: "awakening, building"
    energy: "low-mid"
    ...
```

#### `timeline.yaml` — Visual Timeline

The replaceable visual layer. Can be swapped, branched, imported wholesale.

```yaml
active_timeline: default

timelines:
  default:
    keyframes:
      - id: kf_001
        timestamp: "0:00"
        section: "1A"          # soft reference to narrative.yaml section
        prompt: "Soft violet aurora..."
        candidates: [...]
        selected: 1
        context: null           # REMOVED — context lives in narrative.yaml

    transitions:
      - id: tr_001
        from: kf_001
        to: kf_002
        duration_seconds: 6.0
        slots: 1
        action: "..."
        selected: [2]
        remap: { method: linear, target_duration: 6.0 }

    bin: [...]
    transition_bin: [...]
```

**Key change**: Keyframes reference sections by `section: "1A"` label instead of embedding the full context. The context is looked up from `narrative.yaml` at render time.

**Multiple timelines**: The `timelines` map allows storing multiple timeline variants in the same file. `active_timeline` selects which one is current. This is lighter than git branching for quick A/B comparisons.

#### `project.yaml` — Project Config

```yaml
meta:
  title: "Singularity Debut - Gentle Morning"
  audio: "assets/beyond_the_veil_v26_radio_v14.mov"
  fps: 24
  resolution: [1920, 1080]
  candidates_per_slot: 4
  transition_max_seconds: 8
  motion_prompt: ""
  default_transition_prompt: "Smooth cinematic transition"

watched_folders:
  - /path/to/watch
```

### Backward Compatibility

When only `narrative_keyframes.yaml` exists (legacy):
1. The server reads it as before — no migration required
2. First write operation splits it into the three files
3. `narrative_keyframes.yaml` is kept as a symlink or ignored

Alternatively, lazy migration on first access: if `timeline.yaml` doesn't exist but `narrative_keyframes.yaml` does, extract sections → `narrative.yaml`, keyframes+transitions → `timeline.yaml`, meta → `project.yaml`.

---

## Implementation

### Component 1: File Split Logic

A Python function that splits the legacy file:

```python
def split_narrative_yaml(work_dir: Path):
    """Split narrative_keyframes.yaml into narrative.yaml + timeline.yaml + project.yaml."""
    legacy = work_dir / "narrative_keyframes.yaml"
    if not legacy.exists():
        return

    # Already split?
    if (work_dir / "timeline.yaml").exists():
        return

    parsed = yaml.safe_load(legacy.read_text())

    # Extract sections from keyframe contexts
    sections = []
    seen_sections = set()
    for kf in parsed.get("keyframes", []):
        ctx = kf.get("context")
        section_label = kf.get("section", "")
        if ctx and section_label and section_label not in seen_sections:
            seen_sections.add(section_label)
            sections.append({
                "id": f"section_{section_label}",
                "label": section_label,
                "start": kf.get("timestamp", "0:00"),
                "mood": ctx.get("mood", ""),
                "energy": ctx.get("energy", ""),
                "instruments": ctx.get("instruments", []),
                "motifs": ctx.get("motifs", []),
                "events": ctx.get("events", []),
                "visual_direction": ctx.get("visual_direction", ""),
                "notes": ctx.get("details", ""),
            })

    # narrative.yaml
    narrative = {"sections": sections}

    # timeline.yaml — strip context from keyframes
    keyframes = []
    for kf in parsed.get("keyframes", []):
        kf_copy = dict(kf)
        kf_copy.pop("context", None)  # context now lives in narrative.yaml
        keyframes.append(kf_copy)

    timeline = {
        "active_timeline": "default",
        "timelines": {
            "default": {
                "keyframes": keyframes,
                "transitions": parsed.get("transitions", []),
                "bin": parsed.get("bin", []),
                "transition_bin": parsed.get("transition_bin", []),
            }
        }
    }

    # project.yaml
    project = {
        "meta": parsed.get("meta", {}),
        "watched_folders": parsed.get("watched_folders", []),
    }

    # Write files
    yaml.dump(narrative, (work_dir / "narrative.yaml").open("w"), ...)
    yaml.dump(timeline, (work_dir / "timeline.yaml").open("w"), ...)
    yaml.dump(project, (work_dir / "project.yaml").open("w"), ...)
```

### Component 2: Unified Load/Save

A `load_project(work_dir)` function that returns a unified data dict regardless of whether the project uses legacy or split files:

```python
def load_project(work_dir: Path) -> dict:
    """Load project data from split or legacy YAML files."""
    if (work_dir / "timeline.yaml").exists():
        # Split format
        narrative = yaml.safe_load((work_dir / "narrative.yaml").read_text()) or {}
        timeline_data = yaml.safe_load((work_dir / "timeline.yaml").read_text()) or {}
        project = yaml.safe_load((work_dir / "project.yaml").read_text()) or {}
        active = timeline_data.get("active_timeline", "default")
        tl = timeline_data.get("timelines", {}).get(active, {})
        return {
            "meta": project.get("meta", {}),
            "sections": narrative.get("sections", []),
            "keyframes": tl.get("keyframes", []),
            "transitions": tl.get("transitions", []),
            "bin": tl.get("bin", []),
            "transition_bin": tl.get("transition_bin", []),
            "watched_folders": project.get("watched_folders", []),
            "_format": "split",
            "_active_timeline": active,
        }
    else:
        # Legacy format
        legacy = work_dir / "narrative_keyframes.yaml"
        parsed = yaml.safe_load(legacy.read_text()) if legacy.exists() else {}
        return {**parsed, "_format": "legacy"}
```

### Component 3: API Server Updates

All handlers switch from reading `narrative_keyframes.yaml` directly to using `load_project()` / `save_project()`. The handler signatures don't change — just the internal read/write path.

**New endpoints:**
- `GET /api/projects/:name/narrative` — return sections from narrative.yaml
- `POST /api/projects/:name/narrative` — update sections
- `POST /api/projects/:name/timeline/switch` — switch active timeline
- `POST /api/projects/:name/timeline/import` — replace active timeline from another source
- `GET /api/projects/:name/timelines` — list available timelines

### Component 4: Frontend Updates

- EditorData gains `sections` from narrative.yaml (currently derived from keyframe contexts)
- KeyframePanel shows section info via lookup, not embedded context
- New "Timelines" selector in the toolbar for switching active timeline
- "Import Timeline" in ImportDialog for replacing the entire timeline

---

## Benefits

- **Non-destructive timeline swap**: Replace all keyframes + transitions without losing musical analysis
- **Multiple timelines**: A/B compare different visual interpretations of the same music
- **Separation of concerns**: Musical analysis authored once, visual timelines iterated many times
- **Lighter branching**: Multiple timelines in one file vs git branches with full file duplication
- **Reusable analysis**: Same narrative.yaml, new timeline.yaml for a remix or re-edit

---

## Trade-offs

- **Three files instead of one**: More files to manage, though each is simpler
- **Migration complexity**: Legacy projects need auto-migration on first access
- **Section references can break**: If narrative.yaml section labels change, timeline keyframe `section` refs become stale. Mitigated by: sections are human-authored and stable.
- **Multi-file atomicity**: Updating timeline + project simultaneously requires care. Mitigated by: each file owns its concern, cross-file writes are rare.

---

## Dependencies

- **beatlab server**: All YAML read/write paths need updating
- **beatlab CLI**: `load_narrative()` / `save_narrative()` in render/narrative.py need updating
- **beatlab-synthesizer**: EditorData type changes, section lookup changes
- No new dependencies

---

## Testing Strategy

- **Migration**: Load legacy `narrative_keyframes.yaml`, verify split produces correct `narrative.yaml` + `timeline.yaml` + `project.yaml`
- **Round-trip**: Load split files, save, reload — verify no data loss
- **Legacy compat**: Projects with only `narrative_keyframes.yaml` still work
- **Timeline swap**: Import a timeline from project B into project A, verify narrative.yaml unchanged
- **Multiple timelines**: Create two timelines, switch between them, verify each has independent keyframes/transitions

---

## Migration Path

1. **Phase 1 — Unified load/save**: Add `load_project()` / `save_project()` that handles both formats. All server handlers use it. No file split yet — legacy format still primary.
2. **Phase 2 — Auto-split on write**: First write operation splits legacy file into three files. Read path handles both.
3. **Phase 3 — Multiple timelines**: Add `timelines` map to `timeline.yaml`, timeline switching UI.
4. **Phase 4 — Import timeline**: "Import Timeline" feature that replaces active timeline from another project or file.
5. **Phase 5 — Narrative editor**: Dedicated UI for editing musical sections in narrative.yaml, separate from keyframe editing.

---

## Key Design Decisions

### File Structure

| Decision | Choice | Rationale |
|---|---|---|
| Number of files | 3 (narrative + timeline + project) | Clean separation of concerns; each file has one owner |
| Section references | Soft reference by label string | Labels are stable, human-authored; no UUID indirection needed |
| Context in keyframes | Removed — lookup from narrative.yaml | Eliminates duplication, sections are the source of truth |
| Multiple timelines | In-file map, not separate files | Lighter than separate files; `active_timeline` selector is simple |

### Migration

| Decision | Choice | Rationale |
|---|---|---|
| Backward compatibility | Read legacy format, split on first write | No breaking change; migration is transparent |
| Legacy file after split | Keep as backup, don't delete | Safety net; users can revert manually |
| Section extraction | Derive from keyframe contexts during split | Existing data has sections embedded in keyframes |

### API

| Decision | Choice | Rationale |
|---|---|---|
| Unified load/save | Single function handles both formats | All handlers work regardless of file format |
| Timeline switch | POST /timeline/switch with name | Simple, no file copying |
| Timeline import | POST /timeline/import with source path | Replaces active timeline keyframes + transitions |

---

## Future Considerations

- **Timeline diffing**: Compare two timelines side-by-side (which keyframes differ, which transitions changed)
- **Timeline merge**: Combine keyframes from two timelines (e.g., take keyframes 1-20 from timeline A, 21-40 from B)
- **Section-aware generation**: Generate keyframe prompts automatically from section analysis
- **Collaborative editing**: Narrative.yaml authored by music director, timeline.yaml by visual director
- **Template timelines**: Start from a timeline template (e.g., "standard music video structure")

---

**Status**: Design Specification
**Recommendation**: Implement Phase 1 (unified load/save) first, then Phase 2 (auto-split), then Phase 4 (import timeline) for the user's immediate need
**Related Documents**: [local.keyframe-editor](local.keyframe-editor.md), [local.beatlab-server](local.beatlab-server.md), [local.project-versioning](local.project-versioning.md)
