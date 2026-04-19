# OAuth + MCP Bridge for External Assistant Tools

**Concept**: OAuth 2.0 + PKCE client that lets scenecraft connect to third-party MCP servers on behalf of the user, exposing their tools to the in-editor Claude chat  
**Created**: 2026-04-16  
**Status**: Initial implementation landed (Remember MCP)

---

## Overview

The AI assistant chat (M4) gets its extensibility from external MCP servers. The first target is Remember MCP (memory/search/relationships) hosted on Cloud Run and fronted by agentbase.me as the OAuth authorization server. This design covers the generic OAuth + MCP-bridge infrastructure that will also power future integrations (Google Calendar, Gmail, etc., once those have MCP endpoints behind agentbase.me).

---

## Problem Statement

- The chat is more useful when Claude can reach the user's memory, calendar, and other data sources without the user copy-pasting
- Those data sources sit behind agentbase.me's OAuth server; each user authorizes scenecraft individually
- Scenecraft needs a standards-compliant OAuth client (authorization code + PKCE), secure per-user token storage, automatic refresh, and a clean way to multiplex multiple MCP servers into a single Claude tool list

---

## Solution

### High-level flow

```
┌──────────────────────┐              ┌──────────────────┐
│ ChatPanel            │              │ agentbase.me     │
│ "Connect Remember"   │─── popup ───▶│ /oauth/authorize │
└──────────┬───────────┘              │                  │
           │                          │ (user logs in +  │
           │                          │  approves)       │
           │                          └───────┬──────────┘
           │                                  │
           │   ┌───────────────────────┐      │ redirect
           │   │ scenecraft backend    │◀─────┘  (code + state)
           │   │ /oauth/callback       │
           │   └──────────┬────────────┘
           │              │ POST /api/oauth/token
           │              │   (grant=authorization_code + PKCE)
           │              ▼
           │   ┌───────────────────────┐
           │   │ ~/.scenecraft/        │
           │   │ oauth-tokens.db       │
           │   │ (access + refresh)    │
           │   └──────────┬────────────┘
           │              │
           │              │ SSE w/ Bearer <access_token>
           │              ▼
           │   ┌───────────────────────┐
           │   │ remember-mcp-server   │
           │   │ (Cloud Run)           │
           │   └───────────────────────┘
           │
           └─▶ postMessage → refresh UI state (✓ Remember)
```

### Component breakdown

**Backend: `src/scenecraft/oauth_client.py`**
- PKCE helpers (`generate_pkce_pair` — SHA-256 challenge, base64url)
- In-memory pending-state map with 10-minute TTL (CSRF + carries PKCE verifier through the redirect)
- Token storage in SQLite at `~/.scenecraft/oauth-tokens.db`, schema keyed by `(user_id, service)`
- `exchange_code_for_tokens` / `refresh_access_token` — POSTs `application/x-www-form-urlencoded` to `agentbase.me/api/oauth/token`
- `get_valid_access_token(user_id, service)` — loads, refreshes if expiring within 5 min, returns current access token (or `None` if unavailable)
- `SERVICES` registry: per-service resource-server URL + scopes

**Backend: new routes in `api_server.py`**
- `GET /api/oauth/<service>/authorize` — auth-required; generates PKCE + state, returns `{ url, state }`
- `GET /oauth/callback` — public (browser arrives without a session); exchanges code, stores tokens, renders an HTML page that `postMessage`s the opener and self-closes
- `GET /api/oauth/<service>/status` — auth-required; `{connected, expires_at, has_refresh_token, ...}`
- `POST /api/oauth/<service>/disconnect` — auth-required; delete stored tokens

**Backend: `src/scenecraft/mcp_bridge.py`**
- `MCPBridge` manages live MCP client sessions for a single chat connection
- On connect: fetch access token, open SSE with Bearer header, call `list_tools()`, normalize names for routing
- `all_tools()` / `has_tool()` / `call_tool()` — used by the Claude tool loop
- `close()` tears down sessions on chat disconnect (via `AsyncExitStack`)

**Backend: `chat.py` integration**
- `handle_chat_connection` creates an `MCPBridge`, best-effort connects each OAuth-backed service on start
- `_stream_response` merges `bridge.all_tools()` with built-in `TOOLS`, routes tool calls via `bridge.call_tool()` when matched

**Frontend: `src/lib/oauth-client.ts`**
- `fetchOAuthStatus`, `startOAuthFlow`, `disconnectOAuth`, `openOAuthPopup`
- `openOAuthPopup` opens a window, listens for the `scenecraft-oauth-callback` `postMessage` from the callback HTML, resolves with the result

**Frontend: `ChatPanel` integration**
- `RememberConnectButton` in the footer: fetches status on mount, shows `Connect Remember` or `✓ Remember`, handles popup + disconnect

### Per-subdomain callback pattern

A single registered redirect URI (`https://scenecraft.online/oauth/callback` prod, `http://localhost:8890/oauth/callback` dev) handles all subdomains. The callback HTML posts back to the opener regardless of origin, letting any subdomain initiate a flow.

### Service token sharing with Remember

`remember-mcp-oauth-service` (the Claude CLI client) and `scenecraft` are both registered in agentbase.me's `OAUTH_CLIENTS` Firestore collection and **share the same `service_token`**. This is required so JWTs issued via either client verify against the single `PLATFORM_SERVICE_TOKEN` that remember-mcp-server is configured with.

Longer-term this is a constraint — if a new service wants its own signing key, remember-mcp-server would need to accept multiple keys (a `PlatformJWTProvider` change + redeploy).

### Tool name routing

Tools exposed by Remember all start with `remember_` already, so routing is trivial: any `remember_*` call goes to the remember MCP session. For future services whose tools don't carry a service-specific prefix, the bridge prefixes them with `<service>_` when building the Claude tool list, and strips the prefix before forwarding to the upstream MCP server.

---

## Security

- **PKCE required** (public client — no secret). Verifier stored only in-memory server-side, never sent to the browser.
- **State token** is a random `token_urlsafe(32)`, matched on callback, single-use, 10-minute TTL.
- **Tokens stored at rest** in SQLite under `~/.scenecraft/oauth-tokens.db`. Current permission model relies on filesystem mode; no column-level encryption yet (candidate for follow-up work).
- **Refresh rotation** supported — `agentbase.me/api/oauth/token` revokes the old refresh token on each use; we persist the new one.
- **Scope** — the `SERVICES` entry declares the scope string passed to `/oauth/authorize`; currently empty (falls back to default).

---

## Trade-offs

| Choice | Rationale | Cost |
|---|---|---|
| Popup-based consent, `postMessage` handoff | No server-side session tracking needed; same origin for callback regardless of subdomain | Requires popups enabled; window.opener must be present |
| Single shared `service_token` across clients | Works today without changes to remember-mcp-server | Rotating one rotates both; multi-key support on the RS would be cleaner |
| Per-chat MCP sessions (not global) | Each chat has its own auth context; easy to reason about lifecycle | Every chat opens a fresh SSE connection on startup |
| Best-effort MCP connect | Chat keeps working if Remember is unavailable | Silent failure — users must check status to know why tools are missing |
| In-memory pending-state map | Simple, fast | State is lost across server restarts mid-flow (acceptable — user just retries) |

---

## Future Considerations

- **Multi-account per service** — today we store one `(user_id, service)` row; if a user wants two Remember accounts we'd need a third dimension (account label)
- **Token encryption at rest** — wrap `oauth_tokens` with OS keychain or a derived key from the scenecraft JWT secret
- **Other MCP servers** — Google Calendar, Gmail, GitHub, etc. via the same pattern; they register in agentbase.me and appear as additional services in the OAuth `SERVICES` map
- **Offline refresh** — a background task that refreshes tokens before they expire, regardless of whether a chat is open, so the first message of the day doesn't pay a refresh cost
- **Tool permission gating** — elicit user confirmation before destructive Remember operations (aligns with M4 elicitation UI task-18)
- **Reconnect on 401** — if a cached access token is rejected mid-chat, refresh and reconnect transparently rather than losing the session
- **MCP dynamic reconfiguration** — let the user connect Remember mid-chat and have the tool list update without restarting the chat connection

---

## Testing Strategy

- Unit: PKCE helper round-trip (verifier → challenge → verify)
- Unit: token DB upsert / refresh rotation / expiry detection
- Integration: full OAuth flow against a mock authorization server (seeded fake `OAUTH_CLIENTS`)
- Integration: chat connection with tokens present → bridge discovers `remember_*` tools → Claude can call them
- Integration: chat connection without tokens → bridge silent; chat still serves `sql_query`
- E2E: click "Connect Remember" in the ChatPanel → popup → callback → UI shows `✓ Remember` → first chat message successfully uses a `remember_*` tool

---

## Related Documents

- [`local.ai-assistant-chat.md`](local.ai-assistant-chat.md) — original M4 design
- [`agent/milestones/milestone-4-ai-assistant-chat.md`](../milestones/milestone-4-ai-assistant-chat.md)
- agentbase.me `src/routes/api/oauth/authorize.tsx` + `token.tsx` — authorization server side
- remember-mcp-server `src/auth/platform-jwt-provider.ts` — resource server side

---

**Status**: Initial implementation landed. Remember MCP integration wired end-to-end; chat-side reconnect-on-401, encryption at rest, and additional MCP services are follow-ups.
