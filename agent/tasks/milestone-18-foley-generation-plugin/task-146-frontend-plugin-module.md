# Task 146: Frontend Plugin Module

**Milestone**: [M18](../../milestones/milestone-18-foley-generation-plugin.md)
**Design Reference**: [`local.foley-generation-plugin.md`](../../design/local.foley-generation-plugin.md) — "Architecture"
**Clarification**: [`clarification-12-foley-generation-plugin.md`](../../clarifications/clarification-12-foley-generation-plugin.md) — Item 11 (license manifest), Item 13 (task decomposition)
**Estimated Time**: 3 hours
**Dependencies**: task-145 (backend REST + WS)
**Status**: Not Started

---

## Objective

Scaffold the frontend `generate-foley` plugin: manifest (`plugin.yaml`), REST/WS client, activation descriptor, and registration with `PluginHost`. Panel component is in task-147.

---

## Steps

### 1. Directory layout

```
scenecraft/src/plugins/generate-foley/
├── plugin.yaml           # canonical manifest
├── index.ts              # activate(host) + panel contribution
├── client.ts             # REST helpers + WS subscription
└── types.ts              # request/response types shared with backend
```

### 2. `plugin.yaml`

```yaml
id: generate-foley
name: Foley Generator
version: 0.1.0
description: Generate foley sound effects from text prompts (t2fx) or video clips (v2fx) using MMAudio via Replicate.

license:
  plugin: MIT
  upstream_models:
    - name: MMAudio
      license: CC-BY-NC 4.0
      url: https://github.com/hkchengrex/MMAudio

providers:
  - replicate

contributes:
  panels:
    - id: foley-generations
      title: Foley
      component: FoleyGenerationsPanel
      registry: PanelRegistry
  chatTools:
    - generate_foley
  variantKinds:
    - name: foley
      color: orange   # actual hex TBD in task-149

invariants:
  - no-raw-db-access: true           # enforced at provider level (task-142)
  - survives-ws-disconnect: true     # jobs continue server-side
```

### 3. `client.ts`

```typescript
import { api } from '../../lib/plugin-api';
import type { GenerateFoleyRequest, GenerateFoleyResponse, GenerationListItem } from './types';

export const generateFoleyClient = {
  async run(request: GenerateFoleyRequest): Promise<GenerateFoleyResponse> {
    return api.post('/plugins/generate-foley/run', request);
  },

  async list(filter?: { entityType?: string; entityId?: string; limit?: number; offset?: number }) {
    const query = new URLSearchParams();
    if (filter?.entityType) query.set('entityType', filter.entityType);
    if (filter?.entityId) query.set('entityId', filter.entityId);
    if (filter?.limit) query.set('limit', String(filter.limit));
    if (filter?.offset) query.set('offset', String(filter.offset));
    return api.get<{ generations: GenerationListItem[] }>(
      `/plugins/generate-foley/generations?${query}`
    );
  },

  async retry(generationId: string): Promise<GenerateFoleyResponse> {
    return api.post(`/plugins/generate-foley/generations/${generationId}/retry`, {});
  },

  subscribeToJobEvents(jobId: string, handler: (event: JobEvent) => void): () => void {
    return api.ws.subscribe('/ws/jobs', jobId, handler);
  },
};
```

### 4. `types.ts`

```typescript
export type FoleyMode = 't2fx' | 'v2fx';

export interface GenerateFoleyRequest {
  prompt: string;
  duration_seconds?: number;
  source_candidate_id?: string;
  source_in_seconds?: number;
  source_out_seconds?: number;
  negative_prompt?: string;
  cfg_strength?: number;
  seed?: number;
  entity_type?: 'transition';
  entity_id?: string;
  count?: number;  // MVP: always 1
}

export interface GenerateFoleyResponse {
  generation_id: string;
  job_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface GenerationListItem {
  id: string;
  created_at: string;
  mode: FoleyMode;
  prompt: string | null;
  duration_seconds: number | null;
  source_candidate_id: string | null;
  source_in_seconds: number | null;
  source_out_seconds: number | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  entity_type: 'transition' | null;
  entity_id: string | null;
  error: string | null;
  tracks: GenerationTrack[];
}

export interface GenerationTrack {
  variant_index: number;
  pool_segment_id: string;
  replicate_prediction_id: string;
  duration_seconds: number | null;
}
```

### 5. `index.ts` — activation descriptor

```typescript
import type { PluginHost } from '../../lib/plugin-host';
import { FoleyGenerationsPanel } from './FoleyGenerationsPanel';

export function activate(host: PluginHost) {
  host.panelRegistry.register({
    id: 'foley-generations',
    title: 'Foley',
    component: FoleyGenerationsPanel,
  });

  // Variant kind → color is registered in task-149 (centralized color map)
}

export default {
  id: 'generate-foley',
  activate,
};
```

Note: `FoleyGenerationsPanel` doesn't exist yet; this file imports it anticipating task-147. The import stub fails gracefully (dev-time only) until task-147 lands.

### 6. Static registry update

Add `generate_foley` to the frontend `plugin-host.ts` static registry:

```typescript
import generateFoley from '../plugins/generate-foley';

const STATIC_REGISTRY = [
  isolateVocals,
  generateMusic,
  generateFoley,   // NEW
];
```

### 7. Tests

- Manifest parses and passes schema validation
- `generateFoleyClient.run` sends the correct request body
- `generateFoleyClient.list` builds the correct query string with and without filters
- `generateFoleyClient.retry` hits the correct endpoint
- WS subscription fires handler on mock job events
- Plugin registers on host activation

---

## Verification

- [ ] All four files (`plugin.yaml`, `client.ts`, `types.ts`, `index.ts`) created
- [ ] `plugin.yaml` validates against the plugin manifest schema (if one exists; else matches M16 style)
- [ ] `client.ts` covers all three REST endpoints + WS subscription
- [ ] `types.ts` mirrors backend request/response shape exactly
- [ ] `index.ts` registers the panel with `PanelRegistry`
- [ ] Frontend static registry in `plugin-host.ts` updated
- [ ] No runtime errors on frontend startup (panel component stub import is handled)

---

## Expected Output

```
scenecraft/src/plugins/generate-foley/
├── plugin.yaml
├── index.ts
├── client.ts
└── types.ts

scenecraft/src/lib/plugin-host.ts         (modified)

scenecraft/tests/plugins/generate-foley/
└── test_client.spec.ts                   (new)
```

---

## Notes

- Install vitest if this is the first frontend test — project currently has no frontend test setup (per session memory). Don't ask; install when needed.
- Keep `types.ts` as the single source of truth for the request/response contract. Backend Python types must match.

---

**Next Task**: [task-147](task-147-foley-generations-panel.md) — FoleyGenerationsPanel
