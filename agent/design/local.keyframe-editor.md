# Keyframe Editor

**Concept**: Non-linear keyframe editor with drag-to-reorder, add/delete with soft-delete bin, candidate variations with per-variant prompt tracking, and prompt editing
**Created**: 2026-03-26
**Status**: Design Specification

---

## Overview

Extends the timeline editor in beatlab-synthesizer from a passive viewer to a full keyframe editing tool. Users can reorder keyframes by dragging them to arbitrary time positions, add new keyframes, soft-delete keyframes to a recoverable bin, edit prompts, browse/select candidate variations, and generate new variations — all persisted through the beatlab server.

---

## Problem Statement

- The current editor displays keyframes and supports boundary dragging for timestamp tweaks, but cannot reorder, add, or remove keyframes.
- Candidate selection and prompt editing require manual YAML editing or CLI commands.
- Generated images are expensive (GPU time) — deleting a keyframe should not destroy its generated variants.
- The current YAML schema tracks candidates as flat file paths with no per-variant metadata, making it impossible to know which prompt produced which variant.

---

## Solution

### YAML Schema Evolution

Evolve the `narrative_keyframes.yaml` schema to support per-variant metadata and a keyframe bin, while remaining backward-compatible with the current flat-list format.

### Frontend

A rich keyframe editor with:
- Drag-to-reorder on the video track (dragging a keyframe past a neighbor swaps their positions)
- Add/delete keyframes via UI controls
- Side panel candidates tab for browsing, selecting, and generating variations
- Inline prompt editing per keyframe

### Backend

All mutations go through the beatlab server (per `local.beatlab-server` design). New endpoints for CRUD operations, reorder, soft-delete/restore, prompt update, and candidate generation.

---

## Implementation

### Component 1: YAML Schema Evolution

#### Current schema (candidates as flat paths)

```yaml
- id: kf_001
  timestamp: '0:00'
  section: 1A
  prompt: "Soft violet aurora..."
  candidates:
    - .beatlab_work/.../section_kf_001/v1.png
    - .beatlab_work/.../section_kf_001/v2.png
  selected: 1
```

#### New schema (per-variant metadata)

```yaml
- id: kf_001
  timestamp: '0:00'
  section: 1A
  prompt: "Soft violet aurora..."
  candidates:
    - path: .beatlab_work/.../section_kf_001/v1.png
      prompt: "Soft violet aurora..."
      generated_at: '2026-03-25T10:30:00Z'
      variant: 1
    - path: .beatlab_work/.../section_kf_001/v2.png
      prompt: "Soft violet aurora..."
      generated_at: '2026-03-25T10:30:00Z'
      variant: 2
    - path: .beatlab_work/.../section_kf_001/v5.png
      prompt: "Deeper violet with crystalline spires..."
      generated_at: '2026-03-26T14:00:00Z'
      variant: 5
  selected: 1
```

**Backward compatibility**: When loading, if a candidate entry is a string (old format), treat it as `{ path: <string>, prompt: <keyframe prompt>, variant: <index> }`. The beatlab server handles this normalization on read.

#### Keyframe bin

```yaml
# At the top level of narrative_keyframes.yaml
bin:
  - id: kf_008
    deleted_at: '2026-03-26T15:00:00Z'
    timestamp: '0:52'
    section: 1B
    prompt: "..."
    candidates: [...]
    selected: 2
```

Binned keyframes retain all their data including candidates and selected image references. They are removed from the `keyframes` array and placed in `bin`. Restore moves them back.

### Component 2: Beatlab Server Endpoints

New endpoints (additions to the `local.beatlab-server` design):

#### `POST /api/projects/:name/reorder-keyframe`

Move a keyframe to a new timestamp. If the new position crosses other keyframes, their relative order is preserved — only the dragged keyframe's timestamp changes.

```json
// Request
{ "keyframeId": "kf_005", "newTimestamp": "0:18.50" }

// Response
{ "success": true, "keyframes": [...] }
```

Returns the updated keyframe list so the frontend can re-render without a separate fetch.

#### `POST /api/projects/:name/add-keyframe`

Create a new keyframe at a given timestamp.

```json
// Request
{
  "timestamp": "1:45",
  "section": "1B",
  "prompt": "A vast cathedral of light...",
  "source": "assets/stills/default.png"
}

// Response
{ "success": true, "keyframe": { "id": "kf_074", ... } }
```

The server assigns the next sequential ID (`kf_074` if 73 exist). The new keyframe has no candidates until generation is triggered.

#### `POST /api/projects/:name/delete-keyframe`

Soft-delete a keyframe to the bin.

```json
// Request
{ "keyframeId": "kf_008" }

// Response
{ "success": true, "binned": { "id": "kf_008", "deleted_at": "..." } }
```

#### `POST /api/projects/:name/restore-keyframe`

Restore a keyframe from the bin.

```json
// Request
{ "keyframeId": "kf_008" }

// Response
{ "success": true, "keyframe": { "id": "kf_008", ... } }
```

Restored keyframe gets its original timestamp back. If that position is now occupied, the user can drag it to reposition.

#### `GET /api/projects/:name/bin`

List binned keyframes.

```json
{
  "bin": [
    { "id": "kf_008", "deleted_at": "...", "timestamp": "0:52", "prompt": "...", "hasSelectedImage": true }
  ]
}
```

#### `POST /api/projects/:name/update-prompt`

Update a keyframe's prompt text.

```json
// Request
{ "keyframeId": "kf_001", "prompt": "Updated prompt text..." }

// Response
{ "success": true }
```

#### `POST /api/projects/:name/generate-candidates`

Generate new candidate variations for a keyframe. Long-running — calls `narrative.generate_keyframe_candidates()` for the specified keyframe with the current prompt.

```json
// Request
{ "keyframeId": "kf_001", "count": 4 }

// Response (immediate)
{ "jobId": "gen_abc123", "status": "started" }
```

New variants get the next available variant number (e.g., v5, v6, v7, v8 if 4 already exist) and store the prompt used at generation time.

### Component 3: Frontend — Drag to Reorder

The video track already supports dragging the left boundary of a keyframe. Reordering extends this:

**Behavior:**
- User clicks and drags a keyframe (not just the edge — the whole keyframe block)
- As the keyframe is dragged, a ghost/preview shows its new position
- If dragged past a neighbor keyframe's midpoint, the visual order updates (the neighbor shifts)
- On drop, the keyframe's timestamp is set to the drop position
- A single `reorder-keyframe` call persists the change

**Implementation approach:**
- Track drag state: `{ draggingId, startX, originalTime }`
- During drag, compute new time from mouse position (same math as boundary drag)
- Render the dragged keyframe at the new position with a highlight/ghost style
- On mouseup, call `reorder-keyframe` endpoint

**Distinguishing drag-to-reorder from boundary drag:**
- Boundary drag: mousedown on the left edge handle (existing)
- Reorder drag: mousedown on the keyframe body (new)

### Component 4: Frontend — Add / Delete

**Add keyframe:**
- Button in the toolbar or right-click context menu on the timeline
- Opens a minimal form: timestamp (defaults to playhead position), section, prompt
- Calls `add-keyframe` endpoint
- New keyframe appears on the timeline with no image (placeholder)

**Delete keyframe:**
- Button in the side panel header or keyboard shortcut (Delete key)
- Confirmation not needed (it's a soft delete, recoverable from bin)
- Calls `delete-keyframe` endpoint
- Keyframe disappears from timeline

**Keyframe bin:**
- Accessible from a toolbar button or panel tab
- Shows thumbnails of deleted keyframes with timestamps
- Click "Restore" to bring one back

### Component 5: Frontend — Candidates Tab

New tab in the KeyframePanel side panel (alongside the existing metadata view):

**Tabs:** `Details` | `Candidates`

**Candidates tab shows:**
- Grid of candidate thumbnails (v1, v2, v3, v4, ...)
- Currently selected variant highlighted with a ring
- Click a candidate to select it (calls `select-keyframes` endpoint)
- Each candidate shows its prompt (if different from the keyframe's current prompt) and generation timestamp
- "Generate More" button at the bottom
  - Uses the keyframe's current prompt
  - Shows a loading state while generating
  - New variants appear in the grid when complete

**Prompt editing:**
- The keyframe's `prompt` field is an editable textarea in the Details tab
- On blur or Ctrl+Enter, calls `update-prompt` endpoint
- A "Generate with this prompt" button next to the prompt triggers generation with the updated text

### Component 6: Deployment Architecture — Provisioned Cloud Desktop

The production deployment model is a **provisioned cloud desktop instance per customer** with a mounted volume, not a multi-tenant server or ephemeral containers.

```
Customer's Cloud Desktop (lightweight instance)
├── Mounted Volume (/data or similar)
│   └── .beatlab_work/
│       ├── project_a/
│       │   ├── narrative_keyframes.yaml   ← the "document"
│       │   ├── audio.wav
│       │   ├── selected_keyframes/
│       │   ├── keyframe_candidates/
│       │   └── ...
│       └── project_b/
├── beatlab server (Python, port 8888)
└── beatlab-synthesizer (Node.js, port 3400)
```

**Why this matters for the keyframe editor:**

- **YAML stays as the primary storage format** — no D1 or SQL database needed. A `narrative_keyframes.yaml` file is the project document, like a `.docx` file. It's concrete, human-readable, diffable, and the beatlab CLI already speaks it natively.
- **No GCS sync layer** — files live on the mounted volume. No upload/download latency, no eventual consistency. The beatlab server reads/writes to disk exactly like local dev.
- **Scale separation** — the desktop instance handles I/O, editing, serving. GPU-heavy operations (candidate generation, video rendering) shell out to beefy machines (Vast.ai) as beatlab already does. Avoids irreversible scale-up traps (e.g., DigitalOcean droplet upgrades that can't be reversed).
- **Customer isolation** — each customer gets their own instance + volume. No multi-tenant data concerns.
- **Backup via snapshots** — mounted volume snapshots provide disaster recovery. A `beatlab archive` command could also tar the `.beatlab_work/` directory to object storage periodically.

**YAML-as-document philosophy:** The project file *is* the YAML + the media files on the volume. There's no separate database to keep in sync. The YAML schema evolves in place (with backward-compat loading), and the beatlab server is the only writer, preventing corruption from concurrent access.

---

## Benefits

- **Full editing capability**: The synthesizer becomes a real editing tool, not just a viewer
- **Non-destructive**: Soft delete preserves expensive GPU-generated images
- **Prompt lineage**: Per-variant prompt tracking means you always know what generated what
- **Backward compatible**: Old YAML files load without modification
- **YAML-as-document**: No database layer to keep in sync — the YAML file *is* the project, stored on a mounted volume alongside the media files. Concrete, portable, diffable.
- **Simple deployment**: Provisioned desktop + mounted volume per customer. No multi-tenant complexity, no GCS sync layer, no SQL migrations.

---

## Trade-offs

- **YAML complexity**: The candidates schema grows from a flat list to objects with metadata. YAML files get larger.
- **Drag-to-reorder UX**: Distinguishing "drag to reorder" from "drag boundary to adjust timestamp" requires clear visual affordances. The edge handle vs body drag distinction needs to be obvious.
- **Generation latency**: Generating new candidates is a long-running GPU operation. The UI needs to handle async gracefully (loading states, error recovery).
- **Bin size**: The bin grows unbounded. May need a "purge bin" command eventually.

---

## Dependencies

- **beatlab server** (`local.beatlab-server` design): All mutations go through the server
- **render/narrative.py**: Existing `apply_keyframe_selection()`, new functions for CRUD + bin + prompt update
- **Image generation pipeline**: `narrative.generate_keyframe_candidates()` for the "Generate More" feature
- No new npm dependencies in the synthesizer (tab UI, drag-to-reorder, textarea are all vanilla React)

---

## Testing Strategy

- **Schema migration**: Test that old flat-list YAML loads correctly under the new schema
- **Reorder**: Drag kf_003 past kf_004, verify timestamps update correctly in YAML
- **Soft delete + restore**: Delete kf_005, verify it appears in bin, restore it, verify it returns to keyframes array
- **Prompt tracking**: Edit prompt, generate new variants, verify each variant records the prompt used
- **Parity**: Compare CLI `beatlab narrative select-keyframes kf_001:v2` with HTTP `POST /select-keyframes` — same result

---

## Migration Path

1. **Phase 1 — Schema + server endpoints**: Evolve YAML schema with backward-compat loading. Add CRUD + reorder + bin endpoints to beatlab server.
2. **Phase 2 — Candidates tab**: Build the candidates tab in the side panel with selection and prompt editing.
3. **Phase 3 — Drag to reorder**: Add full-keyframe drag (distinct from boundary drag) to the video track.
4. **Phase 4 — Generate from UI**: Wire up "Generate More" button to the generation endpoint with async job tracking.
5. **Phase 5 — Provisioned desktop deployment**: Package beatlab server + synthesizer for cloud desktop instances with mounted volumes. Add `beatlab archive` for backup to object storage.

---

## Key Design Decisions

### Schema

| Decision | Choice | Rationale |
|---|---|---|
| Candidate metadata | Per-variant objects with prompt + timestamp | Essential for prompt lineage; flat paths lose generation context |
| Backward compatibility | Normalize string candidates to objects on load | Don't break existing YAML files; migration is transparent |
| Soft delete | `bin` array at YAML top level | Preserves all data including candidates; simple to implement |
| ID assignment | Sequential `kf_NNN` | Consistent with existing scheme; server assigns next available |

### Frontend

| Decision | Choice | Rationale |
|---|---|---|
| Reorder vs boundary drag | Body drag = reorder, edge drag = boundary adjust | Clear spatial distinction; edge handle already established |
| Delete confirmation | None (soft delete is non-destructive) | Keyframe bin makes it safe; reduces friction |
| Prompt editing | Textarea in Details tab with explicit save | Avoids accidental edits; Ctrl+Enter or blur to save |
| Candidate generation | Async with polling/SSE | GPU generation takes seconds to minutes |

### Architecture

| Decision | Choice | Rationale |
|---|---|---|
| All mutations through beatlab server | Yes, including reorder and add | Single source of truth; no direct YAML editing from Node.js |
| Storage | YAML on mounted volume, no database | YAML-as-document philosophy — the file is the project. Provisioned desktop + volume per customer. No GCS, no D1, no sync layer. |
| Deployment | Provisioned cloud desktop per customer | Lightweight instance for I/O + serving, GPU ops shell out to Vast.ai. Avoids irreversible scale-up. Customer isolation by design. |
| Bin purge | Not in scope | Bin growth is manageable per-volume; add purge command later |

---

## Future Considerations

- **Undo/redo stack**: Track mutations for Ctrl+Z/Ctrl+Y across all operations
- **Batch operations**: Select multiple keyframes for bulk delete, move, or regenerate
- **Keyframe interpolation preview**: Show estimated visual transition between adjacent keyframes
- **Bin purge**: `beatlab narrative purge-bin` command to delete binned keyframes and their files from the volume
- **`beatlab archive`**: Tar/compress `.beatlab_work/` project to object storage for backup. Mounted volumes can fail — periodic snapshots + archive provide disaster recovery.
- **Multi-user on shared desktop**: If a team shares a desktop instance, need file locking or conflict resolution on concurrent YAML edits. Single-user for now.

---

**Status**: Design Specification
**Recommendation**: Implement `local.beatlab-server` first (prerequisite), then Phase 1 (schema + endpoints), then Phase 2 (candidates tab)
**Related Documents**: [local.beatlab-server](local.beatlab-server.md), [narrative_keyframes.yaml schema](../../davinci-beat-lab/.beatlab_work/beyond_the_veil_v26_radio_v14/narrative_keyframes.yaml)
