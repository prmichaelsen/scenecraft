# Task 112: Wire Generate + Resync to Live Endpoint

**Milestone**: [M13 - Audio Sync Tab](../../milestones/milestone-13-audio-sync.md)
**Design Reference**: [local.audio-sync.md](../../design/local.audio-sync.md)
**Estimated Time**: 3 hours
**Dependencies**: Task 107 (backend TTS), Task 108 (backend S2S), Task 110 (tab scaffold)
**Status**: Not Started

---

## Objective

Connect the generate form's Generate button and each card's Resync button to the live `/lipsync` endpoint. Handle job progress WS events so new takes appear in the grid on completion. Do NOT auto-select the new take.

Implements in `scenecraft/src/lib/scenecraft-client.ts` and `AudioSyncTab.tsx`.

---

## Steps

### 1. Client methods

In `src/lib/scenecraft-client.ts`:

```typescript
export async function postLipsyncTts(
  projectName: string,
  trId: string,
  body: {
    source_pool_segment_id: string
    voice_id: string
    script: string
    options?: { sync_mode?: 'cut_off' | 'loop' | 'bounce'; slot?: number }
  }
): Promise<{ jobId: string }> {
  return fetchJson(`/api/projects/${projectName}/transitions/${trId}/lipsync`, {
    method: 'POST',
    body: JSON.stringify({ ...body, mode: 'tts' }),
  })
}

export async function postLipsyncS2s(
  projectName: string,
  trId: string,
  body: {
    source_pool_segment_id: string
    voice_id: string
    source_audio_ref?: string
    options?: { sync_mode?: 'cut_off' | 'loop' | 'bounce'; slot?: number }
  },
  audioFile?: File,
): Promise<{ jobId: string }> {
  // If audioFile provided, multipart; else JSON with source_audio_ref
  ...
}
```

### 2. Generate flow

In `AudioSyncTab.GenerateForm.onSubmit`:

1. Build params from form state
2. Call `postLipsyncTts` or `postLipsyncS2s` based on `mode`
3. Subscribe to job events for the returned `jobId`:
   - `job_progress` → update a small progress indicator on the form (e.g. inline spinner + phase text)
   - `job_completed` → invalidate the transitions query (triggers refetch → new candidate appears in grid)
   - `job_failed` → toast with error
4. Don't clear the form after submit — user may want to tweak and resubmit

The transitions query already refetches via the existing WS job-completion pattern — piggyback on it rather than inventing new invalidation.

### 3. Resync flow

On each variant card, a **Resync** action in the card menu (or a top-level button — match the Bench button's placement):

```typescript
function onResync(variant: CandidateDetail) {
  const params = variant.generationParams  // recorded at creation time (Task 107/108)
  if (params?.mode === 'tts') {
    return postLipsyncTts(projectName, trId, {
      source_pool_segment_id: variant.derivedFrom!,
      voice_id: params.voiceId,
      script: params.script,
      options: params.options,
    })
  }
  if (params?.mode === 's2s') {
    return postLipsyncS2s(projectName, trId, {
      source_pool_segment_id: variant.derivedFrom!,
      voice_id: params.voiceId,
      source_audio_ref: params.sourceAudioRef,
      options: params.options,
    })
  }
  throw new Error('Cannot resync: variant has no recorded mode')
}
```

Same WS subscription/invalidation as the Generate flow.

### 4. No auto-select

After `job_completed`, the grid refreshes and the new card is visible. The transition's `selected[slot]` is NOT updated. The user must click the card to promote it.

Verify this by asserting in the test (Task 114) that `transitions.selected[slot]` remains unchanged after generation completes.

### 5. In-flight UI

While a job is in flight, show a placeholder card in the grid (spinner + phase text) so the user has feedback during the ~15–60s sync.so latency. Use the `job_progress` event's `phase` field for the label.

On completion, the placeholder is removed and the real card takes its place (natural consequence of the query invalidation).

### 6. Tests

- Unit: `postLipsyncTts` / `postLipsyncS2s` build the expected request body
- Unit: Resync correctly reconstructs params from a variant's `generationParams`
- Integration (mocked WS + endpoint):
  - Generate → job events stream → grid shows placeholder → job_completed → grid shows new card → `selected[slot]` unchanged
  - Resync on an existing variant → same pipeline, using recorded params

---

## Verification

- [ ] Generate button fires the correct endpoint based on mode
- [ ] WS `job_progress` events drive a visible in-flight placeholder in the grid
- [ ] `job_completed` triggers a transitions query refetch; the new variant appears
- [ ] `transitions.selected[slot]` is not changed by generation completion
- [ ] Resync on a variant replays its recorded mode + params and produces a new take
- [ ] Generate form remains filled after submit (not cleared)
- [ ] `job_failed` surfaces a toast with a meaningful message
