# Spec: Waveform Peak Cache and Rendering

> **Agent Directive**: This spec defines the exact observable behavior of the
> frontend waveform subsystem (peak fetching/caching + canvas rendering). Every
> scenario a reviewer might care about is catalogued in the Behavior Table,
> including `undefined` rows for behaviors that are not decided in the current
> implementation. Do NOT guess undefined behavior into a test — route it to
> Open Questions.

**Namespace**: local
**Spec Name**: waveform-cache-and-rendering
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Retroactive (describes shipped behavior as of audit #2)

---

## Purpose

Define the contract of the frontend waveform subsystem: how peak arrays are
fetched from the backend, cached, de-duplicated across concurrent callers, and
rendered onto a horizontally-tiled canvas row inside the timeline editor.

## Source

- Retroactive black-box spec
- Code under spec:
  - `src/lib/waveform-cache.ts` (peak fetch + cache + invalidate)
  - `src/components/editor/AudioWaveform.tsx` (tiled canvas rendering)
- Backend endpoint (out-of-scope for algorithm, in-scope as wire contract):
  - `GET /api/projects/:name/audio-clips/:id/peaks?resolution=N`
  - `GET /api/projects/:name/pool/:seg_id/peaks?resolution=N` (parallel route
    for raw pool segments — currently not reached through `fetchPeaks`)
- Audit reference: `agent/reports/audit-2-architectural-deep-dive.md` §1E unit 9

## Scope

### In scope
- `fetchPeaks(project, clipId, resolution?)` public API.
- In-memory cache keyed by `${project}:${clipId}:${resolution}`.
- Concurrent-request de-duplication via a shared pending `Promise`.
- `invalidatePeaks(project, clipId)` cache eviction API.
- Wire format: little-endian IEEE-754 float16 over `application/octet-stream`,
  decoded client-side to `Float32Array`.
- React component `<AudioWaveform>` lifecycle: fetch-on-mount / on-clip-change,
  loading state (no paint), error state (container hidden via `opacity: 0`).
- Canvas tiling strategy (fixed `TILE_WIDTH_CSS_PX = 2048` tiles, one canvas
  per tile, sized at `devicePixelRatio`).
- Per-tile peak-slice selection, max-pool-to-pixel draw loop, mirrored
  vertical peak lines about the tile's vertical midpoint.
- Width guard (`width < 16` renders nothing).

### Out of scope
- Backend peak computation algorithm (`compute_peaks` in
  `scenecraft.audio.peaks`) — server-side, not specified here.
- The pool-segment variant (`/pool/:seg_id/peaks`) — endpoint exists but
  `fetchPeaks` only addresses the audio-clip route today.
- Scroll virtualization (no scroll-based redraw exists — all tiles for the
  component's full `width` are mounted simultaneously; see OQ-1).
- LRU / size-bounded eviction policy (cache is unbounded by design — see OQ-2).
- Alternative render targets (WebGL, SVG) — canvas-2D is the only renderer.

---

## Requirements

1. **R1** — `fetchPeaks(project, clipId, resolution=400)` returns a `Promise<Float32Array>` of peaks for the given clip.
2. **R2** — Successful fetches are cached by key `${project}:${clipId}:${resolution}`; subsequent calls with the same key resolve synchronously (same-tick) from cache without a network request.
3. **R3** — Concurrent calls for the same key while a fetch is in flight share the same Promise; exactly one network request is issued.
4. **R4** — After the in-flight fetch settles (success or failure), the entry is removed from the in-flight map.
5. **R5** — On successful response, the body is decoded as little-endian uint16 (float16) and converted element-wise to `Float32Array` using IEEE-754 half-float rules (including subnormals, ±Inf, NaN).
6. **R6** — On non-OK HTTP status (e.g. 404, 500), the returned Promise rejects with `Error("peaks fetch <status>")`; nothing is written to the cache.
7. **R7** — `invalidatePeaks(project, clipId)` deletes every cache entry whose key begins with `${project}:${clipId}:`, across all resolutions.
8. **R8** — `invalidatePeaks` does NOT cancel or evict in-flight requests; a fetch in flight when invalidate is called will still populate the cache when it lands (see OQ-3).
9. **R9** — `<AudioWaveform>` calls `fetchPeaks` once per `(projectName, clipId, durationSeconds, resolution)` tuple change; unmount/clip-change sets a `cancelled` flag so late fulfillments do not set state on an unmounted instance.
10. **R10** — Rendering is performed by one `<canvas>` element per tile; each tile's CSS width is `min(TILE_WIDTH_CSS_PX, remaining)` where `TILE_WIDTH_CSS_PX = 2048`; total tiles = `ceil(width / TILE_WIDTH_CSS_PX)`.
11. **R11** — Each canvas's backing-buffer dimensions are `floor(widthCss * dpr)` × `floor(height * dpr)` with `dpr = window.devicePixelRatio || 1`, and a minimum of 1 px per axis.
12. **R12** — Each tile draws exactly `pxW` vertical lines; for output pixel `x`, the displayed peak is the **max** of peaks in index range `[floor(peakStart + (x/pxW)*peakSpan), max(i0+1, floor(peakStart + ((x+1)/pxW)*peakSpan))]` where `peakStart`, `peakSpan` are derived from the tile's CSS-coordinate slice of the full waveform.
13. **R13** — Lines are drawn mirrored about the tile vertical midpoint (`mid = pxH/2`), extending `max(1, m * (pxH-2) * 0.5)` pixels up and down, with `strokeStyle = color`, `lineWidth = max(1, dpr * 0.8)`.
14. **R14** — When `width < 16` OR `durationSeconds <= 0`, the component renders `null` (no DOM, no canvases, no fetch — `useEffect` fetch is also guarded).
15. **R15** — While `peaks === null` (loading) the component's outer `<div>` is rendered with `opacity: 0.9` and individual tile canvases are mounted but undrawn; on `failed === true` the outer div is rendered with `opacity: 0`.
16. **R16** — The outer rendering container is `pointer-events: none` (non-interactive) and absolutely positioned to fill its parent (`absolute inset-0`).
17. **R17** — The cache has no eviction policy; size is bounded only by editor-session lifetime.

---

## Interfaces / Data Shapes

### TypeScript API

```ts
// src/lib/waveform-cache.ts
export function fetchPeaks(
  project: string,
  clipId: string,
  resolution?: number,   // default 400 peaks/sec
): Promise<Float32Array>

export function invalidatePeaks(project: string, clipId: string): void
```

### Cache key

```
CacheKey = `${project}:${clipId}:${resolution}`
```

### React component props

```ts
type AudioWaveformProps = {
  projectName: string
  clipId: string
  width: number          // CSS px
  height: number         // CSS px
  durationSeconds: number
  color?: string         // default '#22d3ee'
  resolution?: number    // default 400
}
```

### Wire format

- **Request**: `GET {VITE_SCENECRAFT_API_URL}/api/projects/{project}/audio-clips/{clipId}/peaks?resolution={N}` where both path segments are `encodeURIComponent`-escaped.
- **Response**:
  - Success: `200 OK`, `Content-Type: application/octet-stream`, headers `X-Peak-Resolution: N`, `X-Peak-Duration: <seconds>`, body = raw bytes, little-endian uint16, length = `2 * ceil(duration * resolution)` bytes (2 bytes per float16 peak). Peaks are non-negative amplitudes in `[0, 1]` nominally (magnitudes; clipping to ≤1 is not guaranteed by this spec).
  - Error: non-2xx with a JSON body `{code, message}` from the backend error helper. The client ignores the body and uses the status line.
- **Decode**: `Uint16Array(buf)` → per-element float16→float32 bit-twiddle (sign bit 15, 5-bit exponent, 10-bit mantissa; subnormals when `e==0`; ±Inf/NaN when `e==0x1f`).

### Tile geometry

- `TILE_WIDTH_CSS_PX = 2048`
- Tile count: `max(1, ceil(width / TILE_WIDTH_CSS_PX))` only when `width >= 16`
- Tile `i`: `leftCss = i * TILE_WIDTH_CSS_PX`, `widthCss = min(TILE_WIDTH_CSS_PX, width - leftCss)`; dropped if `widthCss <= 0`.

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | First call for a (project, clipId, resolution) | Issues GET, decodes float16, caches Float32Array, resolves with it | `first-call-fetches-and-caches` |
| 2 | Second call for same key after success | Resolves from cache without network | `second-call-is-cache-hit` |
| 3 | Two concurrent calls for same key | Exactly one network request; both callers get the same Promise/result | `concurrent-calls-dedupe` |
| 4 | Call for different resolution on same clip | Issues a separate fetch; cached independently | `different-resolution-different-entry` |
| 5 | Call for different clip | Issues separate fetch; cached under its own key | `different-clip-different-entry` |
| 6 | In-flight map cleanup on success | Key removed from `inflight` after resolve | `inflight-cleared-on-success` |
| 7 | In-flight map cleanup on failure | Key removed from `inflight` after reject | `inflight-cleared-on-failure` |
| 8 | Backend returns non-OK status | Promise rejects with `Error("peaks fetch <status>")`; cache untouched | `non-ok-status-rejects-and-does-not-cache` |
| 9 | Backend returns 404 | Rejects with `Error("peaks fetch 404")`; cache untouched | `status-404-rejects` |
| 10 | `invalidatePeaks(project, clipId)` evicts all resolutions for that clip | All matching keys removed; other projects/clips untouched | `invalidate-removes-matching-keys`, `invalidate-preserves-other-clips` |
| 11 | `invalidatePeaks` called with no cached entries | No-op, no throw | `invalidate-noop-on-empty` |
| 12 | `<AudioWaveform>` mount with valid props | One `fetchPeaks` call; tiles render after resolve | `waveform-mount-fetches-once` |
| 13 | Clip change while prior fetch pending | Prior `cancelled` flag prevents stale `setPeaks`; new fetch runs | `clip-change-cancels-prior-setstate` |
| 14 | Width 2048 with dpr=2 | One tile, canvas backing = 4096 × 2*height | `single-tile-at-exact-width` |
| 15 | Width 5000 | Three tiles at widths 2048, 2048, 904 | `multi-tile-partitioning` |
| 16 | Width 15 | Component returns null; no canvases, no fetch | `below-min-width-renders-nothing` |
| 17 | `durationSeconds <= 0` | Component returns null; no fetch | `zero-duration-renders-nothing` |
| 18 | Loading (peaks null) | Outer div present with opacity 0.9; canvases mounted but undrawn | `loading-shows-empty-canvases` |
| 19 | Error state (`failed=true`) | Outer div opacity 0; no visible waveform | `error-hides-container` |
| 20 | Peaks array shorter than output pixels (zoomed in) | Each peak covers multiple output pixels; no out-of-bounds reads | `zoomed-in-stretches-peaks` |
| 21 | Peaks array longer than output pixels (zoomed out) | Max-pool across peak slice per output pixel | `zoomed-out-max-pools-peaks` |
| 22 | Container is non-interactive | Outer div has `pointer-events: none` | `container-pointer-events-none` |
| 23 | Cache grows without bound | No eviction; entries persist for session lifetime | `cache-has-no-eviction-policy` |
| 24 | `fetchPeaks` for a pool_segment id that was deleted upstream | `undefined` | → [OQ-4](#open-questions) |
| 25 | Cache size limit / leak protection | `undefined` — no limit exists | → [OQ-2](#open-questions) |
| 26 | `invalidatePeaks` fires while request in-flight | `undefined` — in-flight fetch still populates cache after invalidate returns | → [OQ-3](#open-questions) |
| 27 | Backend returns 404 specifically (vs any non-OK) | Same as non-OK rejection; no special retry or UI | `status-404-rejects` |
| 28 | Malformed float16 bytes (odd length, NaN exponent fields) | `undefined` — `Uint16Array` truncates odd byte lengths; NaN/Inf propagate to canvas math | → [OQ-5](#open-questions) |
| 29 | Canvas allocated with `width=0` (e.g. tile widthCss rounds to 0) | Clamped to 1 px internal buffer via `Math.max(1, …)`; tile drawn as single blank column | `canvas-min-1px-backing` |
| 30 | `devicePixelRatio` is undefined or 0 | Falls back to 1 via `window.devicePixelRatio || 1` | `dpr-fallback-to-1` |
| 31 | Scroll virtualization (render only visible tiles) | `undefined` — all tiles for full `width` mount simultaneously; no viewport culling | → [OQ-1](#open-questions) |
| 32 | `resolution=0` passed to `fetchPeaks` | `undefined` — key is valid but backend behavior at resolution=0 unspecified | → [OQ-6](#open-questions) |
| 33 | Pool-segment variant via `fetchPeaks` | `undefined` — `fetchPeaks` hits audio-clips route only; pool route not addressed | → [OQ-7](#open-questions) |
| 34 | AbortController / cancellation of in-flight fetch | `undefined` — no AbortController wired; component cancels React state update only | → [OQ-8](#open-questions) |

---

## Behavior (step-by-step)

### `fetchPeaks(project, clipId, resolution=400)`

1. Compute `key = ${project}:${clipId}:${resolution}`.
2. If `cache.has(key)` → return `Promise.resolve(cache.get(key))` (as a microtask resolution via `async` function return).
3. Else if `inflight.has(key)` → return the existing pending Promise.
4. Else:
   1. Build URL `${SCENECRAFT_API_URL}/api/projects/${enc(project)}/audio-clips/${enc(clipId)}/peaks?resolution=${resolution}`.
   2. Issue `fetch(url)`.
   3. On `res.ok === false` → throw `Error("peaks fetch " + res.status)`.
   4. On ok: read `ArrayBuffer`, wrap as `Uint16Array`, allocate a `Float32Array` of equal length, decode each element via IEEE-754 float16→float32, store into cache under `key`, return the `Float32Array`.
   5. In `.finally()`: remove `key` from `inflight`.
   6. Register the promise in `inflight` under `key` **before** returning it.

### `invalidatePeaks(project, clipId)`

1. Iterate `Array.from(cache.keys())`.
2. For any key starting with `${project}:${clipId}:`, call `cache.delete(key)`.
3. Does not touch `inflight`.

### `<AudioWaveform>`

1. On mount / prop change (`projectName`, `clipId`, `durationSeconds`, `resolution`):
   - If `!clipId || durationSeconds <= 0` → skip fetch.
   - Else call `fetchPeaks(projectName, clipId, resolution)`; on resolve, `setPeaks(p)` unless `cancelled`; on reject, `setFailed(true)` unless `cancelled`.
   - Cleanup sets `cancelled = true`.
2. Compute tile list (memoized on `width`): empty array if `width < 16`, else partition `[0, width)` into ≤ `TILE_WIDTH_CSS_PX`-wide segments.
3. Render `null` if `width < 16 || durationSeconds <= 0`.
4. Else render outer div (absolute, pointer-events-none, `opacity = failed ? 0 : 0.9`) containing one `<WaveformTile>` per tile.
5. Each `<WaveformTile>` `useEffect` on (`peaks`, `widthCss`, `height`, `color`, `leftCss`, `totalWidthCss`):
   - If `!peaks` → no draw.
   - Size canvas backing buffer to `dpr`-scaled CSS size, clamped ≥ 1 px.
   - Clear, compute `peakStart`/`peakEnd`/`peakSpan` from `[leftCss, leftCss+widthCss) / totalWidthCss * n`.
   - For each output pixel `x` in `[0, pxW)`: max-pool peaks in `[i0, i1)` → line from `(x+0.5, mid-h)` to `(x+0.5, mid+h)`.
   - Single `ctx.stroke()` at the end.

---

## Acceptance Criteria

- [ ] Calling `fetchPeaks` twice in the same tick with no prior cache entry results in exactly one `fetch()` call observed on the network.
- [ ] After successful fetch, a third call returns from cache without a new `fetch()`.
- [ ] `invalidatePeaks(p, c)` removes entries across every resolution for `(p, c)` and no others.
- [ ] `<AudioWaveform>` with `width=0` / `width<16` / `durationSeconds<=0` renders `null`.
- [ ] `<AudioWaveform>` with `width=5000` renders exactly 3 canvas elements.
- [ ] Each canvas's `width` attribute equals `floor(cssWidth * devicePixelRatio)` (≥ 1).
- [ ] Non-OK HTTP response causes the component to render with opacity 0; no throw escapes to the React tree.
- [ ] No test of internals: all assertions are observable via DOM, network, or public return values.

---

## Tests

### Base Cases

#### Test: first-call-fetches-and-caches (covers R1, R2, R5)

**Given**: empty module-level cache and inflight maps; mock `fetch` returns a 200 response with an ArrayBuffer encoding `[0x0000, 0x3C00]` (little-endian uint16 = +0, +1 in float16).

**When**: `await fetchPeaks('projX', 'clipA', 400)`.

**Then**:
- **network-called-once**: `fetch` was invoked exactly once with URL `…/api/projects/projX/audio-clips/clipA/peaks?resolution=400`.
- **returns-float32array-length-2**: resolved value is a `Float32Array` of length 2.
- **decoded-values**: element 0 is `+0`, element 1 is `+1`.
- **cache-populated**: a second `await fetchPeaks('projX','clipA',400)` issues **zero** additional `fetch` calls and returns the same `Float32Array` reference.

#### Test: second-call-is-cache-hit (covers R2)

**Given**: `fetchPeaks('p','c',400)` has already resolved.

**When**: `fetchPeaks('p','c',400)` is called again.

**Then**:
- **no-network**: `fetch` call count unchanged.
- **same-instance**: resolves to the identical `Float32Array` instance as the first call.

#### Test: concurrent-calls-dedupe (covers R3, R4)

**Given**: empty cache; `fetch` returns a pending Promise that resolves after a tick.

**When**: `fetchPeaks('p','c',400)` and `fetchPeaks('p','c',400)` are called in the same synchronous block; both awaited.

**Then**:
- **single-request**: exactly one `fetch` call made.
- **both-resolve-equal**: both awaits resolve to the same `Float32Array` reference.
- **inflight-empty-after**: after both resolve, the internal inflight map has no entry for the key (observed indirectly: a third call with the same key does NOT trigger a new request).

#### Test: different-resolution-different-entry (covers R2)

**Given**: empty cache.

**When**: `fetchPeaks('p','c',400)` then `fetchPeaks('p','c',800)` both awaited.

**Then**:
- **two-requests**: `fetch` called twice with different `resolution=` query strings.
- **separate-caching**: a repeat of either call hits its own cache entry (no extra network).

#### Test: different-clip-different-entry (covers R2)

**Given**: empty cache.

**When**: `fetchPeaks('p','c1',400)` then `fetchPeaks('p','c2',400)`.

**Then**:
- **two-requests**: two `fetch` calls, different clip path segments.

#### Test: inflight-cleared-on-success (covers R4)

**Given**: fetch pending.

**When**: the fetch resolves; after resolution, another call with same key is made.

**Then**:
- **second-call-is-cache-hit**: no additional network request (implies inflight was cleared AND cache was populated).

#### Test: inflight-cleared-on-failure (covers R4, R6)

**Given**: fetch rejects with network error, OR returns 500.

**When**: the first call settles (rejects); a second call with same key is issued.

**Then**:
- **second-call-issues-new-request**: a second `fetch` is made (the inflight entry was cleared, and cache was NOT populated on failure).
- **first-error-message**: first rejection's message is `peaks fetch 500` (for non-OK) or the underlying error (for network).

#### Test: non-ok-status-rejects-and-does-not-cache (covers R6)

**Given**: `fetch` returns `{ ok: false, status: 500 }`.

**When**: `await fetchPeaks('p','c',400)` (expected to throw).

**Then**:
- **rejects-with-status-message**: thrown Error has message `peaks fetch 500`.
- **cache-not-populated**: a subsequent call with the same key issues a new request.

#### Test: status-404-rejects (covers R6, scenario 9/27)

**Given**: `fetch` returns `{ ok: false, status: 404 }`.

**When**: `await fetchPeaks('p','missing',400)`.

**Then**:
- **rejects-404**: thrown Error has message `peaks fetch 404`.
- **no-special-retry**: exactly one `fetch` call; no retry, no backoff.

#### Test: invalidate-removes-matching-keys (covers R7)

**Given**: cache contains entries for `('p','c',400)`, `('p','c',800)`, `('p','c2',400)`, `('p2','c',400)`.

**When**: `invalidatePeaks('p','c')`.

**Then**:
- **p-c-400-gone**: a new `fetchPeaks('p','c',400)` issues a network request.
- **p-c-800-gone**: a new `fetchPeaks('p','c',800)` issues a network request.
- **p-c2-untouched**: `fetchPeaks('p','c2',400)` hits cache (no network).
- **p2-c-untouched**: `fetchPeaks('p2','c',400)` hits cache (no network).

#### Test: invalidate-preserves-other-clips (covers R7)

(Combined assertions in `invalidate-removes-matching-keys`; this row references the same test.)

#### Test: invalidate-noop-on-empty (covers R7)

**Given**: empty cache.

**When**: `invalidatePeaks('p','c')`.

**Then**:
- **no-throw**: returns `undefined` without throwing.
- **cache-still-empty**: subsequent `fetchPeaks('p','c',400)` issues a network request.

#### Test: waveform-mount-fetches-once (covers R9)

**Given**: `<AudioWaveform projectName='p' clipId='c' width=500 height=40 durationSeconds=10 />` rendered.

**When**: mounted.

**Then**:
- **one-fetch**: `fetchPeaks` called exactly once with `('p','c',400)`.
- **canvases-rendered**: after peaks resolve, the DOM contains one `<canvas>` (500 < 2048).

#### Test: clip-change-cancels-prior-setstate (covers R9)

**Given**: component mounted with clipId `c1`; `fetchPeaks('p','c1',400)` pending.

**When**: prop changes to `clipId = 'c2'` before `c1` resolves; then both fetches resolve.

**Then**:
- **two-fetches**: `fetchPeaks` called with `'c1'` and then `'c2'`.
- **no-stale-state**: after all settles, the rendered canvas reflects peaks for `c2` only (late resolution of `c1` did not overwrite state).

#### Test: single-tile-at-exact-width (covers R10, R11)

**Given**: `width=2048`, `height=40`, `dpr=2`.

**When**: rendered with peaks loaded.

**Then**:
- **one-canvas**: exactly 1 `<canvas>` in the DOM.
- **css-size**: `style.width === '2048px'`, `style.height === '40px'`.
- **backing-size**: `canvas.width === 4096`, `canvas.height === 80`.

#### Test: multi-tile-partitioning (covers R10)

**Given**: `width=5000`, `height=40`.

**When**: rendered with peaks loaded.

**Then**:
- **three-canvases**: 3 `<canvas>` elements.
- **widths**: CSS widths are 2048, 2048, 904 in left-to-right order.
- **offsets**: `style.left` is `0px`, `2048px`, `4096px`.

#### Test: below-min-width-renders-nothing (covers R14)

**Given**: `width=15`, `durationSeconds=10`.

**When**: rendered.

**Then**:
- **null-output**: no DOM output (component returns `null`).
- **no-fetch**: `fetchPeaks` is still called per effect (guarded only by clipId + duration), so a fetch MAY occur; this test's contract is only that the DOM is empty. (See OQ-9 — current code does issue a fetch for sub-16 widths.)

#### Test: zero-duration-renders-nothing (covers R14)

**Given**: `width=500`, `durationSeconds=0`.

**When**: rendered.

**Then**:
- **null-output**: no DOM output.
- **no-fetch**: `fetchPeaks` is NOT called (effect guards on `durationSeconds <= 0`).

#### Test: loading-shows-empty-canvases (covers R15)

**Given**: `fetchPeaks` returns a pending Promise.

**When**: rendered with `width=500`.

**Then**:
- **outer-div-present**: outer `<div>` is in DOM with inline `opacity: 0.9`.
- **canvas-present**: tile `<canvas>` mounted.
- **no-draw**: canvas has no stroked paths (cannot be introspected directly; asserted via `getContext('2d')` mock showing zero `stroke()` calls).

#### Test: error-hides-container (covers R15)

**Given**: `fetch` returns 500.

**When**: component renders and the fetch rejects.

**Then**:
- **opacity-0**: outer `<div>` has inline `opacity: 0`.
- **no-throw**: no uncaught promise rejection escapes; no error boundary fires.

#### Test: container-pointer-events-none (covers R16)

**Given**: component mounted with valid props.

**Then**:
- **pointer-events-none-on-container**: outer div has class or computed style `pointer-events: none`.
- **pointer-events-none-on-tiles**: each canvas has inline/class `pointer-events: none`.

#### Test: cache-has-no-eviction-policy (covers R17)

**Given**: 10,000 distinct `(project, clipId, resolution)` entries fetched and resolved sequentially.

**Then**:
- **all-remain-cached**: a repeat of any of the 10,000 calls issues zero network requests.
- **no-thrown-oom-in-test**: the test itself completes; this is an informational assertion — this behavior IS the leak called out in audit §1E unit 9.

### Edge Cases

#### Test: zoomed-in-stretches-peaks (covers R12)

**Given**: `peaks = Float32Array` of length 8, component `width = 800`, single tile.

**When**: rendered.

**Then**:
- **stroke-count-equals-pxW**: number of `moveTo`/`lineTo` pairs equals `pxW` (= `800 * dpr`).
- **no-out-of-bounds-reads**: no peak index ≥ 8 is read during the draw loop (observed via instrumented peaks array proxy).

#### Test: zoomed-out-max-pools-peaks (covers R12)

**Given**: `peaks = Float32Array([0,0,0,1,0,0,0,0])`, `width = 4`, one tile, `dpr = 1`.

**When**: rendered.

**Then**:
- **second-pixel-has-max-value**: the vertical line drawn at x=1 corresponds to `m = 1` (pooled from index 2–3); the other x values correspond to `m = 0`.
- **line-height-at-x1**: computed line half-height = `max(1, 1 * (pxH-2) * 0.5)` equals the rendered moveTo/lineTo y-span.

#### Test: canvas-min-1px-backing (covers R11)

**Given**: a tile for which `widthCss * dpr` rounds to 0 (e.g., widthCss=0.4, dpr=1).

**When**: rendered.

**Then**:
- **backing-width-≥1**: `canvas.width >= 1`.
- **backing-height-≥1**: `canvas.height >= 1`.
- **no-throw**: draw loop runs without exception.

#### Test: dpr-fallback-to-1 (covers R11)

**Given**: `window.devicePixelRatio = undefined` (or 0).

**When**: a tile renders at `widthCss=2048`, `height=40`.

**Then**:
- **backing-width-eq-cssWidth**: `canvas.width === 2048`.
- **backing-height-eq-cssHeight**: `canvas.height === 40`.

#### Test: concurrent-calls-dedupe (covered above; repeated here as an edge against race ordering)

(Dedicated assertion already in Base Cases.)

### Negative assertions (explicit)

These are assertions that appear within other tests; repeated here for scannability:

- `cache-not-populated` (R6): non-OK status does NOT write to cache.
- `no-stale-state` (R9): late resolution of a cancelled fetch does NOT mutate component state.
- `no-retry` (scenario 27): 404 does NOT trigger any automatic retry.
- `inflight-unaffected-by-invalidate` (OQ-3): `invalidatePeaks` does NOT remove inflight Promises (behavior flagged undefined because the consequence — stale cache post-invalidate — is not decided).
- `no-abort` (OQ-8): no `AbortController` is threaded through `fetchPeaks`.

---

## Non-Goals

- **Scroll virtualization** — `<AudioWaveform>` does not observe viewport visibility or scroll offset; it mounts tiles for the entire `width` it was given. Virtualization, if desired, is a parent concern.
- **Size-bounded cache** — no LRU, no max-entry-count, no per-entry TTL. Session-lifetime leak accepted.
- **Cancellation of in-flight fetches** — `fetchPeaks` has no `signal` parameter; component-level cancellation only prevents `setState`.
- **Pool-segment fetch via `fetchPeaks`** — the pool route exists server-side but `fetchPeaks` only hits `/audio-clips/:id/peaks`.
- **Float16 fidelity across all IEEE edge cases** — subnormals/Inf/NaN decode per the canonical algorithm, but downstream canvas math may render NaN/Inf anomalously. We do not guarantee visual output for adversarial float16 bit patterns.
- **Custom rendering targets** — canvas-2D only. No WebGL, SVG, or offscreen-canvas worker path.

---

## Open Questions

- **OQ-1 — Viewport virtualization**: Should `<AudioWaveform>` avoid mounting canvases outside the visible scroll window? Today all tiles for the full `width` mount simultaneously. Referenced by Behavior Table row 31.
- **OQ-2 — Cache size limit**: Audit §1E unit 9 flags the cache as unbounded → editor-session leak. Is a cap / LRU required? Referenced by row 25.
- **OQ-3 — Invalidate-during-inflight**: If `invalidatePeaks` is called while a fetch for that key is in flight, should the in-flight Promise be aborted or its result discarded? Current code leaves the in-flight fetch alone; it will populate the cache after `invalidatePeaks` returns, silently resurrecting "stale" data. Referenced by row 26.
- **OQ-4 — Fetch for deleted pool_segment**: If the backend has removed the entity referenced by `clipId`, the fetch returns 404 → client rejects. Is that the desired UX (blank waveform) or should the component surface an explicit "missing source" indicator? Referenced by row 24.
- **OQ-5 — Malformed float16 bytes**: If the backend returns an odd-length body or NaN/Inf bit patterns, `Uint16Array` silently truncates and the draw loop may compute NaN line lengths. No validation exists; should we detect and fall back to loading / error state? Referenced by row 28.
- **OQ-6 — `resolution = 0`**: Client happily constructs a key and URL with `resolution=0`. Backend behavior is unspecified; current code has no client-side guard. Referenced by row 32.
- **OQ-7 — Pool-segment variant**: `fetchPeaks` only addresses `/audio-clips/:id/peaks`. The `/pool/:seg_id/peaks` route is reached through a different code path (AudioIsolationsPanel). Should `fetchPeaks` be generalized, or is the parallel path intentional? Referenced by row 33.
- **OQ-8 — AbortController**: No cancellation primitive is passed to `fetch`. When the component unmounts or clip changes mid-fetch, the network request continues and the response bytes are decoded and cached even if no consumer wants them. Acceptable, or should we wire `AbortSignal`? Referenced by row 34.
- **OQ-9 — Sub-16 width and fetch**: `<AudioWaveform>` renders `null` when `width < 16`, but the `useEffect` only guards on `clipId` + `durationSeconds`, so a fetch is issued even when nothing will be drawn. Is that waste acceptable or should the effect also gate on `width`?

---

## Related Artifacts

- Audit: `agent/reports/audit-2-architectural-deep-dive.md` §1E unit 9, §1 row 14 of retroactive-spec candidates
- Backend: `scenecraft-engine/src/scenecraft/api_server.py` (lines ~495 audio-clips route, ~9385 pool-segment route), `scenecraft-engine/src/scenecraft/audio/peaks.py` (compute algorithm — out of scope)
- Related frontend specs (to be generated): `local.audio-mixer`, `local.timeline-rendering`
- Code under spec: `src/lib/waveform-cache.ts`, `src/components/editor/AudioWaveform.tsx`

---

**Namespace**: local
**Spec**: waveform-cache-and-rendering
**Version**: 1.0.0
**Created**: 2026-04-27
**Status**: Retroactive
