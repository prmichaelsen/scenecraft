# Task 52: OAuth Client + MCP Bridge for Remember

**Milestone**: [M4 - AI Assistant Chat](../../milestones/milestone-4-ai-assistant-chat.md)  
**Design Reference**: [OAuth + MCP Bridge](../../design/local.oauth-mcp-bridge.md)  
**Estimated Time**: 10-12 hours  
**Dependencies**: Task 15 (backend chat endpoint), Task 17 (tool calling)  
**Status**: Completed (core flow) — 2026-04-16

---

## Objective

Add a standards-compliant OAuth 2.0 + PKCE client to the scenecraft backend, register `scenecraft` as an OAuth client in agentbase.me, and wire an MCP bridge so Remember MCP's tools appear in Claude's tool list during chat. This is the foundation for future MCP services gated by agentbase.me OAuth.

---

## Context

Remember MCP (memory / search / relationships, 29+ tools) is hosted on Cloud Run and authenticated via JWTs signed by agentbase.me's token endpoint. Each user authorizes scenecraft individually through agentbase.me's consent page. Once authorized, scenecraft holds per-user access/refresh tokens and connects to `remember-mcp-server` over SSE with a Bearer token to discover and call tools.

The OAuth client was deliberately built as a generic module (`oauth_client.py` with a `SERVICES` registry) so additional OAuth-backed MCP servers behind agentbase.me slot in with minimal changes.

---

## Steps

### 1. Register OAuth client in agentbase.me

- New reusable scripts under `agentbase.me/scripts/`:
  - `register-oauth-client.ts` — idempotent, supports `--reuse-service-token-from <other-client>`
  - `get-oauth-client.ts` — read a registered client (optionally print a single field)
- Fix latent bug in `src/lib/oauth/seed-clients.ts` — it was regenerating `service_token` on every run, which would invalidate any issued JWT
- Register `scenecraft` in **prod**, reusing `remember-mcp-oauth-service`'s `service_token` so scenecraft-issued JWTs verify against the existing `remember-mcp-server` instance
- Redirect URIs: `http://localhost:8890/oauth/callback`, `https://scenecraft.online/oauth/callback`

### 2. OAuth client module (scenecraft-engine)

`src/scenecraft/oauth_client.py`:
- PKCE pair generation per RFC 7636 (SHA-256 challenge, base64url)
- In-memory pending-state map with 10-minute TTL; state token is `secrets.token_urlsafe(32)`
- SQLite token store at `~/.scenecraft/oauth-tokens.db`, schema keyed on `(user_id, service)`; fields: `access_token`, `refresh_token`, `expires_at`, `created_at`, `updated_at`
- `exchange_code_for_tokens` / `refresh_access_token` hit `agentbase.me/api/oauth/token` via `application/x-www-form-urlencoded`
- `get_valid_access_token(user_id, service)` — returns a live token, transparently refreshing when within 5 min of expiry; returns `None` on refresh failure or missing tokens
- `SERVICES` registry: `remember` entry with `mcp_url`, `scope`, `label`
- Env overrides: `SCENECRAFT_AGENTBASE_URL`, `SCENECRAFT_OAUTH_CLIENT_ID`, `SCENECRAFT_OAUTH_REDIRECT_URI`, `SCENECRAFT_REMEMBER_MCP_URL`

### 3. HTTP routes (scenecraft-engine api_server.py)

- `GET /api/oauth/<service>/authorize` — auth required; returns `{url, state}`
- `GET /oauth/callback` — public (browser arrives without a session; added to `_authenticate` bypass list); exchanges code, persists tokens, renders a minimal HTML page that `postMessage`s the opener window and self-closes
- `GET /api/oauth/<service>/status` — auth required; `{connected, expires_at, has_refresh_token, created_at, updated_at}` or `{connected: false}`
- `POST /api/oauth/<service>/disconnect` — auth required; deletes stored tokens

### 4. MCP bridge (scenecraft-engine)

`src/scenecraft/mcp_bridge.py`:
- `MCPBridge` manages live MCP client sessions per-chat-connection, using `mcp.client.sse.sse_client` + `mcp.ClientSession`
- `connect(service, user_id)` — best-effort: fetch access token → open SSE with Bearer header → `list_tools()` → normalize tool names for routing
- Remember tools already start with `remember_`; other services get a `<service>_` prefix to avoid collisions with built-in tools
- `all_tools()` / `has_tool()` / `call_tool()` used by the chat loop
- `close()` tears down all sessions via `AsyncExitStack`

### 5. Chat integration

`src/scenecraft/chat.py`:
- `handle_chat_connection` creates an `MCPBridge`, calls `bridge.connect("remember", user_id)` on start, and `bridge.close()` in the `finally` block
- `_stream_response` merges `bridge.all_tools()` with built-in `TOOLS`, routes tool calls with `bridge.has_tool(name)` → `bridge.call_tool(name, input)` before falling back to `_execute_tool`
- Best-effort semantics: if Remember isn't connected or the SSE session fails, the chat still works with `sql_query` and any other built-ins

### 6. Frontend

`src/lib/oauth-client.ts`:
- `fetchOAuthStatus` / `startOAuthFlow` / `disconnectOAuth`
- `openOAuthPopup(url)` — opens the consent window, listens for the `scenecraft-oauth-callback` `postMessage`, resolves or rejects (popup blocked / timeout / closed)

`src/components/editor/ChatPanel.tsx`:
- `RememberConnectButton` in the input footer — fetches status on mount, shows `Connect Remember` or `✓ Remember`, handles popup + disconnect with confirmation; error states surfaced inline

### 7. Dependencies

- `pyproject.toml` — added `mcp>=1.0.0` to the `ai` optional extra; users run `pip install -e 'scenecraft-engine[ai]'`

---

## Verification

- [x] `OAUTH_CLIENTS/scenecraft` present in agentbase.me prod Firestore with correct redirect URIs and `service_token` matching `remember-mcp-oauth-service`
- [x] `agentbase.me/scripts/get-oauth-client.ts` lists the new client
- [x] `seed-clients.ts` preserves existing `service_token` on re-run
- [x] `~/.scenecraft/oauth-tokens.db` schema created on first access; upsert behavior correct
- [x] `GET /api/oauth/remember/authorize` returns a valid consent URL
- [x] `GET /oauth/callback` handles both success (code+state) and failure (error+error_description) paths
- [x] `GET /api/oauth/remember/status` reflects presence/absence of tokens
- [x] `POST /api/oauth/remember/disconnect` clears the row
- [x] Chat with Remember connected: `bridge.all_tools()` non-empty, `remember_*` tool calls dispatched to the MCP session
- [x] Chat without Remember: still works, only built-in tools available
- [ ] Full end-to-end smoke with real user in a browser — pending local/remote deploy
- [ ] 401 on a stale access token transparently refreshes + reconnects mid-chat
- [ ] Token encryption at rest

---

## Files Created

- `scenecraft-engine/src/scenecraft/oauth_client.py`
- `scenecraft-engine/src/scenecraft/mcp_bridge.py`
- `scenecraft/src/lib/oauth-client.ts`
- `scenecraft/agent/design/local.oauth-mcp-bridge.md`
- `agentbase.me/scripts/register-oauth-client.ts`
- `agentbase.me/scripts/get-oauth-client.ts`

## Files Modified

- `scenecraft-engine/src/scenecraft/api_server.py` — routes + unauth path for `/oauth/callback`
- `scenecraft-engine/src/scenecraft/chat.py` — bridge lifecycle + merged tool dispatch
- `scenecraft-engine/pyproject.toml` — `mcp>=1.0.0` in `ai` extra
- `scenecraft/src/components/editor/ChatPanel.tsx` — `RememberConnectButton`
- `agentbase.me/src/lib/oauth/seed-clients.ts` — no longer regenerates `service_token`

---

## Follow-ups

- Reconnect-on-401 inside the chat loop (currently requires restarting the chat connection after token refresh)
- Token encryption at rest (OS keychain or derived key)
- Background refresh job so first messages don't pay a refresh cost
- Additional MCP services (Calendar, Gmail, GitHub) — should require only a new `SERVICES` entry + a UI button
- Multi-account per service (today we key on `(user_id, service)`)
- E2E browser test for the full popup → callback → tool-call path

---

**Status**: Completed (core flow) — 2026-04-16  
**Related Design Docs**: [local.oauth-mcp-bridge](../../design/local.oauth-mcp-bridge.md), [local.ai-assistant-chat](../../design/local.ai-assistant-chat.md)
