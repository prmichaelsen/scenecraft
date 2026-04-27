# Spec: Plugin Host and Manifest System

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Draft (retroactive)

---

## Purpose

Define the observable behavior of the scenecraft plugin host (Python backend + TypeScript frontend mirror) and the `plugin.yaml` manifest schema that it consumes. This is a retroactive spec — behavior is encoded verbatim from the current implementation, including bugs.

## Source

- Retroactive / reverse-engineered from code
- `scenecraft-engine/src/scenecraft/plugin_host.py`
- `scenecraft-engine/src/scenecraft/plugin_manifest.py`
- `scenecraft-engine/src/scenecraft/plugin_api/__init__.py` (only `register_rest_endpoint` — the rest of the plugin_api surface is a separate spec)
- `scenecraft/src/lib/plugin-host.ts` (frontend mirror)
- Example manifests: `plugins/generate_foley/plugin.yaml`, `plugins/light_show/plugin.yaml`
- Audit: `agent/reports/audit-2-architectural-deep-dive.md` §1A

## Scope

**In scope**:
- Plugin registration lifecycle (Python): manifest load → `activate(plugin_api, context)` → declarative `register_declared` → LIFO disposal on `deactivate`
- Plugin registration lifecycle (TypeScript mirror): `register(plugin, name)` → `activate(host, context)` → LIFO disposal
- `plugin.yaml` schema: required fields, contribution points (operations, mcpTools, restEndpoints, contextMenus, settings, activationEvents), settings types
- Handler reference resolution (`backend:...` dotted paths; `frontend:...` rejected at resolve time)
- Contribution registries: operations, MCP tools, REST routes (by HTTP method, auto-prefixed), panels (frontend), context menus
- Namespacing rules: `{plugin}__{tool_id}` double-underscore; plugin id cannot contain `__`
- REST auto-prefix: `^/api/projects/(?P<project>[^/]+)/plugins/{plugin}/{suffix}$`
- Disposable contract and LIFO teardown order
- Error behavior: duplicate ids, missing handlers, malformed manifests, deactivate-unknown-name, re-register-without-deactivate
- Test-support reset (`_reset_for_tests`, `_resetForTests`)

**Out of scope**:
- `plugin_api` surface itself (`record_spend`, `get_project_db`, WS broadcast, etc.) — separate spec
- Replicate provider and other typed providers — separate spec
- Individual plugin behavior (`generate_foley`, `light_show`, `transcribe`, etc.) — one spec per plugin
- Dynamic plugin loading / sandboxing / process isolation (MVP uses static import)
- R9a enforcement beyond convention (separate spec)

---

## Requirements

1. **R1**: `PluginHost.register(plugin_module)` MUST load the plugin's `plugin.yaml` (if present), cache it on the host keyed by `manifest.name`, and attach it to `context.manifest` BEFORE calling `plugin.activate`.
2. **R2**: Manifest load failures MUST NOT prevent `activate()` from being called; the error is logged to stderr and `context.manifest` remains `None`.
3. **R3**: `PluginHost.register` MUST support both `activate(plugin_api)` (1-arg legacy) and `activate(plugin_api, context)` (2-arg) signatures, dispatched by introspecting the callable's signature.
4. **R4**: Re-registering an already-registered plugin (same module `__name__`) MUST be a silent no-op returning the existing `PluginContext`.
5. **R5**: `PluginHost.deactivate(name)` MUST dispose every `context.subscriptions` entry in **LIFO order**, then call the plugin module's optional `deactivate(context)` hook.
6. **R6**: `deactivate` on an unknown name MUST be a silent no-op.
7. **R7**: A raised exception inside a `Disposable.dispose()` MUST NOT abort the teardown loop — remaining disposables still fire; the error is logged to stderr.
8. **R8**: `register_operation` MUST reject duplicate operation ids by raising `AssertionError` (Python) or `Error` (TypeScript).
9. **R9**: `register_mcp_tool` MUST namespace the tool as `{plugin}__{tool_id}` and reject duplicates by full name.
10. **R10**: `register_rest_endpoint(path_regex, handler, method=..., context=...)` MUST register the route in the per-method dict (`GET`/`POST`/`PUT`/`DELETE`/`PATCH`) and return a `Disposable` that removes it.
11. **R11**: `dispatch_rest(method, path, *args, **kwargs)` MUST iterate registered routes for the given method, regex-match `path`, and call the first matching handler. No match MUST return `None`.
12. **R12**: When the matched regex has named groups, `dispatch_rest` MUST pass `path_groups=<dict>` as a kwarg; otherwise it MUST NOT add that kwarg (back-compat with strict-signature handlers).
13. **R13**: `register_declared(plugin_module, context)` MUST read `context.manifest` and register each declared operation, mcpTool, and restEndpoint by resolving its handler ref against `plugin_module`. A resolve failure for one contribution MUST log and skip ONLY that contribution — it MUST NOT abort the whole batch.
14. **R14**: `register_declared` MUST auto-prefix every declared REST route with `^/api/projects/(?P<project>[^/]+)/plugins/{re.escape(plugin_name)}{suffix}$`.
15. **R15**: `parse_manifest(data)` MUST require top-level `name` and `version`; missing either raises `PluginManifestError`.
16. **R16**: `parse_manifest` MUST reject a `name` containing `__` with `PluginManifestError` (collision with the tool-namespace separator).
17. **R17**: Each operation manifest entry MUST require `id`, `label`, `entityTypes`, `handler`; missing any raises `PluginManifestError`.
18. **R18**: Each mcpTool entry MUST require `id`, `description`, `handler`, `input_schema`; `input_schema` MUST be a mapping; `destructive` defaults to `False`.
19. **R19**: Each restEndpoint entry MUST require `method`, `suffix`, `handler`; `method` MUST be one of `GET|POST|PUT|DELETE|PATCH` (case-normalized to upper); `suffix` MUST start with `/`.
20. **R20**: Each setting MUST have a `type` from `{enum, string, boolean, number}`; `type: enum` MUST have `values: [...]` (list); otherwise raise.
21. **R21**: Each context menu MUST have an `entityType` and items with an `operation` reference; missing either raises.
22. **R22**: `resolve_handler(plugin_module, ref)` MUST accept `"foo"`, `"backend:foo"`, and dotted `"backend:mod.fn"`. A `"frontend:..."` ref MUST raise `PluginManifestError` at resolve time. A missing attribute MUST raise `PluginManifestError`. A non-callable resolution MUST raise `PluginManifestError`.
23. **R23**: `load_manifest(module)` MUST return `None` when the plugin's package directory has no `plugin.yaml`; a present-but-malformed file MUST raise `PluginManifestError`.
24. **R24**: The frontend `PluginHost.register(plugin, name)` MUST mirror the backend semantics: silent no-op on re-register, LIFO disposal on `deactivate`, optional async `deactivate(context)` invoked after subscriptions.
25. **R25**: The frontend `registerPanel(panel, context?)` MUST reject duplicate `panel.id` by throwing; `getPanel(id)` MUST return the registered contribution or `undefined`.
26. **R26**: The frontend `registerContextMenu(menu, context?)` MUST append to a per-entityType list (not a unique map) and `getContextMenuItems(entityType)` MUST flatten items across all menus for that entity kind.
27. **R27**: `_reset_for_tests` / `_resetForTests` MUST call `deactivate` on every registered plugin (best-effort) and then clear every internal registry.
28. **R28**: The plugin host MUST be process-singleton state (class-level dicts in Python; module-level singleton `PluginHost` instance in TypeScript).
29. **R29**: The system MUST be single-threaded / synchronous at registration time (no mutex or lock is taken around registry mutations); concurrent registration is not supported.
30. **R30**: `register_declared` MUST be a no-op when `context.manifest is None` (imperative-only plugin).

---

## Interfaces / Data Shapes

### Python — PluginHost (classmethod surface)

```python
class PluginHost:
    @classmethod
    def register(cls, plugin_module) -> PluginContext: ...
    @classmethod
    def register_declared(cls, plugin_module, context: PluginContext) -> None: ...
    @classmethod
    def deactivate(cls, name: str) -> None: ...
    @classmethod
    def register_operation(cls, op: OperationDef, context=None) -> Disposable: ...
    @classmethod
    def register_mcp_tool(cls, tool: MCPToolDef, context=None) -> Disposable: ...
    @classmethod
    def dispatch_rest(cls, method: str, path: str, *args, **kwargs) -> Any: ...
    @classmethod
    def get_operation(cls, op_id: str) -> Optional[OperationDef]: ...
    @classmethod
    def list_operations(cls, entity_type: Optional[str] = None) -> list[OperationDef]: ...
    @classmethod
    def get_mcp_tool(cls, full_name: str) -> Optional[MCPToolDef]: ...
    @classmethod
    def list_mcp_tools(cls) -> list[MCPToolDef]: ...
    @classmethod
    def get_manifest(cls, plugin_id: str) -> Optional[PluginManifest]: ...
    @classmethod
    def list_manifests(cls) -> list[PluginManifest]: ...
    @classmethod
    def _reset_for_tests(cls) -> None: ...
```

### Python — Disposable

```python
@runtime_checkable
class Disposable(Protocol):
    def dispose(self) -> None: ...

def make_disposable(fn: Callable[[], None]) -> Disposable: ...
```

### Python — Data types

```python
@dataclass
class PluginContext:
    name: str
    subscriptions: list[Disposable]
    manifest: Any = None  # PluginManifest | None

@dataclass
class OperationDef:
    id: str
    label: str
    entity_types: list[str]
    handler: Callable[[str, str, dict], dict]

@dataclass
class MCPToolDef:
    plugin: str
    tool_id: str
    description: str
    input_schema: dict
    handler: Callable[[dict, dict], dict]
    destructive: bool = False
    @property
    def full_name(self) -> str: ...  # f"{plugin}__{tool_id}"
```

### Manifest schema (YAML)

```yaml
name: <plugin_id>                 # REQUIRED. Must not contain "__"
version: <string>                 # REQUIRED
displayName: <string>             # optional
description: <string>             # optional
publisher: <string>               # optional
license: <string>                 # optional (parsed as `license_`)

activationEvents:                 # optional, list[str], e.g. ["onStartup"]
  - onStartup

settings:                         # optional, mapping of name -> spec
  <setting_name>:
    type: enum|string|boolean|number
    default: <any>
    values: [<any>, ...]          # REQUIRED iff type == enum
    description: <string>

contributes:
  operations:
    - id: <string>                # REQUIRED
      label: <string>             # REQUIRED
      entityTypes: [<string>, ...] # REQUIRED
      handler: <ref>              # REQUIRED
      panel: <ref>                # optional (stored, not resolved)
      outputs: [...]              # optional, list[dict]

  mcpTools:
    - id: <string>                # REQUIRED
      description: <string>       # REQUIRED
      handler: <ref>              # REQUIRED
      input_schema: <object>      # REQUIRED; must be a mapping
      destructive: <bool>         # optional, default false

  restEndpoints:
    - method: GET|POST|PUT|DELETE|PATCH  # REQUIRED
      suffix: /<path>             # REQUIRED; must start with "/"
      handler: <ref>              # REQUIRED

  contextMenus:
    - entityType: <string>        # REQUIRED
      items:
        - operation: <op_id>      # REQUIRED
          label: <string>
          icon: <string>
          reveals: <string>
```

### Handler reference grammar

```
ref := "backend:" dotted_path | "frontend:" <opaque> | dotted_path
dotted_path := ident ("." ident)*
```

- `backend:` prefix: resolve by `getattr` walk against the plugin module
- `frontend:` prefix: `resolve_handler` raises `PluginManifestError`; panel refs on operations are stored as metadata without resolution
- No prefix: treated as bare dotted path against the plugin module

### REST auto-prefix

For plugin name `P` and manifest suffix `S`, the registered regex is:

```
^/api/projects/(?P<project>[^/]+)/plugins/{re.escape(P)}{S}$
```

The `project` named group is always captured; plugin-defined groups inside `S` are appended. `dispatch_rest` forwards all named groups as `path_groups` kwarg.

### TypeScript — PluginHostImpl

```ts
class PluginHostImpl {
  register(plugin: PluginModule, name?: string): PluginContext
  deactivate(name: string): Promise<void>
  registerOperation(op: OperationDescriptor, context?: PluginContext): Disposable
  registerContextMenu(menu: ContextMenuDescriptor, context?: PluginContext): Disposable
  registerPanel(panel: PanelContribution, context?: PluginContext): Disposable
  getOperation(id: string): OperationDescriptor | undefined
  listOperations(entityType?: string): OperationDescriptor[]
  getContextMenuItems(entityType: string): ContextMenuDescriptor['items']
  getPanel(id: string): PanelContribution | undefined
  listPanels(): PanelContribution[]
  get registeredCount(): number
  get operationCount(): number
  _resetForTests(): void
}

export const PluginHost: PluginHostImpl // module singleton
```

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | Plugin with valid `plugin.yaml` is registered | Manifest loaded, cached by `name`, attached to context before `activate` runs | `register-loads-manifest-before-activate`, `manifest-cached-by-name` |
| 2 | Plugin with no `plugin.yaml` is registered | `activate` still runs; `context.manifest` is `None` | `imperative-only-plugin-registers` |
| 3 | Plugin with malformed `plugin.yaml` is registered | Manifest error logged to stderr; `context.manifest=None`; activate still runs | `malformed-manifest-does-not-abort-register` |
| 4 | Plugin with legacy `activate(api)` 1-arg signature | Called with just `plugin_api`; context still created | `legacy-1-arg-activate-supported` |
| 5 | Plugin with `activate(api, context)` 2-arg signature | Called with both; subscriptions can be appended | `2-arg-activate-receives-context` |
| 6 | Same plugin registered twice | Second call returns existing `PluginContext`; activate NOT re-invoked | `re-register-is-noop` |
| 7 | `register_declared` reads manifest operations | Each operation resolved + registered with host; disposables pushed to context | `register-declared-wires-operations` |
| 8 | `register_declared` reads manifest mcpTools | Each tool registered as `{plugin}__{tool_id}` with `destructive` preserved | `register-declared-wires-mcp-tools` |
| 9 | `register_declared` reads manifest restEndpoints | Each endpoint auto-prefixed with `^/api/projects/.../plugins/{plugin}/{suffix}$` and registered under the declared HTTP method | `register-declared-wires-rest-endpoints`, `rest-auto-prefix-uses-regex-escape` |
| 10 | `register_declared` with `context.manifest=None` | Silent no-op | `register-declared-noop-without-manifest` |
| 11 | Manifest operation refers to missing handler | Error logged; that operation skipped; other contributions still registered | `missing-handler-skips-one-logs-rest-continue` |
| 12 | `handler: "backend:mod.fn"` | Resolved via getattr walk; returns callable | `resolve-handler-backend-prefix`, `resolve-handler-dotted-path` |
| 13 | `handler: "foo"` (no prefix) | Resolved against plugin module root | `resolve-handler-bare-ref` |
| 14 | `handler: "frontend:x"` resolved on backend | `PluginManifestError` raised | `resolve-handler-frontend-ref-rejected` |
| 15 | `handler` resolves to non-callable value | `PluginManifestError` raised | `resolve-handler-non-callable-rejected` |
| 16 | Manifest `name` contains `__` | `parse_manifest` raises `PluginManifestError` | `manifest-name-with-double-underscore-rejected` |
| 17 | Manifest missing `name` or `version` | `parse_manifest` raises `PluginManifestError` | `manifest-missing-required-fields` |
| 18 | restEndpoint suffix does not start with `/` | `parse_manifest` raises `PluginManifestError` | `rest-suffix-must-start-with-slash` |
| 19 | restEndpoint method is lowercase or mixed | Normalized to uppercase; accepted if in valid set | `rest-method-case-normalized` |
| 20 | restEndpoint method is invalid (e.g. `FOO`) | `PluginManifestError` raised | `rest-method-invalid-rejected` |
| 21 | Setting with `type: enum` and no `values` | `PluginManifestError` raised | `enum-setting-requires-values` |
| 22 | Setting with unknown `type` | `PluginManifestError` raised | `setting-unknown-type-rejected` |
| 23 | mcpTool with non-mapping `input_schema` | `PluginManifestError` raised | `mcp-tool-input-schema-must-be-mapping` |
| 24 | `register_operation` called with duplicate id | `AssertionError` raised; registry unchanged | `duplicate-operation-id-rejected` |
| 25 | `register_mcp_tool` with duplicate `{plugin}__{tool_id}` | `AssertionError` raised | `duplicate-mcp-tool-full-name-rejected` |
| 26 | `deactivate(name)` called on registered plugin | All subscriptions disposed LIFO; plugin's optional `deactivate(context)` runs afterward | `deactivate-disposes-lifo`, `deactivate-calls-plugin-hook-after-subscriptions` |
| 27 | `deactivate` on never-registered name | Silent no-op; no error | `deactivate-unknown-name-noop` |
| 28 | One disposable raises during teardown | Remaining disposables still fire; stderr log | `disposable-exception-does-not-abort-teardown` |
| 29 | Plugin module's `deactivate(context)` raises | Error logged; teardown still considered complete | `plugin-deactivate-hook-exception-swallowed` |
| 30 | `dispatch_rest(method, path)` matches registered regex | First match wins; handler invoked with `(path, *args, **kwargs)` | `dispatch-rest-matches-first` |
| 31 | Matched regex has named groups | Handler receives `path_groups={name: value}` kwarg | `dispatch-rest-passes-path-groups` |
| 32 | Matched regex has no named groups | Handler called without `path_groups` kwarg (back-compat) | `dispatch-rest-no-path-groups-for-anonymous-regex` |
| 33 | No route matches the given (method, path) | Returns `None` | `dispatch-rest-no-match-returns-none` |
| 34 | Handler for wrong HTTP method exists | Ignored — only routes for the requested method are considered | `dispatch-rest-method-isolated` |
| 35 | Frontend: duplicate panel id | `registerPanel` throws | `fe-duplicate-panel-id-throws` |
| 36 | Frontend: `getContextMenuItems(entityType)` | Flattens items across all menus contributed for that entityType | `fe-context-menu-items-flattened` |
| 37 | Frontend: async `activate` returns rejected promise | `.catch` logs to console.error; register still succeeds synchronously | `fe-async-activate-rejection-logged` |
| 38 | `_reset_for_tests` with active plugins | Every plugin deactivated (LIFO disposal); all registries cleared | `reset-for-tests-deactivates-all` |
| 39 | Two plugins register operations with same id | Second registration raises `AssertionError`; first registration still active | `cross-plugin-operation-id-collision-rejected` |
| 40 | Plugin declares REST endpoint with named group in suffix | Group captured; passed to handler via `path_groups` at dispatch | `rest-endpoint-with-named-group-param` |
| 41 | Plugin uses bare dotted handler ref that hits a module attribute raising on access | Wrapped in `PluginManifestError`; contribution skipped; other contributions continue | `handler-getattr-raises-wrapped-as-manifest-error` |
| 42 | Manifest file exists but YAML is empty (`None`) | `parse_manifest({})` path: raises `PluginManifestError` on missing `name` | `empty-yaml-file-missing-required` |
| 43 | `register_declared` registers contributions from a module that has no manifest loaded, but context.manifest was set externally | Uses that manifest; behaves as normal | `undefined` |
| 44 | Two plugins independently register the same REST path regex under different methods | Both registered; dispatch routes by method | `same-path-different-method-coexist` |
| 45 | Two plugins register the same REST path regex under the SAME method | Second overwrites first (dict `[key] = value`); no dup check | `same-path-same-method-second-wins` |
| 46 | Plugin's `activate` raises before pushing subscriptions | Exception propagates from `register`; plugin NOT stored in `_contexts`; manifest still cached | `undefined` |
| 47 | Concurrent `register` calls for two different plugins | `undefined` (no locking; last-writer-wins on class dicts) | → [OQ-1](#open-questions) |
| 48 | Plugin deactivated while a REST dispatch is in flight for one of its routes | `undefined` (no coordination; handler may run after disposal) | → [OQ-2](#open-questions) |
| 49 | Manifest carries `activationEvents: [onStartup]` | Parsed and stored; host does NOT currently act on activation events | `activation-events-parsed-not-enforced` |
| 50 | Plugin declares operation with `panel: "frontend:..."` | `panel_ref` stored as string on `OperationManifest`; NOT resolved on backend | `operation-panel-ref-stored-not-resolved` |
| 51 | `resolve_handler` on ref with empty string | `undefined` (walks empty parts list → returns module itself, which is callable-check then fails as non-callable) | → [OQ-3](#open-questions) |
| 52 | `register_declared` encounters an unknown plugin.yaml contribution key (e.g. `contributes.widgets`) | Silently ignored (only known keys are read) | `unknown-contributes-key-ignored` |

---

## Behavior (step-by-step)

### Registration (Python)

1. `PluginHost.register(plugin_module)` is called with an imported Python module.
2. If `plugin_module.__name__` is already in `_contexts`, return the existing `PluginContext` immediately (no re-invocation of `activate`).
3. Create `context = PluginContext(name=plugin_module.__name__, subscriptions=[], manifest=None)`.
4. Attempt `plugin_manifest.load_manifest(plugin_module)`:
   - If the plugin directory has no `plugin.yaml`, `load_manifest` returns `None`; `context.manifest` stays `None`.
   - If parsing/validation raises, log `[plugin-host] manifest load failed for {name}: {Type}: {msg}` to stderr; `context.manifest` stays `None`.
   - On success, store manifest in `_manifests[manifest.name]` and set `context.manifest = manifest`.
5. Introspect `plugin_module.activate`'s signature. If ≥2 parameters, call `activate(plugin_api, context)`; else call `activate(plugin_api)`.
6. Insert `context` into `_contexts[name]` and append `name` to `_registered`.

### Declarative wiring

1. Plugin author inside `activate(api, context)` calls `PluginHost.register_declared(module, context)`.
2. If `context.manifest is None`, return immediately (no-op).
3. For each `operation` in the manifest:
   - Resolve `op.handler_ref` via `resolve_handler(plugin_module, ref)`.
   - On error: log `[plugin-host] {name}: operation {id!r} handler {ref!r} — {exc}` and skip this operation.
   - On success: call `register_operation(OperationDef(...), context=context)`.
4. For each `mcpTool`: same pattern; tool full name is `{manifest.name}__{tool_id}`.
5. For each `restEndpoint`:
   - Resolve handler (same pattern).
   - Synthesize regex: `^/api/projects/(?P<project>[^/]+)/plugins/{re.escape(manifest.name)}{suffix}$`
   - Call `plugin_api.register_rest_endpoint(full_pattern, handler, method=..., context=context)`.

### REST dispatch

1. `dispatch_rest(method, path, *args, **kwargs)` uppercases `method`, looks up `_rest_routes_by_method[method]`.
2. Iterates `pattern → handler` entries in dict-insertion order.
3. For each, attempts `re.match(pattern, path)`. First match wins.
4. If `m.groupdict()` is non-empty, call `handler(path, *args, path_groups=<dict>, **kwargs)`; else `handler(path, *args, **kwargs)`.
5. Return handler return value, or `None` if no match.

### Deactivation

1. `PluginHost.deactivate(name)` pops `_contexts[name]`; removes `name` from `_registered`.
2. If no context was popped, return immediately.
3. Drain `context.subscriptions` via `pop()` (LIFO). For each, call `.dispose()` inside a `try/except`; log but do not re-raise.
4. Import the plugin module by name and call optional `deactivate(context)` hook. `ModuleNotFoundError` is silently swallowed; other exceptions are logged.

### Frontend mirror (TypeScript)

Structurally identical to Python, with these differences:
- Singleton is a module-level instance: `export const PluginHost = new PluginHostImpl()`.
- `register(plugin, name='<unknown>')` accepts an explicit name; the caller supplies it (no module `__name__`).
- `activate` may be async; a rejected promise is `.catch`-logged but does NOT prevent registration from completing synchronously.
- `deactivate` is async: disposes subscriptions with `await d.dispose()` LIFO, then awaits the optional `plugin.deactivate(context)`.
- Additional contribution types: `registerPanel` (duplicate id throws; `getPanel` / `listPanels` for lookup), `registerContextMenu` (list per entity type; `getContextMenuItems` flattens across multiple menus).
- No manifest concept on the frontend: TypeScript plugins are purely imperative.

---

## Acceptance Criteria

- [ ] Python `PluginHost.register` and `deactivate` preserve LIFO disposal semantics across at least 3 disposables.
- [ ] Manifest load failures never abort `activate()`.
- [ ] Invalid manifests raise `PluginManifestError` with a message naming the offending field.
- [ ] `backend:a.b.c` handler refs resolve via chained `getattr`.
- [ ] `frontend:...` handler refs raise `PluginManifestError` from `resolve_handler`.
- [ ] Plugin id containing `__` is rejected at parse time.
- [ ] REST routes registered via manifest are auto-prefixed with `/api/projects/<project>/plugins/<plugin>/<suffix>` and regex-matched per HTTP method.
- [ ] Duplicate operation ids raise; duplicate mcp-tool full-names raise; duplicate panel ids (frontend) throw.
- [ ] `dispatch_rest` returns `None` on no match.
- [ ] `_reset_for_tests` / `_resetForTests` clears all registries and deactivates all plugins.

---

## Tests

### Base Cases

#### Test: register-loads-manifest-before-activate (covers R1)

**Given**: a plugin module with a valid `plugin.yaml` and an `activate(api, context)` that records `context.manifest`.
**When**: `PluginHost.register(plugin_module)` is called.
**Then**:
- **manifest-set-on-context**: inside `activate`, `context.manifest` is a non-None `PluginManifest` object with `.name` equal to the manifest's `name` field.
- **manifest-cached**: `PluginHost.get_manifest(manifest.name)` returns the same manifest instance.
- **activate-called-once**: the plugin's activate body was invoked exactly once.

#### Test: manifest-cached-by-name (covers R1)

**Given**: a manifest with `name: "foo"`.
**When**: registration completes.
**Then**:
- **cached-key-is-manifest-name**: `PluginHost._manifests["foo"]` is the parsed manifest, regardless of what `plugin_module.__name__` is.

#### Test: imperative-only-plugin-registers (covers R2, R30)

**Given**: a plugin module whose package directory contains no `plugin.yaml`.
**When**: `PluginHost.register(plugin_module)` runs and the plugin's `activate` calls `register_declared(module, context)`.
**Then**:
- **manifest-is-none**: `context.manifest` is `None`.
- **register-declared-noop**: no operations, mcpTools, or restEndpoints are registered by `register_declared`.
- **plugin-stored**: the plugin's name is in `_registered`.

#### Test: legacy-1-arg-activate-supported (covers R3)

**Given**: a plugin module whose `activate` signature has exactly one parameter (`activate(api)`).
**When**: registered.
**Then**:
- **called-with-one-arg**: activate receives `plugin_api` only; no context is passed.
- **context-still-stored**: `_contexts[name]` is still populated with a `PluginContext`.

#### Test: 2-arg-activate-receives-context (covers R3)

**Given**: a plugin module whose `activate` signature has two parameters.
**When**: registered.
**Then**:
- **called-with-both**: both `plugin_api` and `context` are passed.
- **subscriptions-honored**: any disposable pushed into `context.subscriptions` during activate is later disposed on `deactivate`.

#### Test: re-register-is-noop (covers R4)

**Given**: a plugin module already registered once.
**When**: `PluginHost.register` is called again with the same module.
**Then**:
- **same-context-returned**: the returned context is `is` the original context.
- **activate-not-reinvoked**: the plugin's activate body ran exactly once total.

#### Test: register-declared-wires-operations (covers R13)

**Given**: a manifest declaring one operation with handler `backend:handle_op`, and the plugin module defines `handle_op`.
**When**: `register_declared(module, context)` runs.
**Then**:
- **op-registered**: `PluginHost.get_operation(id)` returns an `OperationDef` with matching `label`, `entity_types`.
- **handler-bound**: calling the op's `handler` invokes the plugin's `handle_op`.
- **dispose-on-deactivate**: after `deactivate(name)`, `get_operation(id)` returns `None`.

#### Test: register-declared-wires-mcp-tools (covers R9, R13)

**Given**: a manifest with `mcpTools: [{id: run, description: ..., handler: backend:run, input_schema: {...}, destructive: true}]` and `name: foo`.
**When**: `register_declared` runs.
**Then**:
- **full-name-namespaced**: `PluginHost.get_mcp_tool("foo__run")` returns a tool whose `.full_name` is `"foo__run"`.
- **destructive-preserved**: the tool's `destructive` flag is `True`.
- **dispose-on-deactivate**: after deactivation, the tool is no longer present.

#### Test: register-declared-wires-rest-endpoints (covers R14)

**Given**: plugin `foo` declares `restEndpoints: [{method: POST, suffix: /run, handler: backend:run}]`.
**When**: `register_declared` runs.
**Then**:
- **route-registered-under-POST**: `_rest_routes_by_method["POST"]` contains a pattern key matching `/api/projects/proj1/plugins/foo/run`.
- **GET-bucket-empty**: the GET bucket has no entry for this plugin.
- **regex-full-match**: the pattern regex-matches `/api/projects/anything/plugins/foo/run` and captures `project="anything"`.

#### Test: rest-auto-prefix-uses-regex-escape (covers R14)

**Given**: plugin name contains regex special characters (e.g. `"my.plugin"`).
**When**: `register_declared` registers a REST endpoint for it.
**Then**:
- **dot-escaped**: the registered pattern contains the literal escaped `my\.plugin`, not the regex wildcard `my.plugin`.

#### Test: register-declared-noop-without-manifest (covers R30)

**Given**: a context with `manifest=None`.
**When**: `register_declared(module, context)` is called.
**Then**:
- **no-ops-registered**: operation registry size unchanged.
- **no-tools-registered**: mcp tool registry size unchanged.
- **no-routes-registered**: REST route buckets unchanged.

#### Test: missing-handler-skips-one-logs-rest-continue (covers R13)

**Given**: a manifest with two operations — op A references a valid handler; op B references a missing attribute.
**When**: `register_declared` runs.
**Then**:
- **op-A-registered**: `get_operation(A)` is non-None.
- **op-B-skipped**: `get_operation(B)` is None.
- **stderr-logged**: a line starting with `[plugin-host]` mentioning op B and the ref appears on stderr.
- **no-exception**: the call returns normally.

#### Test: resolve-handler-backend-prefix (covers R22)

**Given**: plugin module has attribute `foo = <callable>`.
**When**: `resolve_handler(module, "backend:foo")`.
**Then**:
- **returns-callable**: result is the same object as `module.foo`.

#### Test: resolve-handler-dotted-path (covers R22)

**Given**: plugin module has `impl.run` where `impl` is a submodule/object with attribute `run`.
**When**: `resolve_handler(module, "backend:impl.run")`.
**Then**:
- **returns-nested**: result is `module.impl.run`.

#### Test: resolve-handler-bare-ref (covers R22)

**Given**: `resolve_handler(module, "foo")` with no prefix.
**When**: called.
**Then**:
- **resolves-against-module-root**: returns `module.foo`.

#### Test: resolve-handler-frontend-ref-rejected (covers R22)

**Given**: a handler ref `"frontend:x"`.
**When**: `resolve_handler(module, ref)` is called.
**Then**:
- **raises-manifest-error**: `PluginManifestError` is raised.
- **message-mentions-frontend**: the error message mentions "frontend".

#### Test: resolve-handler-non-callable-rejected (covers R22)

**Given**: plugin module has `foo = "not a function"`.
**When**: `resolve_handler(module, "foo")`.
**Then**:
- **raises-manifest-error**: `PluginManifestError` is raised mentioning the type.

#### Test: manifest-name-with-double-underscore-rejected (covers R16)

**Given**: YAML `{name: "my__plugin", version: "1.0"}`.
**When**: `parse_manifest(data)`.
**Then**:
- **raises**: `PluginManifestError` is raised.
- **message-mentions-namespace**: the error explains the `__` conflict.

#### Test: manifest-missing-required-fields (covers R15)

**Given**: YAML `{name: "x"}` (no version).
**When**: parsed.
**Then**:
- **raises-for-version**: `PluginManifestError` mentioning `version`.

#### Test: duplicate-operation-id-rejected (covers R8)

**Given**: `register_operation(OperationDef(id="x", ...))` already called once.
**When**: a second call with the same `id="x"` is made.
**Then**:
- **assertion-error**: `AssertionError` is raised.
- **original-untouched**: `get_operation("x")` still returns the first definition.

#### Test: duplicate-mcp-tool-full-name-rejected (covers R9)

**Given**: two different plugins try to register the same `{plugin, tool_id}` combination.
**When**: the second `register_mcp_tool` call happens.
**Then**:
- **assertion-error**: `AssertionError` raised mentioning the full name.

#### Test: deactivate-disposes-lifo (covers R5, R7)

**Given**: a plugin registers disposables A, B, C (in that order) into `context.subscriptions`.
**When**: `deactivate(name)` runs.
**Then**:
- **lifo-order**: observed dispose order is C, B, A.
- **all-fired**: all three dispose callbacks ran exactly once.

#### Test: deactivate-calls-plugin-hook-after-subscriptions (covers R5)

**Given**: plugin module exports `deactivate(context)` that records a timestamp.
**When**: the host's `deactivate(name)` runs.
**Then**:
- **hook-called**: plugin's `deactivate` was invoked with the same `context` object.
- **after-subscriptions**: the hook's recorded timestamp is after all subscription disposals.

#### Test: deactivate-unknown-name-noop (covers R6)

**Given**: no plugin is registered under `"ghost"`.
**When**: `PluginHost.deactivate("ghost")` is called.
**Then**:
- **no-exception**: returns normally.
- **registries-unchanged**: no state mutated.

#### Test: dispatch-rest-matches-first (covers R11)

**Given**: one POST route `^/api/projects/(?P<project>[^/]+)/plugins/foo/run$` registered to a handler.
**When**: `dispatch_rest("POST", "/api/projects/p1/plugins/foo/run", project_dir, project_name, body)` is called.
**Then**:
- **handler-called**: handler receives the path, positional args, and `path_groups={'project': 'p1'}`.
- **returns-handler-value**: `dispatch_rest` returns whatever the handler returned.

#### Test: dispatch-rest-no-match-returns-none (covers R11)

**Given**: the route registry has entries that don't match `/api/foo`.
**When**: `dispatch_rest("POST", "/api/foo")`.
**Then**:
- **returns-none**: the return value is `None`.
- **no-handler-invoked**: no registered handler was called.

#### Test: dispatch-rest-method-isolated (covers R11)

**Given**: the same regex pattern is registered ONLY under POST.
**When**: `dispatch_rest("GET", <matching path>)`.
**Then**:
- **no-match**: returns `None`; POST handler not invoked.

### Edge Cases

#### Test: malformed-manifest-does-not-abort-register (covers R2)

**Given**: `plugin.yaml` has invalid YAML syntax OR fails schema validation.
**When**: `PluginHost.register(module)` runs.
**Then**:
- **stderr-log**: a `[plugin-host] manifest load failed` line appears on stderr.
- **context-manifest-none**: `context.manifest` is `None`.
- **activate-still-called**: plugin's `activate` body executed.
- **plugin-in-registry**: `_contexts[name]` is set.

#### Test: empty-yaml-file-missing-required (covers R15, R23)

**Given**: `plugin.yaml` exists but contains only whitespace/comments (parses to `None`).
**When**: `load_manifest(module)` runs.
**Then**:
- **raises-manifest-error**: `PluginManifestError` for missing `name` (via `parse_manifest({})`).

#### Test: rest-suffix-must-start-with-slash (covers R19)

**Given**: restEndpoint with `suffix: "run"` (no leading slash).
**When**: `parse_manifest(data)`.
**Then**:
- **raises**: `PluginManifestError` explaining suffix must start with `/`.

#### Test: rest-method-case-normalized (covers R19)

**Given**: restEndpoint with `method: "post"`.
**When**: parsed.
**Then**:
- **method-uppercase**: resulting `RESTEndpointManifest.method == "POST"`.

#### Test: rest-method-invalid-rejected (covers R19)

**Given**: restEndpoint with `method: "FOO"`.
**When**: parsed.
**Then**:
- **raises**: `PluginManifestError` mentioning the invalid method and the allowed set.

#### Test: enum-setting-requires-values (covers R20)

**Given**: setting `{type: enum, default: "a"}` with no `values:` key.
**When**: parsed.
**Then**:
- **raises**: `PluginManifestError` mentioning `values`.

#### Test: setting-unknown-type-rejected (covers R20)

**Given**: setting with `type: "float"` (not in allowed set).
**When**: parsed.
**Then**:
- **raises**: `PluginManifestError` listing valid types.

#### Test: mcp-tool-input-schema-must-be-mapping (covers R18)

**Given**: mcpTool with `input_schema: []`.
**When**: parsed.
**Then**:
- **raises**: `PluginManifestError`.

#### Test: handler-getattr-raises-wrapped-as-manifest-error (covers R22)

**Given**: plugin module's attribute lookup for `foo` raises `AttributeError`.
**When**: `resolve_handler(module, "foo")`.
**Then**:
- **wrapped**: `PluginManifestError` raised with `__cause__` being the `AttributeError`.
- **message-mentions-attr**: the error message mentions `foo`.

#### Test: disposable-exception-does-not-abort-teardown (covers R7)

**Given**: subscriptions A, B, C where B's `dispose()` raises.
**When**: `deactivate(name)` runs.
**Then**:
- **c-fired**: C.dispose was called.
- **a-fired**: A.dispose was called.
- **stderr-log**: `[plugin-host] dispose failed for <name>:` line appears.
- **context-cleared**: `_contexts[name]` is not present.

#### Test: plugin-deactivate-hook-exception-swallowed (covers R5)

**Given**: the plugin module's `deactivate(context)` raises.
**When**: host `deactivate(name)` is called.
**Then**:
- **stderr-log**: `[plugin-host] plugin deactivate() failed` line appears.
- **no-reraise**: `deactivate` returns normally.

#### Test: dispatch-rest-passes-path-groups (covers R12)

**Given**: pattern `^/api/projects/(?P<project>[^/]+)/plugins/foo/runs/(?P<run_id>[^/]+)$` registered.
**When**: dispatched against `/api/projects/P/plugins/foo/runs/R1`.
**Then**:
- **handler-gets-path-groups**: handler is called with `path_groups={'project': 'P', 'run_id': 'R1'}`.

#### Test: dispatch-rest-no-path-groups-for-anonymous-regex (covers R12)

**Given**: a registered pattern with no named groups (e.g. `^/api/old$`).
**When**: dispatched against `/api/old` with positional args only.
**Then**:
- **no-path-groups-kwarg**: the handler is called WITHOUT a `path_groups` kwarg (strict-signature back-compat).

#### Test: cross-plugin-operation-id-collision-rejected (covers R8)

**Given**: plugin A has registered op id `shared`; plugin B's manifest also declares `shared`.
**When**: plugin B calls `register_declared`.
**Then**:
- **raises**: `AssertionError` propagates out of `register_operation`.
- **note**: this is NOT caught by `register_declared` (the exception handler wraps only `resolve_handler`, not registration).

#### Test: rest-endpoint-with-named-group-param (covers R14)

**Given**: manifest `suffix: /runs/(?P<run_id>[^/]+)`.
**When**: `register_declared` registers it and `dispatch_rest` matches.
**Then**:
- **both-groups-captured**: handler sees `path_groups={'project': ..., 'run_id': ...}`.

#### Test: same-path-different-method-coexist

**Given**: two plugins register identical suffix `/endpoint` but different methods (GET vs POST).
**When**: both `register_declared` runs complete.
**Then**:
- **both-live**: `_rest_routes_by_method["GET"]` and `_rest_routes_by_method["POST"]` each have the matching entry.
- **dispatch-correct**: `dispatch_rest("GET", ...)` hits the GET handler; `dispatch_rest("POST", ...)` hits the POST handler.

#### Test: same-path-same-method-second-wins

**Given**: two plugins register the identical pattern under the same method.
**When**: the second `register_declared` completes.
**Then**:
- **second-overwrites**: the registry value for that pattern is the second plugin's handler (dict `[key] = value` behavior).
- **no-error-raised**: no duplicate check for REST routes.
- **first-plugin-disposable-stale**: disposing the first plugin's REST disposable does NOT remove the route (its identity check `routes.get(pattern) is handler` fails).

#### Test: activation-events-parsed-not-enforced (covers R28)

**Given**: `activationEvents: [onStartup]` in manifest.
**When**: manifest is parsed and plugin registered.
**Then**:
- **parsed-into-manifest**: `manifest.activation_events == ["onStartup"]`.
- **no-gating**: `register` proceeds regardless of any activation event semantics (events are not interpreted by the current host).

#### Test: operation-panel-ref-stored-not-resolved

**Given**: operation entry with `panel: "frontend:foo"`.
**When**: `parse_manifest` runs.
**Then**:
- **panel-ref-preserved**: `OperationManifest.panel_ref == "frontend:foo"`.
- **no-resolution-attempted**: no exception raised for the frontend ref; `resolve_handler` is not called on `panel_ref`.

#### Test: unknown-contributes-key-ignored

**Given**: manifest has `contributes: {widgets: [...], operations: []}` where `widgets` is unknown.
**When**: parsed.
**Then**:
- **parses-without-error**: `PluginManifest` constructed successfully.
- **widgets-ignored**: no widgets appear on the manifest object (the schema has no such field).

#### Test: fe-duplicate-panel-id-throws (covers R25)

**Given**: TypeScript `PluginHost.registerPanel({id: "x", ...})` already called.
**When**: a second `registerPanel({id: "x", ...})` is called.
**Then**:
- **throws**: an `Error` with message including `duplicate panel id: x`.
- **first-still-listed**: `getPanel("x")` still returns the first registration.

#### Test: fe-context-menu-items-flattened (covers R26)

**Given**: two different plugins each register a context menu for entityType `audio_clip` with 2 items each.
**When**: `getContextMenuItems("audio_clip")`.
**Then**:
- **returns-4**: a flat list of 4 items in registration order.

#### Test: fe-async-activate-rejection-logged (covers R24)

**Given**: plugin's `activate` returns a promise that rejects with `Error("boom")`.
**When**: `PluginHost.register(plugin, "p")`.
**Then**:
- **returns-context-synchronously**: register returns a valid `PluginContext` object.
- **console-error-logged**: `console.error` is invoked with a message starting with `[plugin-host] activate(p) failed:` and the error.
- **plugin-still-registered**: `registeredCount` increased by 1.

#### Test: reset-for-tests-deactivates-all (covers R27)

**Given**: three plugins registered, each with subscriptions.
**When**: `_reset_for_tests()` runs.
**Then**:
- **all-disposed**: every subscription's `dispose` was called.
- **registries-empty**: `_operations`, `_contexts`, `_registered`, and all per-method REST route buckets are empty dicts/lists.

---

## Non-Goals

- Dynamic plugin discovery from disk (MVP imports plugins statically at startup).
- Process-level isolation, sandboxing, or capability tokens for plugins.
- Runtime enforcement of R9a (plugin ↔ raw DB boundary) via import hooks; see separate spec.
- Hot reload / Vite HMR-driven re-registration (the host tolerates it, but it is not a specified capability).
- Authorization / permission checks on REST routes (handled by `api_server.py` auth middleware upstream of `dispatch_rest`).
- Validation that `input_schema` is a valid JSON Schema — the host only checks it is a mapping.
- Versioning / semver compatibility between plugin and host.
- Ordering guarantees for `dispatch_rest` when multiple patterns could match (documented: first insertion-order match wins, but no explicit priority API).
- Multi-process or multi-threaded registration safety.

---

## Open Questions

- **OQ-1**: What happens if two threads concurrently call `PluginHost.register(A)` and `PluginHost.register(B)`? The class-level dicts are not guarded by a lock; CPython's GIL provides dict-operation atomicity but not compound-operation atomicity. Is this intended to be a single-threaded API, and should it assert that?
- **OQ-2**: If a plugin is deactivated while an inbound HTTP request is mid-dispatch to one of its REST routes, does the handler run to completion, get aborted, or see the already-cleared disposal state? Current code has no coordination.
- **OQ-3**: `resolve_handler(module, "")` walks an empty parts list and then checks `callable(module)`. Since Python modules are not callable, this raises `PluginManifestError("resolved to non-callable: module")`. Is this intentional, or should empty refs be rejected with a clearer error?
- **OQ-4**: The `register_declared` REST-endpoint error handler catches exceptions from `resolve_handler` only; exceptions raised inside `plugin_api.register_rest_endpoint` itself would propagate and abort the remaining contributions. Is that intended?
- **OQ-5**: The example `generate_foley/plugin.yaml` uses a non-canonical schema shape (`contributes.rest_endpoints` with `path` + `method`, not `suffix`) and a comment declares it "documentation-only". Is that plugin's manifest actually loaded at runtime, or does the plugin register contributions purely imperatively from `activate()`? (This affects whether the example is a valid test input.)
- **OQ-6**: `activationEvents` is parsed but never consulted. Should the host honor `onStartup` semantically, or is the field reserved for future use and currently a no-op?
- **OQ-7**: `contextMenus` is part of the parsed manifest but `register_declared` does not wire it up to `PluginHost` (only operations, mcpTools, restEndpoints are registered). Who reads `manifest.context_menus` — and when?

---

## Related Artifacts

- `agent/reports/audit-2-architectural-deep-dive.md` §1A (plugin system units catalog)
- Target list: audit §5 row 1 (`plugin-host-and-manifest`) — this spec
- Related specs to write next:
  - `plugin-api-surface-and-r9a` (separate — covers `plugin_api/__init__.py`)
  - `replicate-provider` (separate — covers typed provider facade)
  - Per-plugin specs for `generate_foley`, `light_show`, `transcribe`, `generate_music`, `isolate_vocals`
- Source: `scenecraft-engine/src/scenecraft/plugin_host.py`
- Source: `scenecraft-engine/src/scenecraft/plugin_manifest.py`
- Source: `scenecraft/src/lib/plugin-host.ts`
- Source: `scenecraft-engine/src/scenecraft/plugin_api/__init__.py` (lines 453–485: `register_rest_endpoint`)
