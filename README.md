# Scenecraft

AI-augmented multi-track video timeline editor with an extensible plugin system, LLM chat integration, and real-time light-show control.

> Built with [Agent Context Protocol](https://github.com/prmichaelsen/agent-context-protocol)

## What it is

Scenecraft is a browser-based non-linear video editor designed around three principles:

- **AI-native** — image, video, music, foley, transcription, and analysis are first-class, not bolt-ons
- **Extensible** — a VSCode-style plugin system lets each capability ship as a self-contained module that contributes UI panels, chat tools, REST endpoints, and timeline track types
- **Conversational** — a streaming LLM chat panel exposes 40+ editor tools (add keyframe, generate music, bounce audio, run light scene, …) with elicitation gating for cost-incurring or destructive operations

It runs entirely in the browser as a TanStack Start (React) app, talking to a headless Python backend that owns project state in SQLite, dispatches AI calls, and drives optional hardware (DMX over WebSerial, etc.).

## Capabilities

### Editor
- Multi-track video timeline with keyframes, transitions, and per-clip animated X/Y/Z transform curves
- Multi-track audio lanes with waveform display, volume curves, mute toggles, and clip-level effects
- Drag-to-trim clip edges with rolling edits and snap targets
- Cross-track clip move (drag from one lane to another with auto-overlap resolution)
- Selection model with multi-select; mutex between keyframes / transitions / audio clips
- Section / narrative markers along the timeline
- Real-time WebAudio playback with per-track level meters and master bus
- Bounce-to-WAV export (16/24/32-bit float) with peak / RMS / LUFS analysis

### AI generation
- **Keyframe images** — Google Imagen via the chat tool surface; per-keyframe candidate gallery
- **Transition video** — Google Veo for between-keyframe video fills
- **Music** — Musicful API (BYO key) via the `generate_music` plugin; track browser, drag-to-timeline
- **Foley** — Replicate-hosted MMAudio (BYO key) via the `generate_foley` plugin; supports both text-only (t2fx) and video-conditioned (v2fx) generation with playhead-driven in/out range
- **Stem isolation** — DeepFilterNet3 (local CPU) via the `isolate_vocals` plugin; vocal + background stems
- **Transcription** — Replicate Whisper via the `transcribe` plugin; word-level timestamps
- **DSP** — librosa-driven spectral centroid, RMS, peak detection
- **Narrative descriptions** — Google GenAI for batch-generated audio descriptions

### Plugin system
- Manifest-driven (`plugin.yaml`) — declarative `contributes` section names panels, chat tools, REST endpoints, track types, and migrations
- Plugins run on both sides of the wire: a static `PluginHost` registry in both the frontend (`src/lib/plugin-host.ts`) and backend (`src/scenecraft/plugin_host.py`)
- **Five first-party plugins** ship today: `isolate_vocals`, `generate_music`, `generate_foley`, `light_show`, `transcribe`
- **Plugin-owned sidecar tables** convention (`<plugin_id>__<table>`) — plugins can't alter core schema
- **Typed providers** (`plugin_api.providers.replicate`, …) — provider modules own auth, polling, backoff, spend attribution, and disconnect-survival on behalf of plugins
- **R9a structural invariant** enforced by test: plugins write through `plugin_api`, never raw DB

### Chat / LLM integration
- Streaming sidebar chat panel with markdown rendering and tool invocation UI
- 40+ tools spanning timeline structural ops, audio editing, generation, mix automation, checkpoints, SQL queries, and per-plugin operations
- Elicitation gate on destructive / cost-incurring tools — Claude pauses for an inline confirmation card before executing
- OAuth integration + MCP bridge for Remember protocol tools

### Light show + DMX
- 3D rig preview powered by three.js + `@react-three/fiber` + `@react-three/drei`
- Fixture registry (par cans, moving heads, video screens) with per-fixture channel overrides
- Scene authoring with rotating heads, static colors, and other primitives — placed on the timeline like any other clip
- Audio-reactive bindings: scene parameters can react to mic input, beat events, master bus RMS
- Live DMX output to ENTTEC DMX USB Pro via the browser's WebSerial API — no external daemon required
- Hardware output is optional; sim-mode runs without an interface attached

### Version control (in progress)
- Per-project content-addressed object store under `.scenecraft/` (commits, refs, sessions)
- SSH-based admin auth + per-user JWT sessions; double-gate API key middleware for paid-tool routes
- Branch refs and operations landed; diff / merge / rebase engines and the branch UI are still in flight
- The shipped predecessor is the **checkpoint** system — save/restore named project snapshots from the chat panel or the Checkpoints panel

### Workspace + panels
- Dockview-based dynamic panel layout — every panel is dockable, draggable, and tabbable
- ~30 built-in panels (Bin, Chat, Extensions, Timeline, Preview, Keyframe, Transition, Properties, Audio Properties, Checkpoints, Macro, Bus Sub, Settings, …) plus everything plugins contribute
- Per-user layout persisted to localStorage

### Media management
- Pool segments are content-addressed; one row per unique hash
- Drag-and-drop import via dialog or directly onto the timeline; ffprobe extracts metadata
- Tagging, renaming, and garbage collection via REST + chat tools
- ACL system, in-app FS browser, and watchdog ingest are designed and partially under way (M9-explorer)

## Architecture

```
┌─────────────────────────────────────┐
│  scenecraft (frontend)              │
│  TanStack Start + React 19 + Vite   │
│   ├── Dockview panel host           │
│   ├── PluginHost (TS)               │
│   ├── WebAudio mixer                │
│   ├── WebSerial DMX                 │
│   └── three.js light show           │
└──────────┬──────────────────────────┘
           │ REST + WS
┌──────────▼──────────────────────────┐
│  scenecraft-engine (backend)        │
│  Python 3.10+ stdlib http.server    │
│   ├── PluginHost (Python)           │
│   ├── plugin_api.providers.replicate│
│   ├── chat dispatch (40+ tools)     │
│   ├── JobManager + /ws/jobs         │
│   └── per-project SQLite state      │
└─────────────────────────────────────┘
```

**Project state** lives at `/mnt/storage/.scenecraft/projects/<name>/project.db` (per-project SQLite, plus a content-addressed `pool/`, `objects/`, `refs/`, `sessions/`). A cross-project `server.db` carries `spend_ledger`, `api_keys`, and users.

## Tech stack

**Frontend**
- TanStack Start (React 19, TypeScript), Vite
- Dockview-react for panels, Tailwind for styling, Lucide for icons
- three.js + `@react-three/fiber` + `@react-three/drei` for 3D
- WebAudio API for mixing, WebSerial API for DMX, wavesurfer.js for waveform UI
- vitest + @testing-library/react for tests

**Backend**
- Python 3.10+, custom http.server-based REST + WebSocket
- librosa, soundfile, pyloudnorm for audio analysis + render
- moviepy, opencv-python, pyav for video handling
- anthropic SDK (Claude), google-genai (Imagen / Veo / GenAI), httpx (Replicate, Musicful)
- DeepFilterNet3 for stem isolation, ffprobe / ffmpeg for media introspection + pre-trim
- pyyaml for plugin manifest loader

## Getting started

```bash
# Frontend
npm install
npm run dev          # Vite dev server

# Backend (in scenecraft-engine/)
uv sync              # or: pip install -e .
python -m scenecraft.api_server
```

Optional environment variables for paid-API plugins (BYO mode):
- `ANTHROPIC_API_KEY` — Claude chat
- `GOOGLE_API_KEY` — Imagen / Veo / GenAI
- `MUSICFUL_API_KEY` — music generation
- `REPLICATE_API_TOKEN` — foley + transcribe

## Status

Active development. 9 milestones completed (M1, M9-audio, M10, M11, M14, M16, M18, M19, plus parts of M3/M4/M6/M7/M17). Recent shipments include the foley generation plugin (M18, MMAudio via Replicate) and the light show scene editor MVP with WebSerial DMX output (M19). In flight: source monitor panel (M20), audio-reactive light routing, version-control UI surface, and the M9 explorer panel.

See `agent/progress.yaml` for the per-milestone breakdown and `agent/design/` for ~35 design specifications covering individual subsystems.

## Project structure

```
scenecraft/                       # frontend (this repo)
  src/
    components/editor/            # Timeline, AudioLane, panels
    plugins/                      # frontend plugin modules
    routes/                       # TanStack routes
    lib/                          # plugin-api, plugin-host, audio-mixer, etc.
  agent/                          # ACP documentation
    design/                       # architectural specs
    milestones/                   # M1..M21
    tasks/                        # per-task design + status
    clarifications/               # decision logs
    reports/                      # audit reports
    progress.yaml                 # canonical milestone + task tracker

../scenecraft-engine/             # backend (sibling repo)
  src/scenecraft/
    plugin_api/                   # narrow plugin surface
      providers/replicate.py      # typed providers
    plugins/                      # backend plugin modules
    chat.py                       # chat dispatch + tool registry
    api_server.py                 # REST + WS server
    db.py                         # SQLite schema + helpers
```
