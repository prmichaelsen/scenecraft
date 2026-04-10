# Task 11: Package.yaml Schema & Validation

**Milestone**: M3 - Contribution Points  
**Design Reference**: [Contribution Points](../../design/local.contribution-points.md)  
**Estimated Time**: 2-3 hours  
**Dependencies**: Task 9 (backend — schema validates what discover_plugins parses)  
**Status**: Not Started  

---

## Objective

Define the formal schema for beatlab plugin `package.yaml` manifests, implement validation, and create an example plugin manifest for reference.

---

## Context

Plugins declare their capabilities in `package.yaml`. This task defines exactly what fields are valid, how they're validated, and provides a reference example that plugin authors can copy.

---

## Steps

### 1. Define schema

**`src/beatlab/plugin_schema.py`**:
- Define validation rules for each `contributes` category
- Validate `activationEvents` against known event types
- Validate `beatlab.minVersion` semver format
- Validate effect `params` types and ranges

### 2. Implement validation function

```python
def validate_plugin_manifest(manifest: dict) -> list[str]:
    """Validate a plugin package.yaml. Returns list of error messages (empty = valid)."""
    ...
```

### 3. Add CLI command

```bash
beatlab plugin validate <path-to-package.yaml>
```

- Reads the YAML file
- Runs validation
- Reports errors or "Valid plugin manifest"

### 4. Create example plugin

**`examples/example-plugin/package.yaml`**:

```yaml
name: "@example/chromatic-aberration"
version: 1.0.0
description: "Chromatic aberration effect for beatlab"
beatlab:
  minVersion: "0.4.0"

activationEvents:
  - "onEffect:example.chromatic-aberration"

contributes:
  effects:
    - id: "example.chromatic-aberration"
      label: "Chromatic Aberration"
      category: "distortion"
      params:
        - name: intensity
          type: number
          default: 0.5
          min: 0
          max: 1
      shader: "shaders/chromatic-aberration.glsl"
      render: "effects/chromatic_aberration.py"
```

### 5. Add API endpoint for validation

`POST /api/plugins/validate` — accepts manifest JSON, returns validation result. Useful for future plugin development UI.

---

## Verification

- [ ] Schema validates all 8 contribution categories
- [ ] Invalid manifests produce clear error messages
- [ ] `beatlab plugin validate` CLI command works
- [ ] Example plugin manifest passes validation
- [ ] Unknown contribution types produce warnings (not errors — forward compat)

---

**Next Task**: None (end of M3)  
**Related Design Docs**: [local.contribution-points](../../design/local.contribution-points.md)  
