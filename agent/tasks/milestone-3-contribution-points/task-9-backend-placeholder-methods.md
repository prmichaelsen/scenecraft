# Task 9: Backend Placeholder Methods

**Milestone**: M3 - Contribution Points  
**Design Reference**: [Contribution Points](../../design/local.contribution-points.md)  
**Estimated Time**: 4-6 hours  
**Dependencies**: None  
**Status**: Not Started  

---

## Objective

Create a `plugins.py` module with placeholder functions at every natural plugin boundary in the backend, and wire them into the render pipeline and API server so the extension surface is clearly defined.

---

## Context

The beatlab backend has hardcoded effects, blend modes, generators (Imagen/Veo/Replicate), and audio analysis rules. This task places no-op placeholder functions at each boundary so future plugin loading can slot in without restructuring the codebase.

---

## Steps

### 1. Create `src/beatlab/plugins.py`

New module with placeholder functions:

```python
def apply_plugin_effect(effect_id: str, frame, params: dict, progress: float):
    """Plugin effect placeholder. Returns frame unmodified."""
    return frame

def apply_plugin_blend(mode_id: str, base, layer):
    """Plugin blend mode placeholder. Returns base unmodified."""
    return base

def generate_image_with_plugin(generator_id: str, prompt: str, source_image: str | None, output_path: str, config: dict) -> str:
    """Plugin image generator placeholder."""
    raise NotImplementedError(f"Plugin generator '{generator_id}' not available")

def generate_video_with_plugin(generator_id: str, prompt: str, start_image: str, end_image: str, output_path: str, config: dict) -> str:
    """Plugin video generator placeholder."""
    raise NotImplementedError(f"Plugin generator '{generator_id}' not available")

def evaluate_plugin_rule(rule_id: str, events: list, time_range: tuple) -> list:
    """Plugin audio rule placeholder. Returns empty list."""
    return []

def evaluate_plugin_easing(easing_id: int, t: float) -> float:
    """Plugin easing placeholder. Returns linear (t)."""
    return t

def export_with_plugin(format_id: str, input_path: str, output_path: str, config: dict):
    """Plugin export format placeholder."""
    raise NotImplementedError(f"Plugin export format '{format_id}' not available")

def discover_plugins(plugin_dir: str = "~/.beatlab/plugins") -> list[dict]:
    """Scan plugin directory for package.yaml manifests. Returns metadata only, no code loading."""
    ...

def get_plugin_effects() -> list[dict]:
    """Return all discovered plugin effect definitions."""
    return []

def get_plugin_blend_modes() -> list[dict]:
    """Return all discovered plugin blend mode definitions."""
    return []

def get_plugin_generators() -> list[dict]:
    """Return all discovered plugin generator definitions."""
    return []
```

### 2. Wire into render pipeline

**`src/beatlab/render/narrative.py`**:
- In `_apply_color_grading` or effect application: after built-in effects, call `apply_plugin_effect` for any unrecognized effect type
- In blend mode application: after built-in modes, call `apply_plugin_blend` for unrecognized modes
- In `_apply_transform`: after built-in transform, call plugin transform if registered

### 3. Wire into API server

**`src/beatlab/api_server.py`**:
- In generate-keyframe-candidates handler: check `image_model` against plugin generators before falling through to Imagen/Replicate
- Add `GET /api/plugins` endpoint returning discovered plugin metadata
- Add plugin effects/blend modes to the editor data response so frontend knows what's available

### 4. Wire into easing evaluation

**`src/beatlab/render/narrative.py`** `_evaluate_curve`:
- If easing type > built-in range (currently 0-5), call `evaluate_plugin_easing`

### 5. Plugin manifest discovery

Implement `discover_plugins()`:
- Scan `~/.beatlab/plugins/*/package.yaml`
- Parse YAML, extract `contributes` sections
- Log discovered plugins at startup
- Store in module-level registry (no code loading)

---

## Verification

- [ ] `plugins.py` module exists with all placeholder functions
- [ ] Render pipeline calls plugin placeholders for unrecognized effect/blend types
- [ ] API server checks plugin generators before built-in generators
- [ ] `GET /api/plugins` returns empty list (no plugins installed)
- [ ] Easing evaluation falls through to plugin for types > 5
- [ ] `discover_plugins()` scans directory and returns parsed manifests
- [ ] All existing functionality unchanged (placeholders are no-ops)

---

## Notes

- No plugin code is loaded or executed — these are purely placeholder call sites
- The plugin directory `~/.beatlab/plugins/` may not exist; handle gracefully
- All placeholders must be no-ops that don't break existing functionality

---

**Next Task**: [task-10-frontend-placeholder-methods](task-10-frontend-placeholder-methods.md)  
**Related Design Docs**: [local.contribution-points](../../design/local.contribution-points.md)  
