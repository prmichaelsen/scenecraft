# beatlab-synthesizer

Feature-rich web frontend for the beatlab pipeline — waveform editing, hit markers, AI effect direction, candidate selection, image generation, and DaVinci Resolve integration via headless backend.

> Built with [Agent Context Protocol](https://github.com/prmichaelsen/agent-context-protocol)

## Quick Start

```bash
npm install
npm run dev
```

## Features

- Waveform editor with beat overlay and hit marker placement
- Sensation-based effect classification (hit, drop, swell, punch, freeze, bloom, shake)
- Per-marker intensity control with visual feedback
- AI effect direction and style prompt authoring
- Candidate generation and selection UI
- Image generation pipeline controls
- DaVinci Resolve headless backend integration
- Cloud GPU render management

## Tech Stack

- **Framework**: TanStack Start (React)
- **Deployment**: Cloudflare
- **Audio**: wavesurfer.js
- **Backend**: beatlab Python CLI + DaVinci Resolve headless API

## Development

This project uses the Agent Context Protocol for development:

- `@acp.init` - Initialize agent context
- `@acp.plan` - Plan milestones and tasks
- `@acp.proceed` - Continue with next task
- `@acp.status` - Check project status

See [AGENT.md](./AGENT.md) for complete ACP documentation.

## Project Structure

```
beatlab-synthesizer/
├── AGENT.md              # ACP methodology
├── agent/                # ACP directory
│   ├── design/          # Design documents
│   ├── milestones/      # Project milestones
│   ├── tasks/           # Task breakdown
│   ├── patterns/        # Architectural patterns
│   └── progress.yaml    # Progress tracking
├── app/                  # TanStack Start app
│   ├── routes/          # File-based routes
│   └── components/      # React components
└── public/              # Static assets
```

## Getting Started

1. Initialize context: `@acp.init`
2. Plan your project: `@acp.plan`
3. Start building: `@acp.proceed`

## License

MIT

## Author

Patrick Michaelsen
