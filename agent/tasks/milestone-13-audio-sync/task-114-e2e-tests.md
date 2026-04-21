# Task 114: E2E Tests + Mocked sync.so Harness

**Milestone**: [M13 - Audio Sync Tab](../../milestones/milestone-13-audio-sync.md)
**Design Reference**: [local.audio-sync.md](../../design/local.audio-sync.md)
**Estimated Time**: 3 hours
**Dependencies**: Tasks 106–113 (full stack complete)
**Status**: Not Started

---

## Objective

End-to-end tests for the Audio Sync flow with a mocked sync.so (and mocked ElevenLabs for S2S + voice list). Tests run in CI without any real API keys.

Implements in `scenecraft/tests/` (frontend E2E) and extends `scenecraft-engine/tests/test_lipsync.py` (integration).

---

## Steps

### 1. Mocked sync.so fixture server

Create a small aiohttp / flask-like fixture server used in integration tests:

- `POST /v2/generate` → returns `{ id: 'test-job-abc', status: 'PROCESSING' }`
- `GET /v2/generate/{id}` → first 2 calls return `PROCESSING`, third returns `COMPLETED` with an `outputUrl` that points to a static fixture MP4 on the test server
- `GET /outputs/fixture.mp4` → returns the fixture MP4 bytes

Point the sync_client at the fixture server via a monkey-patched base URL (env var `SYNC_API_BASE` or equivalent).

Reuse across `test_lipsync.py` integration tests.

### 2. Mocked ElevenLabs fixture

For S2S and voice list tests:
- `GET /v1/voices` → returns a fixed list with one premade voice
- `POST /v1/speech-to-speech/{voice_id}` → returns a fixture MP3 (small)

Same env-var redirection approach.

### 3. Backend integration tests

Extend `scenecraft-engine/tests/test_lipsync.py`:

```python
def test_lipsync_tts_end_to_end(project_dir, mock_sync):
    # Setup: a transition + one raw candidate
    ...
    job_id = post_lipsync(project_dir, tr_id=..., mode='tts', voice_id=..., script='hello')
    wait_for_job(job_id)
    # Assert
    candidates = get_tr_candidates(project_dir, tr_id=..., slot=0)
    variants = [c for c in candidates if c['variantKind'] == 'lipsync']
    assert len(variants) == 1
    v = variants[0]
    assert v['derivedFrom'] == source_pool_segment_id
    assert Path(project_dir / v['poolPath']).exists()

def test_lipsync_s2s_end_to_end(project_dir, mock_sync, mock_elevenlabs):
    # Same shape, but submits mode='s2s' with a source audio pool_segment_id
    ...

def test_lipsync_no_auto_select(project_dir, mock_sync):
    # Pre-select a raw candidate
    # Run lipsync → variant lands in grid
    # Assert transitions.selected[slot] still points at the raw, not the variant
    ...
```

### 4. Frontend E2E (Playwright or the existing E2E harness)

`tests/e2e/audio-sync.spec.ts`:

```typescript
test('audio sync: generate, hover, select', async ({ page }) => {
  await openProjectWithFixture(page, 'one-transition-one-candidate')
  await page.getByRole('tab', { name: 'Audio Sync' }).click()

  // Form
  await page.getByRole('combobox', { name: 'Voice' }).selectOption({ index: 0 })
  await page.getByRole('textbox', { name: 'Script' }).fill('Hello world')
  await page.getByRole('button', { name: 'Generate' }).click()

  // Placeholder appears
  await expect(page.getByTestId('audio-sync-placeholder')).toBeVisible()

  // Mocked sync.so completes; new card appears
  await expect(page.getByTestId('audio-sync-card')).toHaveCount(1, { timeout: 10_000 })

  // Hover chip → raw source plays
  const chip = page.getByText('from v1')
  await chip.hover()
  await expect(page.locator('[data-testid="preview-video"]'))
    .toHaveAttribute('data-pool-segment-id', <raw-id>)

  // Hover card body → synced output plays
  await page.getByTestId('audio-sync-card').first().hover()
  await expect(page.locator('[data-testid="preview-video"]'))
    .toHaveAttribute('data-pool-segment-id', <variant-id>)

  // Release → snaps to playhead
  await page.mouse.move(0, 0)
  await expect(page.locator('[data-testid="preview-video"]'))
    .toHaveAttribute('data-pool-segment-id', <currently-selected-raw-id>)

  // Click → selects variant
  await page.getByTestId('audio-sync-card').first().click()
  // Timeline reflects the variant
  ...
})

test('audio sync: candidates tab hides variants', async ({ page }) => {
  // With a variant existing, Candidates tab should only show raws
  ...
})

test('audio sync: resync produces new take', async ({ page }) => {
  // Create one variant, click Resync on it, assert 2 variants
  ...
})
```

### 5. CI wiring

Ensure the fixture servers start before the tests and tear down after. If the existing test harness has a global fixture setup, piggyback on it; otherwise add per-test-file fixtures.

Document in the test file's docstring how to run these tests with real APIs (manual smoke) vs mocked (default).

---

## Verification

- [ ] `test_lipsync_tts_end_to_end` passes against mocked sync.so
- [ ] `test_lipsync_s2s_end_to_end` passes against mocked sync.so + ElevenLabs
- [ ] `test_lipsync_no_auto_select` passes
- [ ] Frontend E2E: generate → hover → click → timeline flow passes
- [ ] Frontend E2E: Candidates tab hides variants
- [ ] Frontend E2E: Resync produces a new take
- [ ] Tests run in CI without any real API keys
- [ ] Real-API smoke path documented in the test file (manual only)
