# scenecraft.online Platform Architecture

**Concept**: Multi-tenant management, auth, box provisioning, and paid-API brokering layer that sits cloud-side of the scenecraft trust boundary. Users' boxes run scenecraft locally; scenecraft.online holds the secrets, the ledger, and the admin surface.
**Created**: 2026-04-23
**Status**: Design Specification

---

## Overview

scenecraft.online is a separate cloud service from scenecraft itself. Scenecraft runs on the user's box — their own machine or a provisioned cloud VM — and hosts the editor, project DBs, plugin runtime, and WebSocket server. scenecraft.online sits in front of many such boxes and provides:

- **Multi-tenant admin portal** — where admins sign up, pay, manage orgs, and provision boxes and instance users.
- **Box provisioning** — spinning up scenecraft instances for admin-purchased capacity.
- **Subdomain registration** — `<tenant>.scenecraft.online` DNS + routing to each box.
- **Auth provider for admins** (NOT for instance users — those live on the box).
- **API-token / key management** — admins can BYO third-party API keys (Musicful, Veo, Replicate, ElevenLabs, OpenAI) per service, OR opt for scenecraft-brokered billing.
- **Broker** — when a service is brokered, scenecraft.online holds the third-party key, proxies the call, records the authoritative ledger, and bills user's org with a markup.
- **Billing + spend analytics** — per-user, per-org, per-service.

The boundary between scenecraft and scenecraft.online is a **trust boundary**. scenecraft.online cannot trust anything in the user's box DB (admin or instance user could SSH in and manipulate). The box cannot hold third-party keys in brokered mode. Design rests on keeping each side authoritative only for what it controls end-to-end.

This document covers the architecture; individual implementations (the TanStack Start SaaS, individual service brokers, billing flows) are separate work.

---

## Problem Statement

Scenecraft as a self-hosted, single-user tool works: the user owns the box, owns the API keys, owns the trust boundary. `MUSICFUL_API_KEY` in their env var is fine.

The moment scenecraft becomes SaaS — third-party-hosted boxes, multi-user teams, shared API keys, metered billing — every assumption breaks:

- **Keys can't live on user-accessible boxes.** Any admin or power user with SSH can read the env, exfiltrate keys, or run unmetered calls on the company's credit.
- **Billing can't be SQLite-authoritative.** A user running `UPDATE spend_ledger SET amount=0` invalidates the ledger. Local DB is a cache at best.
- **Provisioning is inherently multi-tenant.** Each admin gets one or more boxes; boxes have orgs; orgs have instance users; instance users exist ONLY in their box's namespace.
- **Two distinct user populations** must coexist: scenecraft.online users (admins who hold accounts with us and pay) vs. scenecraft instance users (people provisioned into a box, who may or may not be our customers).
- **Per-service mode choice** — for any given paid third-party service, an admin might BYO their own key (direct-call from box, no scenecraft involvement) OR opt for brokered billing (scenecraft.online forwards the call and charges a markup). Both modes must coexist within the same box.

Without a deliberate platform architecture, scenecraft either stays self-hosted-only or ships a SaaS that leaks keys and can't enforce billing.

---

## Solution

### High-level topology

```
                        ┌────────────────────────────────┐
                        │   scenecraft.online (SaaS)     │
                        │   TanStack Start server fns    │
                        │                                │
                        │   - Admin portal               │
                        │   - Auth for admins            │
                        │   - Box provisioning           │
                        │   - Subdomain routing          │
                        │   - Service-key vault          │
                        │   - Broker (per-service proxy) │
                        │   - Authoritative spend_ledger │
                        │   - Billing + markup           │
                        └──────────────┬─────────────────┘
                                       │   HTTPS + JWT
                                       │   (broker calls,
                                       │    config sync)
                     ┌─────────────────┼─────────────────┐
                     │                 │                 │
              ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
              │  Box  A     │   │  Box  B     │   │  Box  C     │
              │ (org: acme) │   │ (org: acme) │   │ (org: blue) │
              │             │   │             │   │             │
              │ server.db   │   │ server.db   │   │ server.db   │
              │  - users    │   │  - users    │   │  - users    │
              │  - orgs     │   │  - orgs     │   │  - orgs     │
              │  - sessions │   │  - sessions │   │  - sessions │
              │  - ledger   │   │  - ledger   │   │  - ledger   │
              │    (cache)  │   │    (cache)  │   │    (cache)  │
              │             │   │             │   │             │
              │ scenecraft  │   │ scenecraft  │   │ scenecraft  │
              │ editor +    │   │ editor +    │   │ editor +    │
              │ plugins     │   │ plugins     │   │ plugins     │
              └─────────────┘   └─────────────┘   └─────────────┘
```

Admins log into scenecraft.online. Each box is provisioned by an admin and is reachable at `<tenant>.scenecraft.online`. Instance users are provisioned into boxes (by admins, via REST from scenecraft.online OR via CLI on the box) and log into their box, NOT into scenecraft.online. Paid API calls either route direct (BYO) or through scenecraft.online (broker).

### Two user populations

| Population | Identity stored | Authenticates to | Purpose |
|---|---|---|---|
| **scenecraft.online users (admins)** | scenecraft.online DB | scenecraft.online | Provision orgs/boxes/users; manage billing; enter BYO keys or opt into broker |
| **Instance users** | Box's `server.db.users` | The box only | Use the editor; authenticated on every request |

An instance user is NOT automatically a scenecraft.online user and vice versa. Admins may or may not be instance users of their own boxes. Most instance users are NOT scenecraft.online customers — their admin pays.

### Provisioning instance users

Admins provision instance users via either path:

1. **Portal (REST from scenecraft.online → box)**: admin uses scenecraft.online UI to create user `alice` on box `acme-main`. Portal POSTs to box's `/admin/users` endpoint with scenecraft.online credentials. Box creates `users` row with a default password (admin-generated) and an API key (expiry ≤ 1 year). Box returns the credentials; portal relays to admin; admin forwards to Alice.
2. **CLI on the box**: admin SSHes into box, runs `scenecraft user create alice --expires 2027-04-23`. Same DB effect.

Either path produces:
- `users (username='alice', password_hash=<default>, must_change_password=1, ...)`
- `api_keys (id=<uuid>, username='alice', key_hash=<...>, expires_at=<≤1yr>, issued_by=<admin>, issued_at=<now>)`
  - New core table; currently the codebase references API keys implicitly through SSH / JWT but M16 adds the explicit table for rotation forensics (R54f in the music-gen spec).

Alice receives the default password + API key out-of-band (email, Slack, whatever). On first login she's forced to change her password (R54b). Her API key is separately required on every request as `X-Scenecraft-API-Key: <key>` (R54a).

### Double-gate auth on the box

Every authenticated request hits two gates:

1. **Session** — password-login-derived JWT or cookie.
2. **API key** — `X-Scenecraft-API-Key: <key>` header, must be unexpired and belong to the session's username.

Both required. Session alone or key alone = 401. Rationale: defense in depth.

- Session compromise without the key ≠ access.
- Key leak without the password ≠ access.
- Rotation is admin-only (users can't self-rotate); admins issue new keys via portal or CLI.

### Brokered vs. BYO service mode

Per service, per org, admin chooses a mode:

- **BYO**: admin enters their own `MUSICFUL_API_KEY` (etc.) into scenecraft.online. The portal pushes it to all relevant boxes via the config-sync endpoint; box writes to its local env / secrets store; plugin reads locally; calls go direct to the provider.
- **Brokered**: admin has no third-party key configured; they opt into scenecraft-brokered billing. scenecraft.online holds the key in a key vault; box does NOT hold the key. Box calls scenecraft.online's broker endpoint, which proxies to the provider and bills the admin's org at provider-cost plus markup %.

The plugin code is agnostic. A host-provided shim (`plugin_api.call_service()`) inspects per-service config and routes appropriately.

```python
# Mode decision at call-time
response = plugin_api.call_service(
    service='musicful',
    method='POST',
    path='/v1/music/generate',
    body=payload,
    operation='generate-music.run',
    job_ref=generation_id,
)
# Routes to:
#   - direct Musicful call if MUSICFUL_API_KEY in box env (BYO)
#   - scenecraft.online /broker/musicful/proxy if broker config present
#   - admin error if neither configured
```

### Long-running generations under the broker

Many paid APIs (Musicful, Veo) are async: kick off → poll until terminal. The broker can't hold a request open for minutes. Three realistic options; M16-equivalent ships Option 1:

1. **Box drives the cadence** (simplest, MVP): box POSTs `broker.musicful/generate` → gets task IDs. Box POSTs `broker.musicful/poll?ids=...` every 5s from its own polling loop. Each poll is a short-lived server-fn invocation. Box cannot forge completion (it's asking the broker, not reporting). Broker records each poll.
   - Trade-off: if box disconnects mid-generation, polling stops. On reconnect, box resumes polling and eventually observes terminal state. Minor UX cost.
2. **Cloud-side Durable Object / Queue**: first `generate` call schedules a worker that owns the polling loop. Generation survives box disconnects. Requires Cloudflare Durable Objects / Queues / Vercel Cron.
3. **Third-party webhooks**: provider calls back scenecraft.online when done. Rare in practice (Musicful has none); useful when available.

### Two spend ledgers

**Box-local `spend_ledger` (in `server.db`):**
- Records every call the box made, BYO AND brokered (from the box's perspective).
- Useful for local UX: credits counter, per-project history, offline analytics.
- NOT authoritative for brokered billing — an instance user with box access can manipulate it.
- `source` column distinguishes `'local'` (BYO) vs `'broker'` (brokered).

**scenecraft.online `spend_ledger` (cloud DB):**
- Records brokered calls only (BYO calls never hit scenecraft.online).
- Authoritative for billing. The user can't touch it.
- Richer schema captures `(box_id, asserted_username, asserted_org, service, provider_amount, markup_amount, total_amount, unit, metadata, created_at)`.
- `asserted_username` is an opaque string from the box — scenecraft.online doesn't resolve it to its own user namespace because most instance users don't have scenecraft.online accounts. Admin's dashboard groups by `(box_id, asserted_username)` and the admin interprets.

### Key vault

Third-party keys for brokered mode live in scenecraft.online's encrypted secret storage (KMS-wrapped in DB, or a dedicated secret manager). Never returned in API responses. Accessed only by the broker service-fn at call time.

### Billing + markup

Per service, per plan:
- `plans.musicful_markup_pct = 20` (example)
- Broker call sequence: compute `provider_amount` (from provider's response), add markup (`ceil(provider_amount * markup_pct / 100)`), log both, charge user's org balance for `total_amount = provider_amount + markup_amount`.
- Per-org balance model: either prepaid credits (simpler) or postpaid invoicing (complex; needs payment rails). MVP likely prepaid.
- Per-org budget limits: `budget_limits(org, unit, period, limit_amount)` — checked before proxying; reject with HTTP 402 (payment required) if exceeded.

### Config sync: scenecraft.online → box

Boxes learn per-service mode via config pushed from scenecraft.online:

```json
{
  "services": {
    "musicful":   { "mode": "broker", "broker_url": "https://api.scenecraft.online/broker" },
    "veo":        { "mode": "byo", "env_hint": "GOOGLE_API_KEY" },
    "replicate":  { "mode": "broker", "broker_url": "https://api.scenecraft.online/broker" }
  },
  "box_id": "box_abc123",
  "box_auth_token": "<short-lived>",
  "refresh_at": "2026-04-24T00:00:00Z"
}
```

Pushed at box-provisioning. Refreshed via periodic `GET https://api.scenecraft.online/boxes/<box_id>/config`. Changes to service mode (BYO → broker) propagate on next sync.

### Box auth to scenecraft.online

Each box holds a long-lived `box_auth_token` issued at provisioning. Every brokered call includes the token; scenecraft.online validates → resolves to `(box_id, org)` → checks budget → forwards.

Box tokens differ from:
- Instance-user sessions (per-user-per-box, password-derived)
- Instance-user API keys (per-user-per-box, admin-issued)
- Admin scenecraft.online logins (password+maybe-MFA, for the portal)

### What scenecraft.online does and does NOT store

**scenecraft.online stores:**
- Admin accounts (email, password hash, billing contact, plan)
- Orgs (name, owner admin, plan, billing state)
- Boxes (box_id, org, hostname, provisioned_at, box_auth_token hash)
- Per-service config (mode, BYO key ciphertext, markup %)
- Authoritative brokered `spend_ledger` (box_id + asserted_username + asserted_org + service + amounts)
- Budget limits + balances
- Billing events (invoices, payments)

**scenecraft.online does NOT store:**
- Instance user accounts (live only on box)
- Instance user passwords (live only on box)
- Instance user API keys (live only on box)
- Project content, pool_segments, edits, any creative data (lives only on box)
- BYO keys after they've been pushed to the box? (see Open Questions — policy choice)

### Trust boundary summary

```
┌───────────────────────────────────────────────────────────────┐
│  scenecraft.online (trusted; user cannot modify its DB)       │
│  - Admin accounts                                             │
│  - Brokered spend_ledger (authoritative)                      │
│  - BYO-key vault (encrypted)                                  │
│  - Billing + markup + balances                                │
└───────────────────────────────────────────────────────────────┘
                             │
                             │ JWT / box_auth_token
                             │
┌───────────────────────────────────────────────────────────────┐
│  Box (user-accessible via SSH; DB contents are user-mutable)  │
│  - Instance users (authoritative for who-is-who on this box)  │
│  - Sessions / API keys (authoritative for auth)               │
│  - Local spend_ledger cache (NOT authoritative for billing)   │
│  - Project DBs, pool_segments, etc.                           │
└───────────────────────────────────────────────────────────────┘
```

The box is authoritative for **"who is this request coming from on this box."** scenecraft.online trusts that assertion within the box's namespace. Outside the box's namespace (billing, plans, markup, BYO keys across boxes), scenecraft.online is authoritative.

---

## Benefits

- **Clean trust boundary**: each side is authoritative only for what it can enforce. No data is "shared authority" — a single source of truth for every fact.
- **BYO + brokered coexist**: admins with cheap existing Google Cloud / Replicate accounts don't pay scenecraft markup; admins who prefer a single invoice opt into broker. Both run the same plugin code.
- **SaaS-ready without forcing SaaS**: self-hosted scenecraft stays pure BYO; nothing about M16's core work assumes scenecraft.online exists. The platform is additive.
- **Instance-user namespace scoping**: admins on Box A don't collide with admins on Box B; scenecraft.online never has to unify user namespaces it doesn't control.
- **No PII escape**: instance-user passwords, API keys, and session state never leave the box. Compliance story is cleaner.
- **Markup billing without custom infra per-service**: `spend_ledger` is service-agnostic (per R9a in music-gen spec); new services added without billing-pipeline rework.
- **TanStack Start as the platform runtime**: server functions give synchronous endpoint wrapping, type-safe cross-tier, deploys to Cloudflare/Vercel. Low ops overhead vs. a hand-rolled API service.

---

## Trade-offs

- **Mode switching is not transparent to the user**. A user happily using brokered Musicful will see different error messages if their admin switches them to BYO and misconfigures the key. Documentation burden.
- **Broker in the hot path adds latency**. Brokered calls traverse box → scenecraft.online → provider → scenecraft.online → box. Tens of ms extra per call. Fine for AI-generation latencies; painful for chattier services.
- **Cross-box user identity is not unified.** If Alice is an instance user on both box-A and box-B (two different orgs), scenecraft.online sees her as `(box-A, alice)` and `(box-B, alice)` — two separate tuples for the same human. Admin dashboards must deal. Unifying would require cross-box identity federation (substantially more infra).
- **Box token compromise = broker access**. If an attacker steals a box_auth_token, they can hit the broker as that box. Mitigations: short-lived tokens via rotation, bind-to-box-IP, rate limits per box. None are perfect.
- **Instance-user provisioning by the admin assumes admin honesty.** An admin with ill intent can provision many users, burn org credits, and disappear. scenecraft.online must enforce budget limits at the org level to cap exposure.
- **BYO key storage policy is a choice**: should scenecraft.online cache BYO keys (simpler push-to-box), or only hold them transiently and push direct without storing (less exposure)? See Open Questions.
- **Polling under Option 1 means generations die if box disconnects**. Mitigable (box resumes on reconnect) but a UX surprise for long-running jobs.
- **Multi-org UX is fiddly**: `X-Scenecraft-Org` header, session fallback, per-request resolution — each is simple; the combination is error-prone to implement. Spec in music-gen pins it (R54e); reusable across plugins but needs test coverage per plugin.

---

## Key Design Decisions

Captured from rounds 1-5 of chat with the project owner (2026-04-22 / 2026-04-23).

### Architecture

| Decision | Choice | Rationale |
|---|---|---|
| Platform hosting | TanStack Start SaaS at scenecraft.online | Already used by scenecraft editor frontend; type-safe server fns; deploys to edge; reuses existing auth primitives. |
| Trust boundary | Box vs. scenecraft.online; never blur | SSH-accessible boxes are not trustable for billing; centralized ledger is the only honest model. |
| Box polling cadence (MVP) | Option 1 — box drives poll, broker is stateless per-call | Zero new cloud infra; survives with minor UX cost (disconnect mid-gen requires reconnect). Durable Objects / webhooks are follow-ons. |
| API key storage (BYO) | TBD — cache in scenecraft.online vault or push-only | See Open Questions. |
| Authoritative ledger location | scenecraft.online for brokered; box-local cache for BYO | scenecraft.online can't observe BYO calls (provider is paid directly by admin); box can't be trusted for brokered. |

### Identity & auth

| Decision | Choice | Rationale |
|---|---|---|
| Two user populations | scenecraft.online admins + box-only instance users | Most instance users don't need scenecraft.online accounts; keeps compliance surface smaller. |
| Instance user provisioning paths | Portal REST + CLI on box | Admins pick whichever fits their workflow; both produce identical box-local DB state. |
| Instance user auth | Double-gate: session (password-login JWT) + API key header | Defense in depth; neither alone grants access. |
| Password lifecycle | Default password at provisioning; forced change on first login (`must_change_password=1`) | Standard enterprise practice; admins can issue accounts safely. |
| API key lifecycle | Expiry ≤ 1 year; admin-only rotation | Bounds exposure; prevents self-rotation (admins control churn). |
| API key presentation | Header `X-Scenecraft-API-Key: <key>` | Standard, easy to strip in logs, no URL leakage. |
| Active org resolution (multi-org users) | Header `X-Scenecraft-Org` → session `last_active_org` → single-org → HTTP 400 | Explicit-over-implicit, fall-through to session convenience, fail-fast when ambiguous. |
| API key id on ledger | `spend_ledger.api_key_id` recorded for rotation forensics | Cheap column; invaluable when investigating compromise. |

### Billing

| Decision | Choice | Rationale |
|---|---|---|
| Ledger table name | `spend_ledger` (not `credit_ledger`) | Service-agnostic; handles credits, dollars, tokens, characters, seconds. |
| Amount representation | `INTEGER amount` + `TEXT unit` | Exact math; no float rounding; unit-coded so services can pick their own atomic unit. |
| Unit open-ended | No core enum on `unit` | New services don't require core schema churn. Suggested conventions: `credit`, `usd_micro`, `token`, `character`, `second`. |
| Aggregation | Always group by unit | Can't sum credits and dollars; admin UI shows per-unit totals + converted $ estimate. |
| Markup model | Per-plan, per-service `markup_pct` | Plans are scenecraft.online's billing primitive; per-service granularity lets low-margin services be priced differently. |
| Budget enforcement | Per-org via `budget_limits(org, unit, period, limit)`; checked at broker entry | Org is the billing principal; per-user is too granular for MVP. |
| Box-local ledger role | UX cache + BYO authoritative | Shows users their own spend history without a round-trip; BYO mode has no cloud ledger so local is authoritative. |

### Platform semantics

| Decision | Choice | Rationale |
|---|---|---|
| Scoped config | Per-box service-mode config pushed from scenecraft.online | Single source of truth for what a box can/can't call. |
| Subdomain routing | `<tenant>.scenecraft.online` → box | Clean branding, per-tenant identity, natural DNS/TLS story. |
| Instance-user federation | None — each box is its own namespace | Simpler; mirrors how most corporate directories work (each internal system has its own user records). |
| Compliance data | Stored only on box; never replicated to scenecraft.online | Smallest GDPR/SOC2 surface for scenecraft.online. |

---

## Dependencies

- **Existing scenecraft auth layer (M6)** — SSH-based auth, JWT auth flow, UUID migration, session management, working-copy routing. These ship today and underpin the session half of the double-gate.
- **New `api_keys` table on box** — admin-issued, expiring, tied to a user. Not yet in the codebase as of 2026-04-23; needs a schema migration as part of implementing R54a+ in the music-gen spec.
- **scenecraft.online as a new deployment** — doesn't exist yet. This design precedes that work.
- **TanStack Start** — already a frontend dependency; reused as the SaaS runtime.
- **A hosted DB for scenecraft.online** — D1, Neon, or similar. Choice TBD in implementation spike.
- **Secret storage for third-party keys** — KMS-wrapped column in hosted DB, or dedicated secret manager. TBD.
- **Box provisioning mechanism** — how a new box is spun up (Kubernetes, Nomad, plain VMs, Docker). TBD.

---

## Testing Strategy

Platform testing spans three surfaces, largely separable:

- **Box (scenecraft-engine) tests**: double-gate auth middleware, API-key expiry, active-org resolution, `plugin_api.call_service()` routing between BYO and broker modes, box-local ledger writes. Many of these are specified in `local.music-generation-plugin.md` tests and reused here.
- **scenecraft.online server-fn tests**: box-auth-token validation, markup computation, budget enforcement, BYO-key vault writes, authoritative-ledger correctness. Integration tests with a mock box pretending to be authenticated.
- **End-to-end trust tests**: simulate an attacker with SSH access to a box manipulating `spend_ledger`, then confirm scenecraft.online's billing view is unaffected. Simulate a replayed box_auth_token, expired token, box-IP binding, rate limits.

This design doc does not enumerate test cases individually; implementation milestones will spec them per-surface.

---

## Future Considerations

- **Cross-box instance-user federation** — enterprise-y: Alice on box-A = Alice on box-B. Requires a federation layer (SAML/OIDC to scenecraft.online), issuing box-scoped ephemeral identities from a central directory. Substantial infra; worth only if enterprise customers demand it.
- **Durable-Objects / queued polling** (cloud Option 2) — replaces box-driven polling for generations that must survive disconnects. Likely added when a paid plugin starts taking >10 min per generation.
- **Third-party webhook receivers** — for providers that support them. scenecraft.online exposes `/webhooks/<provider>/<box_id>` endpoints. Musicful doesn't; Stripe/Linear/GitHub apps will.
- **Plugin marketplace** — scenecraft.online hosts the central registry. Boxes fetch plugin code from here with version pins. Couples tightly to the plugin lifecycle design (M17 spike).
- **Admin dashboards** — spend analytics, budget alerts, plan upgrades. Minimal in MVP; grows with billing product maturity.
- **Postpaid billing + invoicing** — prepaid credits are MVP; enterprise customers will want invoicing. Adds payment-rails integration (Stripe, probably).
- **Per-user-globally API keys** — if a user has access to multiple boxes, scenecraft.online could issue one key that works across them. Currently out of scope (see music-gen spec Open Question 8).
- **Compliance certifications** — SOC 2, ISO 27001, etc. once scenecraft.online has enough customers to justify. Architecture already keeps PII on-box, which helps.

---

## Open Questions

1. **BYO key storage policy on scenecraft.online.** Two defensible options:
   - **Cache encrypted**: scenecraft.online stores the BYO key (KMS-wrapped). Easier push-to-box on box add. Bigger breach surface.
   - **Push-only**: scenecraft.online accepts the BYO key from the admin UI, immediately pushes to all relevant boxes, and does NOT persist. Admin must re-enter to provision new boxes.
   Trade-off between convenience and attack surface. Recommend push-only for MVP; promote to cache later if UX demands.
2. **Box auth token lifetime and rotation.** Long-lived tokens ease box operation but increase compromise impact. Short-lived tokens require a refresh flow. Recommend short-lived (e.g., 24h) with automatic refresh via box-provisioning record.
3. **Balance model: prepaid vs postpaid.** MVP likely prepaid credits (admins top up via Stripe). Postpaid = net-30 invoicing; requires billing-rails work. Not blocking for architectural design.
4. **Budget-limit period.** Per-month rolling? Per-calendar-month? Per-plan-period? Each has different billing-period-reset semantics. Decide as part of billing implementation.
5. **scenecraft.online DB choice.** Cloudflare D1 (fits TanStack Start on Cloudflare), Neon Postgres (richer SQL), managed SQLite, or something else. Decide during implementation spike; architecture is agnostic.
6. **Secret storage.** KMS-wrapped DB column (simple) vs. AWS/GCP secret manager (more robust rotation). Decide during implementation.
7. **API-key-per-user-per-box vs per-user-globally.** Currently per-(user, box). Cross-box unification is Open Question 8 in the music-gen spec. Defer.
8. **What happens on box deletion?** Admin deletes a box in the portal → what happens to its instance users, its local ledger cache, its pending brokered generations, its retained pool_segments? Data-deletion / retention policy needs a design pass before first production deploy.

---

## Related Documents

- **`agent/specs/local.music-generation-plugin.md`** — M16 music-gen spec; first consumer of this architecture's BYO mode. Requirements R54a-f pin the auth/ledger contract that this design describes at the platform level.
- **`agent/tasks/unassigned/task-spike-plugin-schemas-and-unified-jobs.md`** — M17 plugin-lifecycle spike; overlaps with the box-side plugin loader.
- **`agent/tasks/unassigned/task-spike-auto-duck-plugin.md`** — another plugin example; shows the architecture accommodates non-paid plugins too.
- **`agent/tasks/unassigned/task-dockview-dead-code-removal.md`** — independent cleanup.
- **Clarification 10** (`agent/clarifications/clarification-10-musicful-music-generation-plugin.md`) — where the rounds 1-5 decisions that seeded this design were captured.

---

**Status**: Design Specification
**Recommendation**: This design is intentionally abstract — it captures the trust boundary, identity model, and billing semantics that scenecraft.online will implement, but NOT the specific stack choices (DB, secret manager, box-provisioning infra). Those land in an implementation spike and milestone of their own, which this design feeds into.
**Next Steps**:
1. File an implementation spike (`task-spike-scenecraft-online-implementation.md`) once rough cloud delivery timeline is known.
2. Update M16 music-gen spec's auth/ledger requirements to reference this design as the platform-level context (already done via R54a-f).
3. Answer the 8 Open Questions when the implementation spike starts — most are implementation choices rather than architectural ones.
