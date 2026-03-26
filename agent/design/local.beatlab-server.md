# Beatlab Server

**Concept**: REST server command for davinci-beat-lab exposing narrative pipeline operations to the beatlab-synthesizer frontend
**Created**: 2026-03-26
**Status**: Design Specification

---

## Overview

The beatlab-synthesizer web frontend needs to invoke beatlab pipeline operations (keyframe selection, timestamp editing, candidate generation, assembly) without reimplementing or drifting from beatlab's actual behavior. Rather than wrapping CLI commands or doing direct file manipulation, we add a `beatlab server` command that starts an HTTP server inside davinci-beat-lab itself, exposing its internal Python functions as REST endpoints.

---

## Problem Statement

- The synthesizer frontend currently edits `narrative_keyframes.yaml` directly for timestamp changes. As we add candidate selection and other operations, direct file manipulation risks diverging from how beatlab actually processes these operations (file copies, YAML field updates, downstream cache invalidation).
- Shelling out to CLI commands from a Node.js server is fragile (argument escaping, error handling, output parsing).
- A separate REST wrapper service would duplicate knowledge of beatlab's internals and drift over time.
- We own both projects, so the cleanest solution is to expose beatlab's internal functions directly via HTTP.

---

## Solution

Add a `beatlab server` command that starts an HTTP server (stdlib `http.server`, matching the existing `marker_server.py` pattern) exposing REST endpoints for the narrative pipeline operations that the synthesizer frontend needs.

**Architecture:**

```
beatlab-synthesizer (React)  ──HTTP──►  beatlab server (Python, port 8888)
       │                                       │
       │ TanStack server fns                   │ calls internal Python functions
       │ proxy to beatlab server               │ (render/narrative.py, cli.py)
       ▼                                       ▼
   Browser UI                          .beatlab_work/ filesystem
                                       narrative_keyframes.yaml
```

The synthesizer's TanStack server functions proxy requests to the beatlab server, so the browser never talks to it directly (avoids CORS, keeps the beatlab server on localhost only).

**Deployment model:** Both the beatlab server and synthesizer run on a **provisioned cloud desktop instance per customer** with a mounted volume holding `.beatlab_work/`. This is the same architecture as local dev — no GCS, no database, no multi-tenant complexity. YAML files on the mounted volume are the primary storage, treated as project documents (like a `.docx`). GPU-heavy operations (generation, rendering) shell out to separate machines (Vast.ai) as beatlab already does, keeping the desktop lightweight.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| Direct YAML editing from Node.js | Drift risk — beatlab does file copies, cache invalidation, YAML field updates together |
| Shell out to `beatlab narrative select-keyframes` | Fragile argument passing, no structured error responses, hard to stream progress |
| Separate REST wrapper service | Third codebase to maintain, duplicates knowledge of beatlab internals |
| GCS + D1 database | Unnecessary — provisioned desktop with mounted volume provides persistent storage without sync complexity |
| Multi-tenant server | Customer isolation is simpler with per-customer desktop instances; no data partitioning needed |

---

## Implementation

### Component 1: `beatlab server` CLI command

New Click command in `cli.py`:

```python
@main.command()
@click.option("--port", default=8888, help="Server port")
@click.option("--host", default="0.0.0.0", help="Bind address")
def server(port, host):
    """Start REST API server for beatlab-synthesizer."""
    from beatlab.api_server import run_server
    run_server(host, port)
```

### Component 2: `api_server.py`

New module at `src/beatlab/api_server.py`, following the `marker_server.py` pattern (stdlib `http.server`).

**Endpoints:**

#### `GET /api/projects`
List `.beatlab_work/` project directories with metadata.

**Response:**
```json
{
  "projects": [
    {
      "name": "beyond_the_veil_v26_radio_v14",
      "hasAudio": true,
      "hasNarrativeYaml": true,
      "keyframeCount": 73
    }
  ]
}
```

#### `GET /api/projects/:name/keyframes`
Load parsed `narrative_keyframes.yaml` — meta + keyframes with candidate paths and selection state.

**Response:**
```json
{
  "meta": { "title": "...", "fps": 24, "resolution": [1920, 1080] },
  "keyframes": [
    {
      "id": "kf_001",
      "timestamp": "0:00",
      "section": "1A",
      "prompt": "...",
      "selected": 1,
      "candidates": [
        "keyframe_candidates/candidates/section_kf_001/v1.png",
        "keyframe_candidates/candidates/section_kf_001/v2.png",
        "keyframe_candidates/candidates/section_kf_001/v3.png",
        "keyframe_candidates/candidates/section_kf_001/v4.png"
      ],
      "hasSelectedImage": true,
      "context": { "mood": "dreamy", "energy": "low", ... }
    }
  ]
}
```

#### `POST /api/projects/:name/select-keyframes`
Apply keyframe selections. Calls `apply_keyframe_selection()` from `render/narrative.py`.

**Request:**
```json
{
  "selections": { "kf_001": 2, "kf_005": 3 }
}
```

This does exactly what `beatlab narrative select-keyframes` does:
1. Copy candidate image to `selected_keyframes/{id}.png`
2. Update YAML `selected` field
3. Save YAML

**Response:**
```json
{ "success": true, "updated": ["kf_001", "kf_005"] }
```

#### `POST /api/projects/:name/update-timestamp`
Update a keyframe's timestamp in the YAML.

**Request:**
```json
{
  "keyframeId": "kf_001",
  "timestamp": "0:06.50"
}
```

**Response:**
```json
{ "success": true }
```

#### `POST /api/projects/:name/select-slot-keyframes`
Apply slot keyframe selections. Calls `apply_slot_keyframe_selection()`.

**Request:**
```json
{
  "selections": { "tr_041_slot_0": 2 }
}
```

#### `POST /api/projects/:name/select-transitions`
Apply transition selections.

#### `GET /api/projects/:name/files/*path`
Serve files from the project's `.beatlab_work/` directory (images, audio, video). Supports `Range` headers for streaming.

#### `POST /api/projects/:name/assemble`
Trigger final assembly. Long-running — returns immediately with a job ID, progress queryable via SSE or polling.

### Component 3: Synthesizer proxy layer

Replace direct YAML edits in `beatlab-synthesizer` with proxy server functions:

```typescript
// src/lib/beatlab-client.ts
const BEATLAB_SERVER = process.env.BEATLAB_SERVER_URL || 'http://localhost:8888'

export async function selectKeyframes(project: string, selections: Record<string, number>) {
  const res = await fetch(`${BEATLAB_SERVER}/api/projects/${project}/select-keyframes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selections }),
  })
  return res.json()
}

export async function updateTimestamp(project: string, keyframeId: string, timestamp: string) {
  const res = await fetch(`${BEATLAB_SERVER}/api/projects/${project}/update-timestamp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyframeId, timestamp }),
  })
  return res.json()
}
```

The existing `updateKeyframeTimestamp` server function in the editor route would be replaced with a call through this client.

---

## Benefits

- **No drift**: All operations go through the same Python functions that the CLI uses
- **Single source of truth**: beatlab owns all file operations, YAML updates, and cache invalidation
- **Incremental**: Start with select-keyframes + timestamp, add more endpoints as needed
- **Simple**: stdlib HTTP server, no new dependencies in beatlab
- **Testable**: Same functions, just exposed via HTTP instead of Click CLI

---

## Trade-offs

- **Two processes required**: User must run both `beatlab server` and the synthesizer dev server. Mitigated by clear documentation and potentially a single launch script.
- **No auth**: Localhost-only, no authentication needed for local dev. Would need auth if ever exposed externally.
- **Stdlib HTTP**: No automatic JSON parsing, no middleware, no routing framework. Keeps dependencies minimal but handler code is more verbose. Could migrate to FastAPI later if complexity warrants it.

---

## Dependencies

- **davinci-beat-lab**: The `api_server.py` module imports from `render/narrative.py` and other beatlab internals
- **beatlab-synthesizer**: Needs `BEATLAB_SERVER_URL` env var (defaults to `http://localhost:8888`)
- No new pip dependencies (stdlib `http.server`, `json`, `pathlib`)

---

## Testing Strategy

- **Unit tests**: Test each handler function with mock YAML data
- **Integration test**: Start server, make HTTP calls, verify YAML + filesystem changes
- **Manual**: Run `beatlab server`, open synthesizer, select a keyframe candidate, verify file copy + YAML update match what `beatlab narrative select-keyframes` would produce

---

## Migration Path

1. Implement `beatlab server` command with `GET /api/projects/:name/keyframes` and `POST /api/projects/:name/select-keyframes` endpoints
2. Add `POST /api/projects/:name/update-timestamp` endpoint
3. Create `beatlab-client.ts` in synthesizer
4. Replace direct YAML edit in synthesizer's `updateKeyframeTimestamp` with proxy call
5. Build candidates tab in synthesizer side panel, calling `select-keyframes` via proxy
6. Add remaining endpoints (slot-keyframes, transitions, assemble) as synthesizer features expand

---

## Key Design Decisions

### Architecture

| Decision | Choice | Rationale |
|---|---|---|
| Where the server lives | Inside davinci-beat-lab as `beatlab server` command | We own the codebase, avoids wrapper drift, direct access to internal functions |
| HTTP framework | stdlib `http.server` | Matches existing `marker_server.py` pattern, zero new dependencies |
| Communication pattern | Synthesizer server fns proxy to beatlab server | Browser never talks to beatlab directly, avoids CORS, single origin |
| File serving | Beatlab server serves files from `.beatlab_work/` | Synthesizer no longer needs direct filesystem access to the beatlab work dir |

### Operations

| Decision | Choice | Rationale |
|---|---|---|
| Timestamp edits | Go through beatlab server | Even simple YAML edits should use the same code path to avoid format divergence |
| Keyframe selection | Calls `apply_keyframe_selection()` directly | Exact same behavior as CLI — file copy + YAML update + cache invalidation |
| Long-running ops (assemble) | Async with job ID | Assembly can take minutes; don't block the HTTP request |

---

## Future Considerations

- **WebSocket for progress**: Long-running operations (generation, assembly) could stream progress via WebSocket instead of polling
- **FastAPI migration**: If endpoint count grows significantly, migrate from stdlib to FastAPI for automatic validation, OpenAPI docs
- **File watching**: Beatlab server could watch `.beatlab_work/` for external changes and push updates to the frontend
- **Multi-project**: Currently assumes one `.beatlab_work/` directory; may need to support multiple roots
- **Auth**: If the desktop instance is ever network-exposed beyond localhost, add token-based auth
- **`beatlab archive`**: Backup `.beatlab_work/` to object storage from the mounted volume for disaster recovery
- **Desktop provisioning automation**: Scripts or Terraform for spinning up customer desktop instances with beatlab + synthesizer pre-installed

---

**Status**: Design Specification
**Recommendation**: Implement Phase 1 — `beatlab server` with keyframe list, select-keyframes, and update-timestamp endpoints
**Related Documents**: [project_architecture memory](../../.claude/projects/-home-prmichaelsen--acp-projects-beatlab-synthesizer/memory/project_architecture.md), [narrative.py](../../davinci-beat-lab/src/beatlab/render/narrative.py)
