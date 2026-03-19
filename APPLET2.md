# Applet Tool — Visualization Instruments & Prompt Architecture

## Library Delivery

APPLET.md assumed "no network" in sandboxed iframes — this is incorrect. `sandbox="allow-scripts"` blocks same-origin access (parent DOM, cookies, storage) but does NOT block network requests. Scripts inside CAN load external resources.

However, depending on CDNs adds latency and requires internet. **Serve libraries as local static files** from Express (`/lib/chart.min.js`, `/lib/d3.min.js`, etc.). Offline-friendly, fast, controlled versions. Fits the local-llama philosophy.

## Tier Assessment

The real constraint isn't the iframe — it's whether a local llama model can reliably generate correct code for each library.

### Phase 1 — High confidence, build first

| Type | Why it works |
|---|---|
| **SVG** | Declarative markup, no library needed, LLMs are good at this. Static diagrams, flowcharts, architecture diagrams, mind maps, infographics, network/graph diagrams, geometric art. |
| **Plain HTML/CSS/JS** | The baseline — interactive explainers, animations, games, quizzes, slide layouts, timers/countdowns, tables, calculators, simulators, kanban boards, timelines, forms. |
| **Chart.js** | Config-driven JSON object, not imperative code. LLM fills a `{ type, data, options }` config. Bar, line, pie/donut, radar, scatter, bubble, area, mixed charts. Most bang for buck. |

### Phase 2 — Feasible with good prompting, add after Phase 1 is solid

| Type | Caveat |
|---|---|
| **D3.js** (constrained subset) | Simple bindings work: force-directed graphs, tree/hierarchy diagrams, Sankey, basic geo. Dangerous API surface — multiple incompatible major versions (v4/v5/v7). Must pin to one version with explicit examples. Skip choropleth maps (need GeoJSON data, too heavy). |
| **Math.js** | Formula evaluation is straightforward. Visualization is just Chart.js/SVG with computed data. Formula visualizers, equation solvers with visual output. |
| **WebGL/GLSL** (fragment shader only) | Zero library dependency — browser-native API. Template-driven: fixed ~50-line boilerplate handles WebGL setup (canvas, shader compile, fullscreen quad, render loop, `u_time`/`u_resolution` uniforms), LLM only writes the fragment shader body. GLSL is declarative and compact — LLMs handle it well. Produces generative art, animated gradients, fractals, noise-based effects, raymarching, procedural textures, interactive math/physics demos. Caveat: typos in GLSL = silent black canvas (no helpful errors), so keep scope to fragment shaders — skip complex vertex/geometry work (that's Three.js Phase 3 territory). |

### Phase 3 — Experimental, opt-in, expect lower success rates

| Type | Challenge |
|---|---|
| **Three.js** | Complex imperative API (camera, lighting, materials, renderer). Even frontier models produce broken Three.js regularly. 3D scenes, data visualizations, particle systems, geometric animations. |
| **Tone.js** | Niche library, poorly represented in training data. Audio synthesis API is stateful and timing-sensitive. Interactive synthesizers, music sequencers. |

### React + ecosystem — Not as applets

React + Tailwind + Recharts + shadcn/ui requires JSX compilation (Babel standalone), Tailwind build/CDN runtime, and shadcn components inlined. It's an entire dev environment in an iframe. The token cost is enormous and local models will constantly produce broken output.

Every use case listed under React (dashboards, data tables, forms, kanban, timelines, calculators, simulators) can be done in plain HTML/CSS/JS. If you want rich dashboards, build them as actual app features, not LLM-generated iframes.

## Prompt Architecture

Don't put all libraries in one mega-prompt. That bloats the system prompt by 2-3K+ tokens and confuses the model.

### 1. Base applet prompt (always present, small)
- Dark theme palette (`bg: #1a1a2e`, `text: #e0e0e0`, `accent: #4a9eff`, etc.)
- Sizing rules, `<applet type="...">` tag with type hint so frontend knows what to load
- Data-as-const pattern, general quality rules (inline everything, error handling, responsive)

### 2. Per-type prompt snippets (injected only when relevant)
- LLM picks the applet type or user specifies it
- Backend injects the relevant library prompt + a working example
- Keeps context lean — only one library's guidance at a time

### 3. Template/example driven, not description driven
- For Chart.js: include a complete working 30-line example, not API docs
- For SVG: include a complete flowchart example with the color palette
- LLMs copy patterns far more reliably than they follow abstract instructions
- Each template should be a working applet the model can modify

## Context Concerns

- Applet HTML can be 2-4K tokens — strip from conversation history on subsequent rounds (replace with summary like `[Applet: AMD options table, 3 expirations]`)
- Applet prompt + library example + tool data + conversation history can eat 8-10K tokens
- Per-type injection avoids paying the cost for all libraries at once
- 50KB size cap on generated applet HTML
