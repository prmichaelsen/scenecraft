# Task 113: ElevenLabs Voice List (Client-Side Fetch + Cache)

**Milestone**: [M13 - Audio Sync Tab](../../milestones/milestone-13-audio-sync.md)
**Design Reference**: [local.audio-sync.md](../../design/local.audio-sync.md)
**Estimated Time**: 2 hours
**Dependencies**: Task 110 (voice dropdown exists with placeholder)
**Status**: Not Started

---

## Objective

Populate the voice dropdown in the Audio Sync tab's generate form with the user's ElevenLabs voices. Client-side fetch for MVP; server proxy is deferred to M8 Task-60.

Implements in `scenecraft/src/lib/elevenlabs-client.ts`.

---

## Steps

### 1. API key source

MVP reads `ELEVENLABS_API_KEY` from project settings (inspect where other per-project keys live — likely a settings store or env-like mechanism). The key is transiently held in memory; do NOT log it or send it to the scenecraft backend.

If no key is configured, the voice dropdown shows a single "Configure ElevenLabs API key" disabled option. Clicking it opens the existing settings panel/drawer (or a new one — match existing UX for other API-key settings like `SYNC_API_KEY` if one exists).

### 2. Fetch client

`src/lib/elevenlabs-client.ts`:

```typescript
type Voice = {
  voice_id: string
  name: string
  category: 'premade' | 'cloned' | 'professional' | 'generated'
  labels?: Record<string, string>
  preview_url?: string
}

let cache: { voices: Voice[]; fetchedAt: number } | null = null
const CACHE_TTL_MS = 5 * 60 * 1000

export async function listVoices(apiKey: string, force = false): Promise<Voice[]> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.voices
  }
  const res = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey },
  })
  if (!res.ok) throw new Error(`ElevenLabs voices list failed: ${res.status}`)
  const data = await res.json()
  cache = { voices: data.voices, fetchedAt: Date.now() }
  return data.voices
}

export function invalidateVoiceCache() {
  cache = null
}
```

In-memory cache only; refreshes on force or after TTL.

### 3. Hook

`src/lib/use-elevenlabs-voices.ts`:

```typescript
export function useElevenLabsVoices() {
  const apiKey = useElevenLabsApiKey()  // reads from settings store
  return useQuery({
    queryKey: ['elevenlabs-voices', apiKey ? 'present' : 'missing'],
    queryFn: () => (apiKey ? listVoices(apiKey) : Promise.resolve([])),
    staleTime: 5 * 60 * 1000,
  })
}
```

(Use the existing query-client pattern in the codebase — TanStack Query likely.)

### 4. Wire into the form

In the GenerateForm (from Task 110):

```typescript
const { data: voices = [], isLoading, error } = useElevenLabsVoices()

<Select value={voiceId} onValueChange={setVoiceId} disabled={isLoading || voices.length === 0}>
  <SelectTrigger>
    <SelectValue placeholder={voices.length === 0 ? 'Configure ElevenLabs API key…' : 'Select voice'} />
  </SelectTrigger>
  <SelectContent>
    {voices.map(v => (
      <SelectItem key={v.voice_id} value={v.voice_id}>
        {v.name} — <span className="opacity-60">{v.category}</span>
      </SelectItem>
    ))}
  </SelectContent>
</Select>
```

Group the voices by category (premade / cloned / generated) if the existing select component supports grouped options; otherwise render the category as a suffix on each item.

### 5. Preview (stretch)

If time permits: add a small "▶ preview" button next to each voice in the dropdown that plays the voice's `preview_url` (ElevenLabs returns this for most voices). Skip if out of scope.

### 6. Tests

- Unit: `listVoices` returns cached voices within TTL; refetches after TTL
- Unit: 401 / missing key surfaces a clear error
- Unit: `invalidateVoiceCache` clears the cache
- Component: dropdown renders voice list from the hook; placeholder when key is missing
- No network call in tests — mock `fetch`

---

## Verification

- [ ] Voice dropdown populates with the user's voices when an API key is configured
- [ ] "Configure ElevenLabs API key…" placeholder when the key is absent
- [ ] Fetched voices cached in memory for 5 minutes
- [ ] Manual cache invalidation works (`invalidateVoiceCache()`)
- [ ] API key never logged and never sent to the scenecraft backend
- [ ] No regression in the Generate flow when no voices are available (Generate button remains disabled)
