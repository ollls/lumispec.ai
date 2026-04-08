## How the three libraries work together

```
URL
 │
 ▼
fetch(url) → raw HTML string (full page: nav, ads, article, footer, scripts...)
 │
 ▼
linkedom (parseHTML)
 │  Parses the HTML string into a DOM document object.
 │  This is needed because Readability expects a DOM, not a string.
 │  linkedom is a lightweight DOM implementation (~5KB vs jsdom's ~50MB).
 │
 ▼
document object
 │
 ▼
Readability(document).parse()
 │  Runs Firefox's Reader View algorithm on the DOM.
 │  Scores every node by text density, link density, paragraph length, etc.
 │  Identifies the "main content" area and strips everything else:
 │    ✗ navigation bars
 │    ✗ sidebars, ads
 │    ✗ footers, cookie banners
 │    ✗ scripts, styles
 │    ✓ article body (kept)
 │
 │  Returns: { title, content (cleaned HTML), textContent (plain text), byline }
 │  Or returns null if the page doesn't look like an article.
 │
 ▼
article.content = "<div><h2>Introduction</h2><p>Node.js 22 was released...</p><ul><li>...</li></ul></div>"
 │
 │  This is clean HTML — but still HTML. Sending raw HTML to an LLM
 │  wastes tokens on tags (<div>, <p>, <span>) and the LLM has to
 │  parse structure from markup. Plain textContent loses all structure.
 │  Markdown is the sweet spot.
 │
 ▼
Turndown(article.content)
 │  Converts HTML → Markdown:
 │    <h2>Introduction</h2>       →  ## Introduction
 │    <p>text</p>                 →  text
 │    <a href="...">link</a>      →  [link](...)
 │    <ul><li>item</li></ul>      →  - item
 │    <pre><code>...</code></pre> →  ```...```
 │
 ▼
"## Introduction\n\nNode.js 22 was released...\n\n- Feature 1\n- Feature 2"
```

### The fallback path (non-article pages)

When Readability returns `null` — docs, forums, search results, dashboards — we skip it and feed the raw HTML to Turndown directly, after manually stripping `script`, `style`, `nav`, `header`, `footer`, `aside` elements via linkedom's DOM API. Less precise than Readability but still produces usable markdown.

### Why each piece is necessary

| Library | Role | Without it |
|---|---|---|
| **linkedom** | HTML string → DOM object | Readability can't run (needs a DOM) |
| **Readability** | DOM → clean article HTML | You get the whole page including junk |
| **Turndown** | HTML → Markdown | You either waste tokens on HTML tags or lose all structure with plain text |
