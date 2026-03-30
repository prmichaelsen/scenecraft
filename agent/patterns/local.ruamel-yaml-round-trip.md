# Ruamel YAML Round-Trip Editing

**Category**: Code
**Applicable To**: Python services that read/modify/write large YAML files (beatlab server, any handler that updates timeline.yaml)
**Status**: Stable

---

## Overview

When editing individual fields in a large YAML file (e.g., `timeline.yaml` with 600+ keyframes and transitions), the standard `pyyaml` approach of `safe_load` + mutate + `dump` is both slow (full parse/serialize) and destructive (reformats the entire file, loses comments and ordering). The `ruamel.yaml` library provides round-trip editing that preserves formatting, comments, and key order while allowing targeted field mutations.

---

## When to Use This Pattern

Use this pattern when:
- Updating individual fields on a single entity in a large YAML file
- The file is large enough that full parse/dump causes noticeable latency (>100ms)
- Preserving the existing file formatting matters (e.g., avoiding noisy diffs)
- The operation is a simple field update, not a structural change

Don't use this pattern when:
- Creating new files from scratch (just use `pyyaml.dump`)
- The file is small (<1000 lines) — `pyyaml` is fine
- You're doing bulk structural changes (adding/removing list items) where reformatting is acceptable
- Reading YAML without writing it back

---

## Implementation

### Dependencies

Add `ruamel.yaml>=0.18.0` to `pyproject.toml` dependencies. Install with `uv pip install ruamel.yaml`.

### Shared Helpers

Add to the server class (e.g., `api_server.py`):

```python
def _ruamel_load(self, yaml_path):
    """Load YAML with ruamel for round-trip editing."""
    from ruamel.yaml import YAML
    ryaml = YAML()
    ryaml.width = 1000
    ryaml.preserve_quotes = True
    with open(yaml_path) as f:
        return ryaml, ryaml.load(f)

def _ruamel_save(self, ryaml, parsed, yaml_path):
    """Save YAML with ruamel, preserving formatting."""
    with open(yaml_path, "w") as f:
        ryaml.dump(parsed, f)
```

### Handler Pattern

```python
def _handle_update_field(self, project_name):
    body = self._read_json_body()
    entity_id = body.get("id")
    new_value = body.get("value")

    yaml_path = self._require_yaml_path(project_name)
    if yaml_path is None:
        return

    try:
        ryaml, parsed = self._ruamel_load(yaml_path)

        # Navigate to the target entity (handles split format)
        tl_data = parsed.get("timelines", {}).get(
            parsed.get("active_timeline", "default"), parsed
        ) if "timelines" in parsed else parsed

        entity = next((e for e in tl_data["transitions"] if e.get("id") == entity_id), None)
        if not entity:
            return self._error(404, "NOT_FOUND", f"Entity {entity_id} not found")

        # Mutate only the target field
        entity["field"] = new_value

        self._ruamel_save(ryaml, parsed, yaml_path)
        self._json_response({"success": True})
    except Exception as e:
        self._error(500, "INTERNAL_ERROR", str(e))
```

### Key Points

1. **Always return the `ryaml` instance** from `_ruamel_load` — it must be the same instance that calls `dump` to preserve formatting
2. **`ryaml.width = 1000`** prevents ruamel from wrapping long strings (action prompts can be 200+ chars)
3. **`ryaml.preserve_quotes = True`** keeps existing quoting style
4. **Navigate split format** by checking for `"timelines"` key — the active timeline's data is at `parsed["timelines"][active]`, not at the top level
5. **Mutate in-place** — ruamel tracks the original positions, so modifying a field and dumping back only changes that field's bytes

---

## What NOT to Do

### Don't use regex text replacement on YAML

```python
# BAD — breaks on multiline values, special characters, edge cases
content = yaml_path.read_text()
content = re.sub(r"action: .*", f"action: '{new_value}'", content)
yaml_path.write_text(content)
```

This corrupts the file when values contain quotes, colons, newlines, or YAML special characters. It also can't distinguish between identically-named fields in different blocks.

### Don't mix pyyaml and ruamel

```python
# BAD — pyyaml.dump reformats everything ruamel preserved
ryaml, parsed = self._ruamel_load(yaml_path)
parsed["field"] = value
pyyaml.dump(parsed, f)  # destroys formatting
```

Always use the same `ryaml` instance for both load and save.

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Library | ruamel.yaml | Only Python YAML library that supports true round-trip editing |
| Scope | Field-level updates only | Structural changes (add/delete list items) can use pyyaml since they inherently change the file |
| Helper location | Server class methods | Keeps the `ryaml` instance management simple via return tuple |
| Width | 1000 | Prevents line-wrapping of long prompt strings |

---

## Related

- `api_server.py` handlers: `_handle_update_transition_action`, `_handle_update_prompt`, `_handle_update_transition_remap`
- `pyproject.toml`: `ruamel.yaml>=0.18.0` dependency
- `project.py`: `load_project` / `save_project` still use pyyaml (structural changes)

---

**Version**: 1.0.0
**Created**: 2026-03-29
**Last Updated**: 2026-03-29
