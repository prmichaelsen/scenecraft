# Task 60: ElevenLabs Voice List Proxy + Sample Preview Cache

**Objective**: Proxy ElevenLabs `/v1/voices` through scenecraft-engine with short-lived cache; serve cached voice sample MP3s for the picker UI
**Milestone**: M8 — Characters & Lip-Sync
**Priority**: P1
**Repo**: scenecraft-engine
**Estimated Hours**: 3
**Status**: Not Started

---

## Context

The Characters panel voice picker needs to show all available ElevenLabs voices with playable samples. We proxy the API through the server (so the `ELEVENLABS_API_KEY` never reaches the browser) and cache aggressively — the voice list is stable and sample MP3s are small and reusable.

## Design Reference

- [Characters and Lip-Sync](../../design/local.characters-and-lipsync.md) — API Endpoints section

## Steps

1. Add `GET /api/projects/:name/elevenlabs/voices`:
   - Reads server-side `ELEVENLABS_API_KEY` env var
   - Calls `https://api.elevenlabs.io/v1/voices` with `xi-api-key` header
   - Caches response in-memory for 5 minutes (LRU with TTL)
   - Returns voice list as JSON passthrough, minus private fields
   - Returns 500 if `ELEVENLABS_API_KEY` not set

2. Add `GET /api/projects/:name/elevenlabs/voices/:voiceId/preview`:
   - Checks disk cache: `.scenecraft/cache/voice_previews/{voiceId}.mp3`
   - If missing, calls ElevenLabs TTS with a fixed phrase (e.g. "The quick brown fox jumps over the lazy dog") using `eleven_multilingual_v2` model, saves to cache
   - Serves the cached MP3 with `Content-Type: audio/mpeg`
   - LRU-evict the cache when it exceeds 100 entries (oldest by mtime)

3. Frontend client functions:
   - `fetchElevenLabsVoices(project)` — returns voice list
   - `elevenLabsVoicePreviewUrl(project, voiceId)` — returns URL for `<audio>` src

4. Unit tests for cache hit/miss behavior and LRU eviction.

## Verification

- [ ] `GET /elevenlabs/voices` returns cached list with `<=5min` TTL
- [ ] `GET /elevenlabs/voices/:voiceId/preview` returns MP3 on first call (slower) and on subsequent calls (fast, cached)
- [ ] Cache evicts oldest entries at >100 items
- [ ] No API key leaks to frontend
- [ ] Unit tests pass

---

**Dependencies**: None
