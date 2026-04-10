# Contribution Points System

**Concept**: Declarative plugin extension surface for beatlab — plugins declare what they contribute in package.yaml, runtime wires them up lazily  
**Created**: 2026-04-10  
**Status**: Proposal  

---

## Overview

Beatlab's editor and render pipeline have natural extension points where third-party plugins could add functionality: custom effects, blend modes, audio analysis rules, curve evaluators, image/video generators, and UI panels. This design defines a contribution point system inspired by VSCode's architecture — plugins declare capabilities in a manifest, and beatlab loads/activates them on demand.

This is the **surface definition** phase. We define where plugins can hook in and what the manifest looks like, with placeholder methods at each boundary. The full plugin runtime (loading, sandboxing, marketplace) is out of scope.

---

## Problem Statement

- The editor has hardcoded effects (pulse, zoom, shake, glow, flash, strobe, invert), blend modes, and generator backends (Imagen, Veo, Replicate)
- Users can't add custom effects, analysis rules, or generation backends without modifying source code
- No standard way to package and share beatlab extensions

---

## Solution

### Architecture: Declarative-Then-Imperative

Following VSCode's proven pattern:

1. **Static manifest** — Plugin declares what it contributes in `package.yaml` without loading code
2. **Activation events** — Plugin declares *when* its code should load
3. **Runtime registration** — Plugin's `activate()` registers implementations via beatlab's plugin API
4. **Placeholder methods** — Each contribution point has a no-op default that plugins override

### Contribution Point Categories

#### 1. Effects (`contributes.effects`)

Custom beat-reactive or layer effects in the WebGL compositor and render pipeline.

```yaml
contributes:
  effects:
    - id: "plugin.chromatic-aberration"
      label: "Chromatic Aberration"
      category: "distortion"
      params:
        - name: intensity
          type: number
          default: 0.5
          min: 0
          max: 1
        - name: angle
          type: number
          default: 0
          min: 0
          max: 360
      shader: "shaders/chromatic-aberration.glsl"  # WebGL fragment shader
      render: "effects/chromatic_aberration.py"     # Python render function
```

**Placeholder**: `applyPluginEffect(effectId, frame, params, progress) → frame`

#### 2. Blend Modes (`contributes.blendModes`)

Custom compositor blend modes beyond the built-in set (normal, multiply, screen, overlay, etc.).

```yaml
contributes:
  blendModes:
    - id: "plugin.color-burn"
      label: "Color Burn"
      shader: "shaders/color-burn.glsl"
      render: "blends/color_burn.py"
```

**Placeholder**: `applyPluginBlendMode(modeId, base, layer) → blended`

#### 3. Generators (`contributes.generators`)

Image and video generation backends (alternative to Imagen/Veo/Replicate).

```yaml
contributes:
  generators:
    - id: "plugin.comfyui"
      label: "ComfyUI"
      type: "image"  # or "video"
      endpoint: "http://localhost:8188/api"
      config:
        - name: workflow
          type: string
          default: "default"
```

**Placeholder**: `generateImage(generatorId, prompt, sourceImage, config) → imagePath`
**Placeholder**: `generateVideo(generatorId, prompt, startImage, endImage, config) → videoPath`

#### 4. Audio Analysis Rules (`contributes.audioRules`)

Custom rules for processing audio intelligence events into effect triggers.

```yaml
contributes:
  audioRules:
    - id: "plugin.frequency-to-color"
      label: "Frequency → Color Shift"
      inputEvents: ["onset", "spectral"]
      outputEffect: "hue_shift"
      script: "rules/frequency_color.py"
```

**Placeholder**: `evaluatePluginRule(ruleId, audioEvents, timeRange) → effectEvents[]`

#### 5. Curve Evaluators (`contributes.curveEvaluators`)

Custom easing/interpolation functions for the curve system.

```yaml
contributes:
  curveEvaluators:
    - id: "plugin.spring"
      label: "Spring"
      index: 10  # easing type number (extends built-in 0-5)
```

**Placeholder**: `evaluatePluginEasing(easingId, t) → value`

#### 6. Panels (`contributes.panels`)

Custom sidebar panels in the editor UI.

```yaml
contributes:
  panels:
    - id: "plugin.color-palette"
      label: "Color Palette"
      icon: "palette"
      position: "right"  # or "left"
      component: "panels/ColorPalette.tsx"
```

**Placeholder**: `renderPluginPanel(panelId, context) → ReactNode`

#### 7. Commands (`contributes.commands`)

Custom actions accessible via keyboard shortcuts or menus.

```yaml
contributes:
  commands:
    - id: "plugin.auto-keyframe"
      label: "Auto-Generate Keyframes"
      keybinding: "ctrl+shift+k"
      when: "editorFocused"
```

**Placeholder**: `executePluginCommand(commandId, context) → void`

#### 8. Export Formats (`contributes.exportFormats`)

Custom render output formats or post-processing pipelines.

```yaml
contributes:
  exportFormats:
    - id: "plugin.prores"
      label: "ProRes 4444"
      extension: ".mov"
      codec: "prores_ks"
      script: "export/prores.py"
```

**Placeholder**: `exportWithPlugin(formatId, inputPath, outputPath, config) → void`

### Activation Events

Plugins declare when they activate:

| Event | Trigger |
|---|---|
| `onEffect:<effectId>` | When an effect of this type is applied |
| `onGenerate:<type>` | When image/video generation starts |
| `onRender` | When the render pipeline starts |
| `onEditorOpen` | When the editor loads |
| `onCommand:<commandId>` | When a command is invoked |
| `onCurveEvaluate` | When curves are being evaluated |
| `*` | Always active (discouraged) |

### Package.yaml Structure

```yaml
name: "@user/my-beatlab-plugin"
version: 1.0.0
description: "Custom effects and generators for beatlab"
beatlab:
  minVersion: "0.4.0"

activationEvents:
  - "onEffect:plugin.chromatic-aberration"
  - "onCommand:plugin.auto-keyframe"

contributes:
  effects: [...]
  blendModes: [...]
  generators: [...]
  commands: [...]
  panels: [...]
```

---

## Implementation

### Phase 1: Placeholder Methods (Current Scope)

Add no-op placeholder functions at each contribution boundary:

**Backend (`api_server.py` / `narrative.py`)**:
```python
def apply_plugin_effect(effect_id: str, frame, params: dict, progress: float):
    """Placeholder: plugin effects are not yet loaded."""
    return frame

def generate_with_plugin(generator_id: str, prompt: str, config: dict):
    """Placeholder: plugin generators are not yet loaded."""
    raise NotImplementedError(f"Plugin generator '{generator_id}' not available")

def evaluate_plugin_rule(rule_id: str, events: list, time_range: tuple):
    """Placeholder: plugin audio rules are not yet loaded."""
    return []
```

**Frontend (`TransitionPanel.tsx` / `BeatEffectPreview.tsx`)**:
```typescript
function applyPluginEffect(effectId: string, uniforms: Record<string, number>): Record<string, number> {
  // Placeholder: plugin effects not yet loaded
  return uniforms
}
```

### Phase 2: Manifest Discovery (Future)

- Scan `~/.beatlab/plugins/*/package.yaml` for installed plugins
- Parse `contributes` sections and register capabilities
- Show in Settings panel under "Plugins"

### Phase 3: Runtime Loading (Future)

- Python plugins: `importlib` dynamic import from plugin directory
- Frontend plugins: dynamic `import()` of bundled JS modules
- GLSL shaders: inject into compositor shader at compile time

---

## Benefits

- **Extensibility without forking** — users add capabilities via plugins
- **Lazy loading** — plugins only activate when needed, no startup penalty
- **Declarative discovery** — beatlab knows what's available without loading plugin code
- **Familiar pattern** — VSCode's model is well-understood by developers

---

## Trade-offs

- **Design overhead now** — defining contribution points before there are plugins risks wrong abstractions
- **Shader compilation** — custom GLSL effects require recompiling the compositor shader (mitigated by shader injection at init)
- **Security** — plugins run arbitrary code; sandboxing is a Phase 3+ concern
- **Two runtimes** — frontend (JS) and backend (Python) plugins have different loading mechanisms

---

## Dependencies

- Stable effect pipeline (current)
- Stable curve system (just completed)
- Stable render pipeline API

---

## Key Design Decisions

### Architecture

| Decision | Choice | Rationale |
|---|---|---|
| Pattern | VSCode declarative-then-imperative | Proven at scale, lazy loading, familiar to devs |
| Manifest format | package.yaml | Consistent with ACP package system |
| Initial scope | Placeholder methods only | Define the surface without building the runtime |
| Activation | Event-based lazy loading | Don't load plugin code until needed |

### Contribution Categories

| Decision | Choice | Rationale |
|---|---|---|
| Effects | Custom shaders + Python render | Both preview and final render need plugin effects |
| Generators | Pluggable backends | Users have different GPU setups, local vs cloud |
| Audio Rules | Python scripts | Audio analysis is backend-only, Python is natural |
| Panels | React components | Frontend plugins are React-based |
| Curve Evaluators | Custom easing functions | Extend the easing system without modifying core |

---

## Future Considerations

- Plugin marketplace / registry (hosted on beatlab.dev or npm-like)
- Plugin sandboxing (WASM for frontend, subprocess for backend)
- Plugin settings UI (auto-generated from `config` declarations)
- Plugin dependencies (one plugin depending on another)
- Hot-reload during development
- Plugin templates / scaffolding CLI

---

**Status**: Proposal  
**Recommendation**: Implement Phase 1 (placeholder methods) to define the extension surface. Defer Phase 2/3 until there's demand from users.  
**Related Documents**: [VSCode Contribution Points](https://code.visualstudio.com/api/references/contribution-points)  
