# Spec: JobManager + /ws/jobs Event Bus

> **Retroactive spec** — describes behavior of code already shipped in scenecraft (frontend) and scenecraft-engine (backend). Source of truth is the referenced files; this document captures the observable contract so future changes have a proofing surface.

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Active (retroactive)

---

## Purpose

Define the observable contract of the backend `JobManager` singleton and the default WebSocket handler at `ws://<host>:8891/` (a.k.a. `/ws/jobs`) together with the frontend `JobStateContext` consumer — the thin asynchronous event bus that turns long-running backend generation work (Imagen, Veo, etc.) into progress UI in the browser and survives transient disconnects.

## Source

- **Mode**: retroactive — no single source artifact; behavior derived from code
- **Primary sources**:
  - `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/ws_server.py` (JobManager class lines 28–110; default handler lines 116–176)
  - `/home/prmichaelsen/.acp/projects/scenecraft-engine/src/scenecraft/chat_generation.py` (representative `start_keyframe_generation` / `start_transition_generation` callers)
  - `/home/prmichaelsen/.acp/projects/scenecraft/src/contexts/JobStateContext.tsx` (frontend dedup + auto-expire)
  - `/home/prmichaelsen/.acp/projects/scenecraft/src/hooks/useScenecraftSocket.ts` (WS module singleton, reconnect, `reQueryActiveJobs`)
  - `/home/prmichaelsen/.acp/projects/scenecraft/src/lib/chat-client.ts` (sibling chat WS — out of scope here; referenced only for contrast)
- **Reference memory**: "Chat generation jobs survive disconnect — don't cancel Imagen/Veo on WS close; user already paid, let results land."

## Scope

**In scope**:
- `JobManager` public methods: `create_job`, `update_progress`, `complete_job`, `fail_job`, `get_job`, `register_connection`, `unregister_connection`, `set_loop`
- `Job` record shape (`id`, `type`, `status`, `completed`, `total`, `result`, `error`, `meta`)
- Outbound broadcast events: `job_started`, `job_progress`, `job_completed`, `job_failed`, `folder_import` (non-job fanout, same bus)
- Inbound client messages on the default handler: `ping` → `pong`, `get_job` → `job_status` (or `error`)
- Connection lifecycle for the default (non-chat, non-preview) path at `/` (legacy) and `/ws/jobs` (paths not in `/ws/chat/` or `/ws/preview-stream/` fall through to this handler)
- Disconnect-survival invariant: jobs are server-side state; WS close does not cancel work
- Frontend `JobStateContext` dedup-by-`entityKey`, auto-expire (30 s on complete / 10 s on fail), polling fallback via `{type:"get_job", jobId}` on reconnect
- Reconnect / re-query-active-jobs flow in `useScenecraftSocket`

**Out of scope**:
- Chat WS path `/ws/chat/{project}` (own spec: chat-tool-dispatch-and-elicitation)
- Preview stream path `/ws/preview-stream/{project}`
- Specific generation tool implementations (e.g. keyframe/transition Imagen & Veo calls)
- REST endpoints such as `/api/jobs/...` (no such endpoint exists today — status retrieval is WS-only)
- Persistence of jobs across server restarts (none today — explicitly flagged `undefined`)
- Auth / authorization of WS clients (no auth on `/ws/jobs` at time of writing)
- `FolderWatcher` logic (piggybacks on `_broadcast` but is scoped by `pool-segments` spec)

## Requirements

1. **R1 — Create job**. `JobManager.create_job(job_type, total=0, meta=None)` MUST return a string id of the form `job_<8-hex-chars>` (prefix `job_` + `uuid4().hex[:8]`), insert a `Job` into the registry with `status="running"`, `completed=0`, and broadcast `{type:"job_started", jobId, jobType, total, meta}` to every registered connection.
2. **R2 — Progress**. `update_progress(job_id, completed, detail="")` MUST update the stored `completed` count and broadcast `{type:"job_progress", jobId, completed, total, detail}`. If `job_id` is unknown, the call MUST be a no-op (no raise, no broadcast).
3. **R3 — Complete**. `complete_job(job_id, result=None)` MUST set `status="completed"` and `result=result`, and broadcast `{type:"job_completed", jobId, result}`. If `job_id` is unknown, no-op.
4. **R4 — Fail**. `fail_job(job_id, error)` MUST set `status="failed"` and `error=error`, and broadcast `{type:"job_failed", jobId, error}`. If `job_id` is unknown, no-op.
5. **R5 — Get**. `get_job(job_id)` MUST return the `Job` dataclass for a known id or `None`.
6. **R6 — Thread safety**. All mutations of the job map MUST be protected by a single process-wide lock; readers outside of `get_job`/updates observe either the pre- or post-update state (no torn reads of individual fields).
7. **R7 — Connection registry**. `register_connection(ws)` and `unregister_connection(ws)` MUST add/remove a WebSocket from the broadcast set. The set MUST be tolerant of entries that have already closed (broadcasts to closed sockets MUST NOT crash the manager).
8. **R8 — Broadcast is cross-thread**. Generation work runs in worker threads (`threading.Thread` in `chat_generation.py`); `_broadcast` MUST schedule the `ws.send` coroutine onto the asyncio event loop previously stored via `set_loop(...)`. If no loop has been set OR no connections are registered, `_broadcast` MUST silently no-op.
9. **R9 — Default handler: ping**. On receiving `{"type":"ping"}` on the default handler, the server MUST reply with `{"type":"pong"}` on the same socket.
10. **R10 — Default handler: get_job**. On receiving `{"type":"get_job","jobId":"<id>"}`, the server MUST reply with `{"type":"job_status", "jobId", "status", "completed", "total", "result", "error"}` if the job exists, else `{"type":"error","message":"Job <id> not found"}`.
11. **R11 — Invalid JSON**. On inbound non-JSON frames, the server MUST reply `{"type":"error","message":"Invalid JSON"}` and keep the connection open.
12. **R12 — Disconnect survival**. When a client WS closes, the backend MUST NOT cancel or pause any in-flight job. The worker thread continues; subsequent `update_progress` / `complete_job` / `fail_job` calls continue to mutate the registry and attempt to broadcast to the remaining connections.
13. **R13 — Path routing**. The WS server MUST route paths starting with `/ws/chat/` to the chat handler and paths starting with `/ws/preview-stream/` to the preview handler; all other paths (including `/`, `/ws/jobs`, unknown paths) fall through to the default job handler.
14. **R14 — Frontend dedup by entityKey**. `JobStateContext.startJob(entityKey, jobId)` MUST overwrite any prior entry keyed by the same `entityKey`, clearing any pending auto-expire timer for that key.
15. **R15 — Frontend auto-expire**. On `job_completed` the entry MUST be removed from the store 30 s later; on `job_failed`, 10 s later. A subsequent `startJob` for the same `entityKey` before expiry MUST cancel the pending timer.
16. **R16 — Frontend reconnect**. On WS close the client MUST attempt to reconnect with exponential backoff (start 2 s, cap 30 s). On successful reconnect, the client MUST re-send `{type:"get_job", jobId}` for every `jobId` that has active listeners.
17. **R17 — Frontend polling fallback**. `job_status` server replies MUST be translated by the client into synthetic `job_completed` / `job_failed` messages for status values `"completed"` / `"failed"`. Running-status replies are passed through to listeners as-is.
18. **R18 — Frontend "server restarted" detection**. If the server responds to `get_job` with an `error` message matching `/^Job (job_\w+) not found$/`, the client MUST synthesize a `job_failed` event for that `jobId` with `error="Job lost (server restarted)"`.
19. **R19 — Frontend auto-register unknown jobs**. When `job_started` arrives for a `jobId` that is not in the `jobIdToEntity` map, the client MUST derive `entityKey` from `meta.keyframeId ?? meta.transitionId ?? jobId` and register it as if `startJob` had been called.
20. **R20 — Ping keepalive**. The client MUST send `{"type":"ping"}` every 30 s while the socket is OPEN.

## Interfaces / Data Shapes

### Backend `Job` dataclass

```python
@dataclass
class Job:
    id: str                          # "job_<8-hex>"
    type: str                        # e.g. "chat_keyframe_candidates"
    status: str = "pending"          # "pending" | "running" | "completed" | "failed"
    completed: int = 0
    total: int = 0
    result: Any = None
    error: str | None = None
    meta: dict = field(default_factory=dict)
```

Note: `create_job` writes `status="running"` immediately; the `"pending"` value is a dataclass default that is not observable in the current code path.

### Outbound events (server → client)

| Event | Shape |
|---|---|
| `job_started`   | `{type, jobId, jobType, total, meta}` |
| `job_progress`  | `{type, jobId, completed, total, detail}` |
| `job_completed` | `{type, jobId, result}` |
| `job_failed`    | `{type, jobId, error}` |
| `job_status`    | `{type, jobId, status, completed, total, result, error}` (reply to `get_job`) |
| `error`         | `{type, message}` |
| `pong`          | `{type}` |
| `folder_import` | `{type, project, imported:{keyframes:[], transitions:[]}, summary}` (non-job fanout, same bus) |

### Inbound messages (client → server, default handler)

| Message | Shape | Effect |
|---|---|---|
| `ping`     | `{type:"ping"}` | server replies `pong` |
| `get_job`  | `{type:"get_job", jobId}` | server replies `job_status` or `error` |

All other shapes on the default handler are ignored (no error). (Implementation falls through the `if/elif` chain silently.)

### Frontend `JobEntry`

```ts
type JobEntry = {
  jobId: string
  entityKey: string
  status: 'in_progress' | 'completed' | 'failed'
  progress: number           // 0..1
  detail: string
  result: unknown
}
```

### Frontend public surface

- `startJob(entityKey, jobId, label?)` — reserve an entry; dedup prior entry for same key
- `getJob(entityKey): JobEntry | null`
- `getAllJobs(): JobEntry[]`
- `consumeResult(entityKey): unknown` — returns + clears `result` (one-shot)
- `useJobState(entityKey)` — subscribes + re-renders on any change

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | `create_job` called from a worker thread | returns `job_<8hex>` id, stores job with status="running", broadcasts `job_started` to all connections | `create-job-emits-job-started`, `create-job-returns-prefixed-id` |
| 2 | `update_progress` on known job | stored `completed` updated; `job_progress` broadcast | `update-progress-broadcasts` |
| 3 | `update_progress` on unknown job id | no-op (no raise, no broadcast) | `update-progress-unknown-job-noop` |
| 4 | `complete_job` on known job | status="completed", result stored, `job_completed` broadcast | `complete-job-broadcasts` |
| 5 | `fail_job` on known job | status="failed", error stored, `job_failed` broadcast | `fail-job-broadcasts` |
| 6 | `get_job` on known id | returns Job dataclass | `get-job-returns-record` |
| 7 | `get_job` on unknown id | returns `None` | `get-job-unknown-returns-none` |
| 8 | Client sends `ping` | server replies `pong` | `ping-pong-roundtrip` |
| 9 | Client sends `get_job` for running job | server replies `job_status` with status="running" | `get-job-status-running` |
| 10 | Client sends `get_job` for completed job | server replies `job_status` with status="completed" and result | `get-job-status-completed-replay` |
| 11 | Client sends `get_job` for unknown id | server replies `{type:"error", message:"Job <id> not found"}` | `get-job-unknown-returns-error` |
| 12 | Client sends non-JSON frame | server replies `{type:"error", message:"Invalid JSON"}`, keeps socket open | `invalid-json-error-reply` |
| 13 | Client WS closes mid-job | worker thread continues; job still completes on server; still in registry | `job-survives-client-disconnect` |
| 14 | Broadcast when no connections registered | `_broadcast` is a no-op, no exception | `broadcast-with-no-connections-noop` |
| 15 | Broadcast when event loop not set | `_broadcast` is a no-op, no exception | `broadcast-without-loop-noop` |
| 16 | Broadcast to connection that has already closed | other connections still receive; stale connection is not retained | `broadcast-tolerates-closed-socket` |
| 17 | Path `/ws/chat/my-project` | routed to chat handler (NOT default handler) | `chat-path-bypasses-job-handler` |
| 18 | Path `/ws/preview-stream/my-project` | routed to preview handler | `preview-path-bypasses-job-handler` |
| 19 | Path `/ws/jobs` or `/` or unknown path | routed to default job handler | `default-path-uses-job-handler` |
| 20 | Frontend `startJob("kf_001", "job_a")` then `startJob("kf_001", "job_b")` | second call overwrites first; timer for "kf_001" cleared | `start-job-replaces-prior-entry` |
| 21 | Frontend receives `job_completed` | entry flips to status="completed", progress=1, timer set for 30 s removal | `frontend-auto-expires-completed-30s` |
| 22 | Frontend receives `job_failed` | entry flips to status="failed", timer set for 10 s removal | `frontend-auto-expires-failed-10s` |
| 23 | Frontend receives event for unknown `jobId` that is NOT `job_started` | silently dropped | `frontend-ignores-unknown-job-events` |
| 24 | Frontend receives `job_started` for unknown `jobId` with `meta.keyframeId` | auto-registers entityKey = meta.keyframeId | `frontend-auto-registers-by-keyframe-id` |
| 25 | Frontend receives `job_started` for unknown `jobId` with `meta.transitionId` | auto-registers entityKey = meta.transitionId | `frontend-auto-registers-by-transition-id` |
| 26 | Frontend receives `job_started` for unknown `jobId` with no meta fields | auto-registers entityKey = jobId itself | `frontend-auto-registers-by-job-id-fallback` |
| 27 | WS disconnects, then reconnects | client re-sends `get_job` for every active listener jobId | `reconnect-requeries-active-jobs` |
| 28 | Reconnect reply `job_status` with status="completed" | translated into synthetic `job_completed` for listeners | `job-status-completed-synthesized` |
| 29 | Reconnect reply `job_status` with status="failed" | translated into synthetic `job_failed` with error=msg.error or "Unknown error" | `job-status-failed-synthesized` |
| 30 | Reconnect reply `error` matching `Job job_xxx not found` | synthesized `job_failed` with error="Job lost (server restarted)" | `server-restart-detected-via-error` |
| 31 | Ping keepalive | client sends `ping` every 30 s while socket OPEN | `frontend-sends-ping-every-30s` |
| 32 | Reconnect backoff | delay starts 2 s, doubles, caps 30 s | `reconnect-backoff-exponential-capped` |
| 33 | `consumeResult` called twice | first call returns the result, second returns `null` | `consume-result-is-one-shot` |
| 34 | Server restarts between `create_job` and `complete_job` | **undefined** — jobs are in-memory only; workers in the prior process are terminated with the process; survivors in a new process do not exist | → [OQ-1](#open-questions) |
| 35 | Two jobs created for the same logical entity (same entityKey) at backend | **undefined** — backend has no entityKey concept; frontend `startJob` dedups by entityKey but nothing prevents two backend jobs emitting events interleaved | → [OQ-2](#open-questions) |
| 36 | Client subscribes AFTER a `job_completed` has already been broadcast | **undefined** — no automatic replay; client must call `get_job` explicitly via `reQueryActiveJobs` which only fires for jobIds it already knows about | → [OQ-3](#open-questions) |
| 37 | Two threads call `update_progress(job_id, N)` concurrently with different N | **undefined** — the lock serializes the write so the registry is internally consistent, but the *order* of broadcast events is not guaranteed to match the order of `completed` values; the broadcast happens outside the lock | → [OQ-4](#open-questions) |
| 38 | `create_job` generates a UUID prefix that already exists (birthday collision, ~2^-32) | **undefined** — no collision check; second `create_job` would overwrite the first Job record silently | → [OQ-5](#open-questions) |
| 39 | Memory growth — jobs live forever in `_jobs` on the backend | **undefined** — no TTL / eviction; long-running server accumulates Job records indefinitely | → [OQ-6](#open-questions) |
| 40 | Multiple browser tabs open simultaneously | every connected tab receives every broadcast; each tab's `JobStateContext` dedups locally | `multi-client-fanout` |

## Behavior (step-by-step)

### Happy path — chat tool triggers keyframe generation

1. Chat tool handler calls `start_keyframe_generation(...)` in `chat_generation.py`.
2. Handler calls `job_manager.create_job("chat_keyframe_candidates", total=count, meta={keyframeId, project, source})`.
3. `JobManager` generates id `job_<hex>`, inserts into `_jobs` under lock, broadcasts `job_started`. Every registered `/ws/jobs` client receives the event via `asyncio.run_coroutine_threadsafe`.
4. Handler spawns a daemon `threading.Thread` that runs generation work; main thread returns `{job_id, keyframe_id, count, backend}` to the chat tool synchronously.
5. As each variant finishes, the worker calls `update_progress(job_id, n, detail)` → `job_progress` broadcast.
6. When all variants are done, worker calls `complete_job(job_id, result={...})` → `job_completed` broadcast. On exception, `fail_job(job_id, str(e))` → `job_failed`.
7. Frontend `JobStateContext` receives each event via `useScenecraftSocket.subscribeAll` and updates the `JobEntry` keyed by `entityKey` (e.g. `keyframeId`). After 30 s (complete) or 10 s (fail), the entry is removed from the store.

### Disconnect survival

- If the WS closes between steps 3 and 5, the backend has no knowledge the client cared. The worker thread keeps running.
- `_broadcast` iterates `list(self._connections)` (snapshot), and `asyncio.run_coroutine_threadsafe(ws.send(...))` on a closed `ws` may raise — the `except Exception` block discards the stale connection.
- When the client reconnects, `useScenecraftSocket.onopen` calls `reQueryActiveJobs()`, which sends `{type:"get_job", jobId}` for every jobId still in the local listener map. The server replies `job_status` with current snapshot, which the client translates into synthetic `job_completed` / `job_failed` for terminal states.

### Frontend dedup / auto-expire

- `startJob(entityKey, jobId)` is called by the triggering component (e.g. "generate more candidates for kf_001" button) BEFORE the WS `job_started` event arrives, so the entry is reserved immediately and prior timers cleared.
- Alternatively, if `job_started` arrives for an unknown `jobId`, the context auto-registers using `meta.keyframeId || meta.transitionId || jobId` (R19).
- Timers live in `useRef(new Map<entityKey, Timeout>)`. On unmount of the provider, all timers are cleared in the `useEffect` cleanup.

## Acceptance Criteria

- [ ] `create_job` returns an id matching `^job_[0-9a-f]{8}$`
- [ ] Every public method of `JobManager` holds `_lock` around `_jobs` access and never calls `_broadcast` while holding the lock (lock held only for the state mutation; broadcast happens after lock release — see current code)
- [ ] `_broadcast` never raises; closed sockets are discarded; missing loop or empty connection set returns silently
- [ ] `/ws/chat/*` and `/ws/preview-stream/*` paths do NOT register with the job broadcast set
- [ ] Frontend `JobStateContext` removes entries on the documented 30 s / 10 s schedule and exposes `consumeResult` as a one-shot read
- [ ] Frontend reconnect backoff respects the 2 s → 30 s cap specified in `useScenecraftSocket.ts`
- [ ] Frontend re-queries every active listener's `jobId` on reconnect and synthesizes `job_failed` from `error` replies that match the "Job <id> not found" pattern

## Tests

### Base Cases

The core behavior contract. Happy path, primary bad paths, positive + negative assertions.

#### Test: create-job-emits-job-started (covers R1, R8)

**Given**: `JobManager` with loop set and one mock `ServerConnection` registered.
**When**: a worker thread calls `create_job("chat_keyframe_candidates", total=3, meta={"keyframeId": "kf_001"})`.
**Then**:
- **id-shape**: returned id matches `^job_[0-9a-f]{8}$`
- **registry-has-job**: `get_job(id)` returns a `Job` with `type="chat_keyframe_candidates"`, `status="running"`, `total=3`, `completed=0`, `meta={"keyframeId":"kf_001"}`
- **broadcast-fired**: the registered connection received exactly one JSON frame with fields `{type:"job_started", jobId:<id>, jobType:"chat_keyframe_candidates", total:3, meta:{"keyframeId":"kf_001"}}`

#### Test: create-job-returns-prefixed-id (covers R1)

**Given**: fresh `JobManager`.
**When**: `create_job("t")` called 5 times.
**Then**:
- **all-prefixed**: each id starts with `job_`
- **all-unique**: all 5 ids are distinct

#### Test: update-progress-broadcasts (covers R2)

**Given**: `JobManager` with one registered connection and a job created with total=10.
**When**: `update_progress(job_id, 4, "v4")`.
**Then**:
- **state-updated**: `get_job(job_id).completed == 4`
- **broadcast-shape**: connection received `{type:"job_progress", jobId, completed:4, total:10, detail:"v4"}`

#### Test: update-progress-unknown-job-noop (covers R2)

**Given**: `JobManager` with one registered connection and no job created.
**When**: `update_progress("job_does_not_exist", 1, "")`.
**Then**:
- **no-raise**: call returns normally
- **no-broadcast**: connection received zero frames
- **no-registry-entry**: `get_job("job_does_not_exist")` returns `None`

#### Test: complete-job-broadcasts (covers R3)

**Given**: running job.
**When**: `complete_job(job_id, {"keyframeId":"kf_001","candidates":["..."]})`.
**Then**:
- **status-completed**: `get_job(job_id).status == "completed"`
- **result-stored**: `get_job(job_id).result == {"keyframeId":"kf_001","candidates":["..."]}`
- **broadcast-shape**: connection received `{type:"job_completed", jobId, result:{...}}`

#### Test: fail-job-broadcasts (covers R4)

**Given**: running job.
**When**: `fail_job(job_id, "rate limited")`.
**Then**:
- **status-failed**: `get_job(job_id).status == "failed"`
- **error-stored**: `get_job(job_id).error == "rate limited"`
- **broadcast-shape**: connection received `{type:"job_failed", jobId, error:"rate limited"}`

#### Test: get-job-returns-record (covers R5)

**Given**: created job with known fields.
**When**: `get_job(job_id)` called.
**Then**:
- **record-shape**: returned object exposes `id, type, status, completed, total, result, error, meta` attributes
- **values-match**: values equal what was passed to `create_job` plus `status="running"`

#### Test: get-job-unknown-returns-none (covers R5)

**Given**: fresh manager.
**When**: `get_job("nope")`.
**Then**:
- **none-returned**: result is Python `None`

#### Test: ping-pong-roundtrip (covers R9)

**Given**: default-handler WS client connected.
**When**: client sends `{"type":"ping"}`.
**Then**:
- **pong-received**: client receives exactly one frame `{"type":"pong"}`
- **no-side-effects**: server's registered-connections set size unchanged after the exchange

#### Test: get-job-status-running (covers R10, R17)

**Given**: running job + connected client.
**When**: client sends `{"type":"get_job","jobId":<id>}`.
**Then**:
- **reply-type**: frame has `type:"job_status"`
- **fields-present**: frame has `jobId, status:"running", completed, total, result:null, error:null`

#### Test: get-job-status-completed-replay (covers R10, R17)

**Given**: a job that was created, completed, and whose `job_completed` broadcast has already fired before the client's `get_job`.
**When**: client sends `{"type":"get_job","jobId":<id>}` (late subscriber case).
**Then**:
- **reply-status-completed**: frame has `status:"completed"` with the final `result`
- **frontend-synthesizes-completed**: frontend translation layer emits synthetic `job_completed` with the same `result` to listeners

#### Test: get-job-unknown-returns-error (covers R10, R18)

**Given**: connected client, no such job.
**When**: client sends `{"type":"get_job","jobId":"job_deadbeef"}`.
**Then**:
- **error-reply**: frame is `{"type":"error", "message":"Job job_deadbeef not found"}`
- **frontend-translates**: if frontend is in the "reconnect re-query" code path, it synthesizes `{type:"job_failed", jobId:"job_deadbeef", error:"Job lost (server restarted)"}`

#### Test: invalid-json-error-reply (covers R11)

**Given**: connected client.
**When**: client sends the raw bytes `"not-json"`.
**Then**:
- **error-reply**: frame is `{"type":"error","message":"Invalid JSON"}`
- **socket-open**: socket remains in OPEN state (server did not close)

#### Test: job-survives-client-disconnect (covers R12)

**Given**: client connected, job created, worker thread running.
**When**: client WS is closed abruptly mid-run; worker then calls `update_progress`, `complete_job`.
**Then**:
- **no-cancel-flag**: no cancellation signal exists in the codebase; the worker never observes a cancel
- **registry-reflects-completion**: after worker finishes, `get_job(id).status == "completed"` with the final `result`
- **stale-connection-discarded**: `_connections` no longer contains the closed socket after the first broadcast attempt on it

#### Test: default-path-uses-job-handler (covers R13)

**Given**: a WS server instance.
**When**: a client connects to path `/`, then another to `/ws/jobs`, then another to `/anything-else`.
**Then**:
- **all-registered**: all three end up in `job_manager._connections`
- **receive-broadcasts**: a subsequent `create_job` triggers `job_started` on all three

#### Test: chat-path-bypasses-job-handler (covers R13)

**Given**: a WS server instance + stub chat handler.
**When**: client connects to `/ws/chat/my-project`.
**Then**:
- **not-in-jobs-set**: the socket is NOT added to `job_manager._connections`
- **chat-handler-invoked**: the chat handler entry point is called with the decoded project name

#### Test: preview-path-bypasses-job-handler (covers R13)

**Given**: WS server + stub preview handler.
**When**: client connects to `/ws/preview-stream/my-project`.
**Then**:
- **not-in-jobs-set**: socket NOT added to job connections
- **preview-handler-invoked**: preview entry point is called

#### Test: start-job-replaces-prior-entry (covers R14, R15)

**Given**: frontend `JobStateProvider` mounted; `startJob("kf_001", "job_a")` called.
**When**: `startJob("kf_001", "job_b")` called before any event for `job_a`.
**Then**:
- **latest-wins**: `getJob("kf_001").jobId === "job_b"`
- **prior-timer-cleared**: any pending auto-expire timer for `kf_001` is cancelled (no eviction at the 30 s mark for `job_a`)
- **reverse-map-updated**: `jobIdToEntity` contains `job_b → kf_001` (no assertion about whether `job_a` was purged from reverse map — that's an implementation detail)

#### Test: frontend-auto-expires-completed-30s (covers R15)

**Given**: `JobStateProvider` mounted, `startJob("kf_001", "job_a")`.
**When**: fake-timers-advanced — WS delivers `{type:"job_completed", jobId:"job_a", result:{...}}`, then 30 s elapse.
**Then**:
- **completed-visible**: immediately after the event, `getJob("kf_001").status === "completed"` with `progress === 1`
- **result-exposed**: `consumeResult("kf_001")` returns the broadcast result; a second call returns `null`
- **expired-at-30s**: after 30 s advance, `getJob("kf_001") === null`

#### Test: frontend-auto-expires-failed-10s (covers R15)

**Given**: `JobStateProvider` mounted, `startJob("kf_001", "job_a")`.
**When**: WS delivers `{type:"job_failed", jobId:"job_a", error:"rate limited"}`, then 10 s elapse.
**Then**:
- **failed-visible**: `getJob("kf_001").status === "failed"` and `.detail === "rate limited"`
- **expired-at-10s**: after 10 s, `getJob("kf_001") === null`
- **not-expired-early**: before 10 s (e.g. at 9 s), the entry is still present

#### Test: frontend-ignores-unknown-job-events (covers R19 negative)

**Given**: `JobStateProvider` mounted, nothing registered.
**When**: WS delivers `{type:"job_progress", jobId:"job_stranger", completed:1, total:1, detail:""}`.
**Then**:
- **dropped**: `getAllJobs()` returns `[]`
- **no-auto-register**: only `job_started` triggers auto-registration, not progress/completed/failed

#### Test: frontend-auto-registers-by-keyframe-id (covers R19)

**Given**: `JobStateProvider` mounted, no `startJob` called.
**When**: WS delivers `{type:"job_started", jobId:"job_a", jobType:"chat_keyframe_candidates", total:3, meta:{keyframeId:"kf_001"}}`.
**Then**:
- **registered**: `getJob("kf_001")` returns an entry with `jobId:"job_a", status:"in_progress"`
- **jobid-map**: subsequent progress events for `job_a` route to the `kf_001` entry

#### Test: frontend-auto-registers-by-transition-id (covers R19)

**Given**: provider mounted.
**When**: WS delivers `{type:"job_started", jobId:"job_b", jobType:"chat_transition_candidates", total:4, meta:{transitionId:"tr_007"}}`.
**Then**:
- **registered**: `getJob("tr_007").jobId === "job_b"`

#### Test: frontend-auto-registers-by-job-id-fallback (covers R19)

**Given**: provider mounted.
**When**: WS delivers `{type:"job_started", jobId:"job_c", jobType:"misc", total:0, meta:{}}`.
**Then**:
- **fallback-entity-key**: `getJob("job_c").jobId === "job_c"` (entityKey falls back to jobId)

#### Test: reconnect-requeries-active-jobs (covers R16)

**Given**: `useScenecraftSocket` has two listeners registered — `subscribeJob("job_a", ...)` and `subscribeJob("job_b", ...)`. WS is disconnected (`ws.onclose` fired).
**When**: reconnect succeeds (`socket.onopen` fires).
**Then**:
- **get-job-for-a**: the server received `{"type":"get_job","jobId":"job_a"}` on the new socket
- **get-job-for-b**: server received `{"type":"get_job","jobId":"job_b"}`
- **no-requery-for-expired**: if a listener was unsubscribed before reconnect, no `get_job` is sent for it

#### Test: job-status-completed-synthesized (covers R17)

**Given**: active listener on `job_a`.
**When**: server replies `{type:"job_status", jobId:"job_a", status:"completed", completed:3, total:3, result:{...}, error:null}`.
**Then**:
- **synthesized**: listener receives `{type:"job_completed", jobId:"job_a", result:{...}}`
- **no-passthrough**: listener does NOT separately receive the raw `job_status` message

#### Test: job-status-failed-synthesized (covers R17)

**Given**: active listener on `job_a`.
**When**: server replies `{type:"job_status", jobId:"job_a", status:"failed", completed:0, total:0, result:null, error:"boom"}`.
**Then**:
- **synthesized**: listener receives `{type:"job_failed", jobId:"job_a", error:"boom"}`
- **default-error**: if `error` is null/empty, synthesized message has `error:"Unknown error"`

#### Test: server-restart-detected-via-error (covers R18)

**Given**: active listener on `job_a`; reconnect sent `get_job`.
**When**: server replies `{type:"error", message:"Job job_a not found"}`.
**Then**:
- **synthesized-failed**: listener receives `{type:"job_failed", jobId:"job_a", error:"Job lost (server restarted)"}`
- **other-errors-pass-through**: an `error` reply that does NOT match the `Job <id> not found` pattern is NOT synthesized into `job_failed`

#### Test: consume-result-is-one-shot (covers R15 / `consumeResult`)

**Given**: completed job with result `{"a":1}` in the store.
**When**: `consumeResult("kf_001")` called twice.
**Then**:
- **first-returns-result**: first call returns `{"a":1}`
- **second-returns-null**: second call returns `null`
- **entry-still-present**: the `JobEntry` itself is still in the store (not removed by consumeResult) until the 30 s auto-expire fires

#### Test: multi-client-fanout (covers R1, R7)

**Given**: three default-handler clients connected.
**When**: worker calls `create_job` then `update_progress` then `complete_job`.
**Then**:
- **all-three-get-started**: each client receives `job_started` once
- **all-three-get-progress**: each client receives `job_progress` once
- **all-three-get-completed**: each client receives `job_completed` once
- **order-per-client**: within each client's stream, ordering is `started → progress → completed`

### Edge Cases

Boundaries, concurrency, resource states, unusual inputs.

#### Test: broadcast-with-no-connections-noop (covers R8)

**Given**: manager has loop set but zero connections registered.
**When**: `complete_job(id, {...})`.
**Then**:
- **no-raise**: call returns normally
- **state-mutated**: job status is still updated to "completed" in the registry

#### Test: broadcast-without-loop-noop (covers R8)

**Given**: manager with connections registered but `set_loop` never called.
**When**: `create_job("t")`.
**Then**:
- **no-raise**: call returns normally
- **id-returned**: id is returned and job is in registry
- **no-broadcast**: no frames are sent to the connections (documented cost of misconfiguration)

#### Test: broadcast-tolerates-closed-socket (covers R7)

**Given**: two connections A (open) and B (already closed).
**When**: `complete_job` fires `_broadcast`.
**Then**:
- **a-receives**: A receives the frame
- **b-discarded**: B is removed from `_connections` after the broadcast attempt (next broadcast iterates only A)

#### Test: frontend-sends-ping-every-30s (covers R20)

**Given**: fresh WS connection, fake timers.
**When**: 90 s of wall clock advance.
**Then**:
- **three-pings**: server received three `{"type":"ping"}` frames
- **ping-only-when-open**: if socket transitions to CLOSED, pings stop firing

#### Test: reconnect-backoff-exponential-capped (covers R16)

**Given**: WS that rejects connection 10 times in a row, fake timers.
**When**: timers advanced to allow each retry.
**Then**:
- **delays-doubling**: observed gaps are 2 s, 4 s, 8 s, 16 s, 30 s, 30 s, 30 s, 30 s, 30 s, 30 s (cap at 30 s)
- **reset-on-success**: after a successful connect, the delay counter resets to 2 s

#### Test: concurrent-update-progress-final-state (covers R6)

**Given**: created job; two threads call `update_progress(id, N)` concurrently with N=5 and N=7 (in any order).
**When**: both calls return.
**Then**:
- **no-torn-state**: `get_job(id).completed` is exactly one of {5, 7} (never a partial/torn value)
- **no-raise**: neither call raises
- **two-broadcasts**: two `job_progress` frames are emitted, but their ORDER is not guaranteed — see OQ-4 for the open question on progress monotonicity

#### Test: create-job-with-zero-total (covers R1)

**Given**: fresh manager.
**When**: `create_job("t", total=0)`.
**Then**:
- **id-returned**: valid id returned
- **broadcast-total-0**: broadcast carries `total:0`
- **frontend-progress-calc**: frontend `progress` on later `job_progress` events divides by 0 guarded — current code `msg.total > 0 ? msg.completed / msg.total : 0`, so progress stays 0

#### Test: create-job-with-empty-meta (covers R1)

**Given**: fresh manager.
**When**: `create_job("t", total=1)` (no meta arg).
**Then**:
- **meta-is-empty-dict**: `get_job(id).meta == {}`
- **broadcast-meta**: frame carries `meta:{}` (not `null`)

#### Test: frontend-multi-event-order (covers R15)

**Given**: `startJob("kf_001", "job_a")`, then WS delivers progress, progress, completed in quick succession.
**When**: all three events processed synchronously.
**Then**:
- **terminal-state-wins**: final `getJob("kf_001").status === "completed"`
- **one-timer**: exactly one 30 s auto-expire timer is scheduled (later events don't pile up additional timers — the progress events don't reset it because they don't set a timer at all)

#### Test: frontend-restart-during-expire-window (covers R15, R16)

**Given**: `job_completed` received, auto-expire timer armed for 30 s.
**When**: 5 s into the wait, a fresh `startJob(sameEntityKey, newJobId)` is called.
**Then**:
- **prior-timer-cleared**: the 30 s timer is cancelled; the completed entry is replaced with a new in-progress entry
- **no-ghost-eviction**: 30 s from the original `job_completed` event, the new entry is NOT evicted

#### Test: synchronous-single-threaded-assumption (negative, covers R6)

**Given**: the current implementation uses a single `threading.Lock` for the job map.
**When**: static / runtime inspection.
**Then**:
- **no-asyncio-lock**: `JobManager` does NOT use `asyncio.Lock` (it's callable from sync worker threads)
- **broadcast-outside-lock**: `_broadcast` is invoked AFTER the `with self._lock:` block in `update_progress` / `complete_job` / `fail_job` — this is the source of OQ-4 (broadcast ordering is not serialized with state ordering)

#### Test: folder-import-event-passes-through (covers R8 — same bus)

**Given**: `FolderWatcher` imports new files.
**When**: `job_manager._broadcast({type:"folder_import", ...})` fires.
**Then**:
- **clients-receive**: all registered default-handler clients receive the frame
- **frontend-ignores-for-job-state**: `JobStateContext` ignores it (no `jobId` field); other consumers handle it

#### Test: plugin-namespaced-events-coexist (covers R8)

**Given**: plugin emits `{type:"light_show__cue_fired", ...}` via `plugin_api.broadcast_event`, which ultimately routes through the same broadcast set.
**When**: event is sent.
**Then**:
- **job-context-ignores**: `JobStateContext` ignores (no `jobId`)
- **plugin-subscribers-receive**: `subscribePluginEvent('light_show', 'cue_fired', cb)` listener fires

## Non-Goals

- **Job persistence across server restart**. Jobs are explicitly in-memory; see OQ-1 and the "Job lost (server restarted)" synthesized failure on the frontend.
- **Authentication / authorization of `/ws/jobs`**. The default handler is open; any client that can reach the port can subscribe.
- **Backpressure / rate limiting of broadcasts**. `_broadcast` fans out to every connection on every event; for very chatty jobs at large fanout this is O(connections × events).
- **Per-project scoping of job events**. Unlike `/ws/chat/{project}`, `/ws/jobs` is global — every client sees every project's job events. Scoping, if needed, happens in the consumer via `meta.project` or `meta.keyframeId`.
- **Ordered delivery guarantees for concurrent `update_progress`**. See OQ-4.
- **Job cancellation API**. There is no `cancel_job` method; jobs run to completion. This is intentional ("generation jobs survive disconnect — don't cancel").
- **Job TTL / GC on the backend**. See OQ-6.

## Open Questions

**OQ-1 — Server restart during in-flight job**.
The backend stores jobs only in a process-local `dict[str, Job]`. If the server restarts, the prior worker threads are terminated with the process and the registry is empty. Clients that had a `job_<id>` in flight will, on reconnect, send `get_job` and receive `{"type":"error","message":"Job <id> not found"}`; the frontend translates this to a synthesized `job_failed` with error `"Job lost (server restarted)"` (R18). What is undefined:
- Whether partial work (e.g. half the keyframe variants rendered) that landed in the pool/DB before shutdown is reconciled.
- Whether clients should surface a recovery UI ("some of your keyframes may still be in the pool — refresh to see").
- Whether a persistence layer for Jobs (disk / sqlite) should exist.

**OQ-2 — entityKey collision**.
`JobStateContext` keys its store by `entityKey` (usually `keyframeId` / `transitionId`). If a second chat call creates a second backend job for the same entity while the first is still in flight:
- On the backend, both jobs exist with distinct `job_<id>` values and both workers run concurrently. Both broadcast events; the backend has no notion of entityKey.
- On the frontend, `startJob(entityKey, jobId_2)` will overwrite the prior entry, clear its timer, and subsequent events for `jobId_1` will be dropped (because `jobIdToEntity` was overwritten too).

Undefined: is double-invoking the chat tool for the same entity a user error we want to warn about, a legitimate "add more variants" path, or something we want to deduplicate at the backend (reject a second `create_job` for the same entity)?

**OQ-3 — Subscribe-after-complete replay**.
If a client connects AFTER a `job_completed` broadcast has already fired, there is no automatic replay. The client will see only events from that point forward. The frontend's `reQueryActiveJobs` only re-queries `jobId`s it already has a listener for — a never-seen-before `jobId` is invisible. Should:
- `/ws/jobs` support a `{type:"subscribe", since:<ts>}` replay window?
- The server keep a small ring buffer of recent completed jobs for late subscribers?

Currently: no replay; late subscribers are expected to drive UI state from HTTP fetches (`/api/keyframes/{id}`, pool segments, etc.) rather than from event log.

**OQ-4 — Concurrent `update_progress` broadcast order**.
`update_progress` acquires the lock for the state mutation, but `_broadcast` runs outside the lock. If thread A and thread B both call `update_progress(id, A_val)` and `update_progress(id, B_val)` in quick succession:
- The final stored `completed` value is deterministic (last writer wins, serialized).
- The BROADCAST ORDER is NOT guaranteed to match the write order — thread B could finish the state update before thread A but release the lock and enter `_broadcast` after A did.
- Consequence: the frontend can observe `job_progress` events with a `completed` field that is NOT monotonically increasing.

Undefined: is monotonic progress a contract we want? If yes, the fix is to move `_broadcast` inside the lock (or snapshot the state + use a send queue). Current behavior is "best-effort".

**OQ-5 — UUID collision on `create_job`**.
`create_job` uses `uuid4().hex[:8]` (32 bits) with no collision check. Birthday-bound collision probability is ~0 in practice but nonzero (~2^-16 for 2^16 concurrent jobs). On collision, `_jobs[job_id] = job` would silently overwrite the prior record. Not exercised today; flag if expected job volume grows or lifetime extends.

**OQ-6 — `_jobs` unbounded growth**.
No TTL, no LRU, no eviction. Long-running server processes accumulate `Job` dataclasses indefinitely (~small per-job but not zero). Should there be a sweep to drop jobs in terminal state older than N minutes? Today no.

**OQ-7 — Auth on `/ws/jobs`**.
There is no auth gate in `_handle_connection`'s default branch. Any network-reachable client can subscribe to every project's job events (and can call `get_job` for any known id). In a single-user local deployment this is fine; once scenecraft runs multi-tenant or on a public host, this is an open gap.

---

## Key Design Decisions

- **In-process, in-memory registry**. Jobs live in a process-local dict. Simpler than a DB-backed queue; trade-off is "no survival across restart" — explicitly called out as OQ-1.
- **Broadcast outside the lock**. Keeps the hot path short (state mutation is O(1) map write) at the cost of the progress-ordering guarantee (OQ-4).
- **Worker threads, not asyncio**. Generation work uses `ThreadPoolExecutor` + blocking HTTP calls to Google/Replicate; the cross-thread broadcast uses `asyncio.run_coroutine_threadsafe` to hand messages back to the loop. This avoids rewriting provider SDKs as async.
- **Single global bus**. One connection set, one fanout. Not scoped by project / user. Frontend consumers filter by `meta` fields. Simpler today; becomes a problem at multi-tenant scale.
- **Frontend dedup by entityKey, not jobId**. Because UI state is naturally "progress of kf_001", not "progress of job_a". The jobId is an implementation detail the UI never wants to render.
- **Auto-expire (30 s / 10 s) is UI, not server policy**. Backend keeps Jobs forever; only the frontend forgets them. This lets a second tab opened later still inspect a completed job (if it arrives during the 30 s window on the other tab and the server still has the record).
- **Reconnect does NOT cancel**. Matches the "generation jobs survive disconnect" invariant — client closing a tab does not bill the user for nothing.

---

## Related Artifacts

- **Audit**: `agent/reports/audit-2-architectural-deep-dive.md` §1C units 6–7 (JobManager + JobStateContext)
- **Sibling specs (planned)**:
  - `local.chat-tool-dispatch-and-elicitation` — `/ws/chat/{project}` handler
  - `local.pool-segments-and-variant-kind` — where generated artifacts land
  - `local.chat-panel-and-job-state` — UI consumer details
- **Memory note**: "Chat generation jobs survive disconnect" (`feedback_generation_jobs_survive_disconnect.md`)
- **Code**:
  - `scenecraft-engine/src/scenecraft/ws_server.py`
  - `scenecraft-engine/src/scenecraft/chat_generation.py`
  - `scenecraft/src/contexts/JobStateContext.tsx`
  - `scenecraft/src/hooks/useScenecraftSocket.ts`
  - `scenecraft/src/lib/chat-client.ts`

---

**Namespace**: local
**Spec**: job-manager-and-ws-events
**Version**: 1.0.0
**Created**: 2026-04-27
**Status**: Active (retroactive)
