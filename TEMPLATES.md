# Applet Template System

## Overview
Allows users to save LLM-generated applet visualizations as reusable templates. When referenced in future prompts, the saved HTML layout is injected as context so the LLM reproduces the exact same design with fresh data.

## UX Flow

1. **Save**: Every rendered applet has a "Save as template" button below it. Click → enter name → saved to template library.
2. **Browse**: Green "Templates" button in the header bar (next to "Prompts"). Click → dropdown lists saved templates.
3. **Insert**: Click a template → `[template: name]` tag inserted at cursor position in the prompt textarea.
4. **Use**: Write your prompt around the tag, e.g. *"Fetch AMD full chains for all expiry dates. [template: option_chain_dashboard]"*
5. **Backend expansion**: Before sending to the LLM, `[template: X]` tags are replaced with the full HTML template + instructions to preserve the layout.

## Architecture

### Data Model (`data/templates.json`)
```json
{
  "id": "uuid",
  "name": "option_chain_dashboard",
  "type": "html",           // "svg", "chartjs", or "html"
  "html": "<!DOCTYPE html>...",  // full applet HTML source
  "createdAt": "2026-03-20T..."
}
```

### Files

| File | Role |
|---|---|
| `src/services/templates.js` | Persistence layer — CRUD operations on `data/templates.json` |
| `src/routes/templates.js` | REST API routes |
| `src/server.js` | Route registration (`/api/templates`) |
| `src/public/js/app.js` | Save button on applets, Templates dropdown, tag insertion |
| `src/views/index.html` | Templates button + dropdown HTML |
| `src/routes/conversations.js` | `[template: X]` tag expansion before LLM call |
| `src/services/tools.js` | System prompt TEMPLATES rule |

### API Routes

| Route | Method | Description |
|---|---|---|
| `/api/templates` | GET | List templates (id, name, type, createdAt — no html) |
| `/api/templates` | POST | Create template `{ name, type, html }` |
| `/api/templates/:id` | GET | Get single template with full html |
| `/api/templates/:id` | DELETE | Delete template |

### Service Functions (`src/services/templates.js`)
- `listTemplates()` — returns all templates (html omitted for list performance)
- `createTemplate(name, type, html)` — saves new template, returns metadata
- `deleteTemplate(id)` — removes by id
- `getTemplate(id)` — returns full template including html
- `getTemplateByName(name)` — case-insensitive name lookup (used by tag expansion)

### Template Tag Expansion (`src/routes/conversations.js`)
When a user message contains `[template: some name]`, the backend:
1. Looks up the template by name (case-insensitive)
2. Replaces the tag with the full HTML in a code block
3. Prepends instructions: *"Use this saved HTML applet template — output it as an `<applet>` block with ONLY the data filenames/configuration updated. Do NOT redesign the layout, styling, or structure."*

### System Prompt Rule (`src/services/tools.js`)
The applet section includes a TEMPLATES rule instructing the LLM to:
- Use the template HTML as-is
- Only modify data file references and configuration
- Never change layout, CSS, column structure, or visual design

## Frontend Details

### Save Button
Added in `createAppletIframe()` — appended to the applet wrapper div. Shows "Save as template" → "Saving…" → "Saved ✓". The `applet.html` (original source before iframe injection scripts) is what gets saved.

### Templates Dropdown
- Button: emerald-400 colored "Templates" text in the header bar
- Dropdown: lists templates by name with type badge and delete button
- Click template → inserts `[template: name]` at cursor position in textarea
- Closes other dropdowns (Prompts, Tools) when opened

## Design Decisions
- Templates store the raw applet HTML, not the iframe-injected version (no resize scripts, no Chart.js injection)
- Tag expansion happens server-side so the user sees `[template: name]` in their message but the LLM receives the full HTML
- List endpoint omits `html` field to keep responses small
- Name lookup is case-insensitive for user convenience
