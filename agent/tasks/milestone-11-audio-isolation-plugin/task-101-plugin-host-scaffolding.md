# Task 101: Plugin Host Scaffolding

**Milestone**: [M11 - Audio Isolation Plugin](../../milestones/milestone-11-audio-isolation-plugin.md)
**Design Reference**: [local.audio-isolation-plugin.md](../../design/local.audio-isolation-plugin.md)
**Estimated Time**: 4 hours
**Dependencies**: None (greenfield — plugin consumers come in later tasks)
**Status**: Not Started

---

## Objective

Create the minimal scaffolding both repos need to host plugins: a narrow `plugin-api` host-surface module and a static `PluginHost` registry. No dynamic loading, no sandboxing. One statically-imported plugin works through the same shape a future dynamic loader will use.

Implements in `scenecraft-engine/src/scenecraft/plugin_api.py` + `plugin_host.py` (backend) and `scenecraft/src/lib/plugin-api.ts` + `lib/plugin-host.ts` (frontend).

---

## Steps

### 1. Backend: `plugin_api.py`

Create `scenecraft-engine/src/scenecraft/plugin_api.py`. This is the **entire** surface plugins are allowed to call into — keep it narrow intentionally.

```python
"""Narrow host API surface for scenecraft plugins.

Plugins MUST import from this module rather than scenecraft internals. When the
dynamic plugin loader lands, this surface becomes the stable public API.
"""

# DB helpers the plugin needs
from scenecraft.db import (
    get_audio_clip,
    add_pool_segment,
    get_pool_segment,
    add_audio_candidate,
    assign_audio_candidate,
    get_audio_clip_effective_path,
    undo_begin,
)

# Job infrastructure
from scenecraft.ws_server import job_manager

# Types (if we add a Plugin Protocol later, export here)

# Helpers specific to plugin needs
from pathlib import Path
import subprocess


def extract_audio_as_wav(source_path: Path, out_path: Path, sample_rate: int = 48000) -> Path:
    """Transcode any ffmpeg-readable audio/video to PCM WAV at a given sample rate.
    Used by plugins that need a standardized input format."""
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(source_path), "-ac", "1", "-ar", str(sample_rate), str(out_path)],
        capture_output=True, check=True, timeout=60,
    )
    return out_path


def register_rest_endpoint(path_regex: str, handler) -> None:
    """Route a POST handler on the shared scenecraft REST server.
    For MVP, this populates a dict that api_server.py consults during request
    dispatch — see plugin_host.py."""
    from scenecraft.plugin_host import PluginHost
    PluginHost._rest_routes[path_regex] = handler
```

**What's NOT in the surface (by design):**
- `scenecraft.db` directly — plugins go through the named re-exports only
- Route-layer internals of `api_server.py` — plugins don't touch the HTTP handler class directly
- Session/auth internals — future work; plugins run in the same auth context for MVP

### 2. Backend: `plugin_host.py`

```python
"""Static plugin registry. Collects operations, context-menu contributions,
and REST routes from registered plugin modules. Not a dynamic loader — for MVP
the list of plugins is hardcoded at startup."""

from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class OperationDef:
    id: str
    label: str
    entity_types: list[str]
    handler: Callable[[str, str, dict], dict]   # (entity_type, entity_id, context) -> result


class PluginHost:
    _operations: dict[str, OperationDef] = {}
    _rest_routes: dict[str, Callable] = {}
    _registered: list[str] = []

    @classmethod
    def register(cls, plugin_module) -> None:
        """Call plugin_module.activate(plugin_api) — the plugin registers its own
        contributions via register_operation / register_rest_endpoint."""
        from scenecraft import plugin_api
        plugin_module.activate(plugin_api)
        cls._registered.append(getattr(plugin_module, "__name__", "<unknown>"))

    @classmethod
    def register_operation(cls, op: OperationDef) -> None:
        assert op.id not in cls._operations, f"duplicate operation id: {op.id}"
        cls._operations[op.id] = op

    @classmethod
    def get_operation(cls, op_id: str) -> OperationDef | None:
        return cls._operations.get(op_id)

    @classmethod
    def list_operations(cls, entity_type: str | None = None) -> list[OperationDef]:
        if entity_type is None:
            return list(cls._operations.values())
        return [op for op in cls._operations.values() if entity_type in op.entity_types]

    @classmethod
    def dispatch_rest(cls, path: str, *args, **kwargs):
        """Used by api_server.py to route plugin-registered paths."""
        import re
        for pattern, handler in cls._rest_routes.items():
            if re.match(pattern, path):
                return handler(path, *args, **kwargs)
        return None
```

### 3. Backend: Wire into api_server.py

At startup (in `run_server` or `make_handler`), register the isolate-vocals plugin:

```python
from scenecraft.plugin_host import PluginHost
from scenecraft.plugins import isolate_vocals

PluginHost.register(isolate_vocals)
```

Also add plugin route dispatch to the request handler: after the built-in route matches fail for POST, consult `PluginHost.dispatch_rest(path, ...)`.

**For task 101**: add the scaffolding and a stub import of a non-existent `scenecraft.plugins.isolate_vocals` that is **commented out** — it'll be uncommented in task 102 when the plugin exists. Test that `PluginHost` works with an empty registry.

### 4. Frontend: `lib/plugin-api.ts`

```typescript
/**
 * Narrow host API surface for scenecraft plugins.
 * Plugins MUST import from this module rather than app internals. When the
 * dynamic plugin loader lands, this becomes the stable public API.
 */

export { fetchChatHistory } from './chat-client'  // example: stable REST helper
export { ChatWebSocket } from './chat-client'     // example: stable WS helper

// Type re-exports for plugin descriptors
export type { PluginModule, ContextMenuDescriptor, OperationDescriptor } from './plugin-host'

// Dialog host — plugins call showDialog() to render their confirm UI
import type { ComponentType } from 'react'
let dialogHostRef: { show: (Component: ComponentType<any>, props: any) => Promise<any> } | null = null

export function _registerDialogHost(host: typeof dialogHostRef) { dialogHostRef = host }
export function showDialog<T>(Component: ComponentType<any>, props: any): Promise<T | null> {
  if (!dialogHostRef) throw new Error('dialog host not registered yet')
  return dialogHostRef.show(Component, props)
}

// Toast — minimal surface
export function toast(msg: string, level: 'info' | 'error' | 'success' = 'info') {
  // For MVP: console.log + delegate to existing toast lib if one exists
  console.log(`[${level}] ${msg}`)
}
```

### 5. Frontend: `lib/plugin-host.ts`

```typescript
import type { ComponentType } from 'react'

export type OperationDescriptor = {
  id: string
  label: string
  entityTypes: string[]
  dialog?: ComponentType<any>
}

export type ContextMenuDescriptor = {
  entityType: string
  items: Array<{ operation: string; label: string; icon?: string }>
}

export type PluginModule = {
  activate: (host: typeof PluginHost) => void
}

class PluginHostImpl {
  private operations = new Map<string, OperationDescriptor>()
  private contextMenus: ContextMenuDescriptor[] = []
  private registered: string[] = []

  register(plugin: PluginModule, name = '<unknown>') {
    plugin.activate(this)
    this.registered.push(name)
  }

  registerOperation(op: OperationDescriptor) {
    if (this.operations.has(op.id)) throw new Error(`duplicate operation id: ${op.id}`)
    this.operations.set(op.id, op)
  }

  registerContextMenu(menu: ContextMenuDescriptor) {
    this.contextMenus.push(menu)
  }

  getOperation(id: string) { return this.operations.get(id) }
  getContextMenuItems(entityType: string) {
    return this.contextMenus
      .filter(m => m.entityType === entityType)
      .flatMap(m => m.items)
  }
}

export const PluginHost = new PluginHostImpl()
```

### 6. Frontend: Wire into editor entry

Find the editor entry point (likely `src/routes/project/$name/editor.tsx` or the root editor shell). Add:

```typescript
import { PluginHost } from '@/lib/plugin-host'
// import * as isolateVocals from '@/plugins/isolate-vocals'  // uncommented in task 103

// PluginHost.register(isolateVocals, 'isolate-vocals')
```

For task 101: add the `PluginHost` import + a console.log of `PluginHost.operations.size` to verify the host exists. Plugin import/register stays commented until task 103.

### 7. Tests

**Backend** `tests/test_plugin_host.py`:
- `PluginHost.register_operation` / `get_operation` round-trip
- Duplicate operation id → AssertionError
- `list_operations(entity_type)` filters correctly
- `dispatch_rest` matches paths and invokes handlers

**Frontend** `src/lib/__tests__/plugin-host.test.ts`:
- `PluginHost.register(module)` calls `module.activate(host)`
- `registerOperation` / `getOperation` round-trip
- `getContextMenuItems('audio_clip')` flattens across multiple menu descriptors

---

## Verification

- [ ] `scenecraft-engine/src/scenecraft/plugin_api.py` exists with the narrow surface
- [ ] `scenecraft-engine/src/scenecraft/plugin_host.py` exists with `PluginHost` class
- [ ] `scenecraft/src/lib/plugin-api.ts` exists with re-exports + showDialog + toast stubs
- [ ] `scenecraft/src/lib/plugin-host.ts` exists with `PluginHost` singleton
- [ ] Startup wiring in `api_server.py` references `PluginHost` (plugin import commented out until task 102)
- [ ] Editor entry imports `PluginHost` (plugin import commented out until task 103)
- [ ] `tests/test_plugin_host.py` passes
- [ ] Frontend `plugin-host.test.ts` passes
- [ ] No dynamic loading / filesystem scanning / sandboxing code — this is deliberate for MVP
