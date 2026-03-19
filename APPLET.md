# Applet Tool — Interactive HTML Applets in Chat

## Concept

The LLM generates self-contained HTML documents rendered in sandboxed iframes within assistant chat bubbles. Data is fetched via normal tool rounds first, then baked into the applet as a JS literal. Libraries (Chart.js) are served as local static files from Express — no CDN dependency.

## Visualization Types (Phase 1)

Three categories, covering the majority of visualization needs:

**SVG** — Declarative markup, no library needed. LLMs generate reliable SVG.
- Flowcharts, architecture diagrams, mind maps
- Infographics, network/graph diagrams
- Illustrations, icons, geometric art and generative patterns

**Chart.js** — Config-driven `{ type, data, options }` object. LLM fills a template.
- Bar charts (vertical, horizontal, stacked), line charts, area charts
- Pie / donut charts, radar / spider charts
- Scatter plots, bubble charts, mixed chart types

**Plain HTML/CSS/JS** — The baseline for everything interactive.
- Interactive explainers, animations, games, quizzes
- Data tables with sorting/filtering, slide-like layouts
- Calculators, converters, simulators
- Kanban boards, timelines, forms
- Timers, countdowns

## Applet Toggle

A checkbox next to the input prompt text box: **"Applets"** (or a small icon toggle).

- **Checked (default)**: applet system prompt snippets are included, LLM generates `<applet>` blocks, frontend renders iframes
- **Unchecked**: applet prompt snippets are omitted from system prompt, LLM produces regular text/markdown output instead
- State sent with each message request as `applets: true|false` in the POST body
- Backend conditionally includes/excludes applet prompt sections based on this flag
- Frontend stores toggle state in `state.appletsEnabled` (persists across conversations via localStorage)
- When disabled mid-conversation, LLM naturally stops producing applet tags since the prompt guidance is absent

This gives users a quick escape hatch when they want plain text answers — no applet rendering, no iframe overhead, just regular markdown output.

## Flow

1. User requests a visualization (e.g., "chart my portfolio allocation" or "draw a flowchart of the auth flow")
2. If applet toggle is off, LLM responds with text/markdown (tables, code blocks, descriptions) — no `<applet>` tags
3. LLM calls normal tools over 1-N rounds to gather data if needed
4. LLM emits final response with HTML between `<applet>` tags, including a `type` attribute
5. Frontend detects `<applet type="...">` block, renders in sandboxed iframe
6. For Chart.js applets, frontend ensures the library is available via local static path

## Library Delivery

`sandbox="allow-scripts"` does NOT block network requests — it blocks same-origin access (parent DOM, cookies, storage). Scripts inside CAN load resources.

However, depending on CDNs adds latency and requires internet. **Serve Chart.js as a local static file** from Express at `/lib/chart.min.js`. Offline-friendly, fast, controlled version. Fits the local-llama-server philosophy.

```
src/public/lib/
  chart.min.js             # Chart.js (bundled, ~200KB)
```

SVG and plain HTML/CSS/JS applets need no external libraries.

## Backend

Minimal — the "tool" is primarily a prompt pattern, not an executor:

- System prompt instructs LLM: "When generating a visualization, output HTML between `<applet type='svg|chartjs|html'>` tags."
- No tool executor needed — the applet HTML is part of the final response content, not a tool call
- Backend detects `<applet>` in final content for context management (stripping on subsequent rounds)

## Frontend Rendering

In `appendMessage` (app.js), detect `<applet type="...">...</applet>` in assistant content:

1. Extract the HTML and type attribute
2. For `type="chartjs"`: inject `<script src="/lib/chart.min.js"></script>` into the `<head>` if not already present
3. Create iframe with `srcdoc = processedHtml`
4. `iframe.sandbox = "allow-scripts"` — JS runs, fully isolated from parent
5. Default size: 100% width, 500px height
6. postMessage protocol for applet to request resize: `parent.postMessage({ type: 'resize', height: N }, '*')`
7. Parent listens for resize messages and adjusts iframe height (with a max cap)

### Fallback

- If iframe renders blank or JS errors, show raw HTML in a collapsible code block
- Validate basic structure before rendering: must contain `<script>`, `<svg>`, or `<canvas>`

## Prompt Architecture

### Base applet prompt (always in system prompt, ~200 tokens)

Covers rules that apply to all applet types:

```
When the user requests a visualization, chart, diagram, or interactive widget:
- Output a complete HTML document between <applet type="TYPE"> and </applet> tags
- TYPE must be one of: svg, chartjs, html
- The HTML must be self-contained — all CSS inline in <style>, all JS inline in <script>
- Data goes in a const at the top of <script> — separate data from rendering logic
- Dark theme: background #1a1a2e, text #e0e0e0, accent #4a9eff, secondary #7c3aed, success #10b981, warning #f59e0b, error #ef4444, surface #16213e, border #2a2a4a
- Responsive: use percentage widths, min/max constraints
- Max 50KB total HTML size
- For resize: window.parent.postMessage({ type: 'resize', height: document.body.scrollHeight }, '*')
```

### Per-type prompt snippets (injected when relevant)

Only one snippet injected at a time, triggered by user request or LLM's tool-type selection.

**SVG snippet (~150 tokens):**
```
For type="svg" applets:
- Use inline SVG directly in the HTML body
- Use viewBox for scaling, no fixed pixel dimensions on the SVG element
- Text: fill="#e0e0e0", font-family: system-ui
- Lines/borders: stroke="#2a2a4a"
- Shapes: fill with the accent palette above
- For flowcharts: use rounded rects, arrows with markers, labels centered in shapes
```

**Chart.js snippet (~200 tokens + example):**
```
For type="chartjs" applets:
- Chart.js is available at /lib/chart.min.js — include via <script src="/lib/chart.min.js"></script>
- Create a <canvas id="chart"></canvas> in the body
- Instantiate with: new Chart(document.getElementById('chart'), config)
- Use dark theme defaults: grid color '#2a2a4a', tick color '#e0e0e0'
- Plugin.legend.labels.color = '#e0e0e0'

Example — complete working applet:
<applet type="chartjs">
<!DOCTYPE html>
<html><head>
<script src="/lib/chart.min.js"></script>
<style>body { margin: 0; padding: 16px; background: #1a1a2e; }</style>
</head><body>
<canvas id="chart"></canvas>
<script>
const DATA = [
  { label: 'AAPL', value: 42 },
  { label: 'MSFT', value: 31 },
  { label: 'GOOGL', value: 27 }
];
new Chart(document.getElementById('chart'), {
  type: 'bar',
  data: {
    labels: DATA.map(d => d.label),
    datasets: [{ label: 'Allocation %', data: DATA.map(d => d.value),
      backgroundColor: '#4a9eff', borderColor: '#4a9eff', borderWidth: 1 }]
  },
  options: {
    responsive: true,
    scales: { y: { ticks: { color: '#e0e0e0' }, grid: { color: '#2a2a4a' } },
              x: { ticks: { color: '#e0e0e0' }, grid: { color: '#2a2a4a' } } },
    plugins: { legend: { labels: { color: '#e0e0e0' } } }
  }
});
</script>
</body></html>
</applet>
```

**HTML snippet (~100 tokens):**
```
For type="html" applets:
- Pure HTML/CSS/JS, no external libraries
- Use CSS grid or flexbox for layouts
- For tables: sticky headers, alternating row colors (#16213e / #1a1a2e), hover highlight #2a2a4a
- For interactive controls: style inputs/selects/buttons with the dark palette
- Canvas API is available for custom drawing and animation
```

## Context Management

- Applet HTML can be 2-4K tokens — must be stripped from conversation history on subsequent rounds
- Replace `<applet>...</applet>` block with: `[Applet: brief description of what was rendered]`
- Same stripping pattern as image base64 data already handled in conversations.js
- Keep applet summary in history so LLM knows what it already generated

## Security

- `sandbox="allow-scripts"` without `allow-same-origin` = scripts run but are fully isolated
- No access to parent DOM, cookies, localStorage, or session data
- No API keys or credentials accessible
- Size cap: 50KB max to prevent bloated output
- postMessage resize is the ONLY parent communication channel

## Example Use Cases

**"Chart my portfolio allocation as a pie chart"**
→ LLM calls `etrade_account` (portfolio) → gets positions → emits Chart.js pie applet with holdings as data

**"Draw a flowchart of how tool calling works in this app"**
→ No data tools needed → LLM emits SVG applet with boxes and arrows

**"Build me an options table for AMD, filterable by expiration"**
→ LLM calls `etrade_account` (optionchains) for multiple expirations → emits HTML applet with dropdown + table, all data inline

**"Show a scatter plot of price vs volume for my watchlist"**
→ LLM calls `etrade_account` (quote) for each symbol → emits Chart.js scatter applet

## Future Phases (see APPLET2.md)

- **Phase 2**: D3.js (constrained subset: force graphs, trees, Sankey), Math.js (formula visualization), WebGL/GLSL (template-driven fragment shaders: generative art, fractals, procedural textures, animated effects)
- **Phase 3**: Three.js (3D scenes, experimental), Tone.js (audio synthesis, experimental)
- Rich dashboards should be built as actual app features, not LLM-generated applets
