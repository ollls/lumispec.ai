import { Router } from 'express';
import { listTemplates, createTemplate, updateTemplate, deleteTemplate, getTemplate, reorderTemplates } from '../services/templates.js';
import { collectChatCompletion } from '../services/llm.js';

const router = Router();

// Sanitize template HTML before saving — fix common LLM mistakes
function sanitizeTemplate(html) {
  // Python → JS: None → null, True → true, False → false (in JS context only)
  // Match inside <script> blocks to avoid touching HTML content
  html = html.replace(/(<script[\s>][\s\S]*?<\/script>)/gi, (scriptBlock) => {
    return scriptBlock
      .replace(/===\s*None\b/g, '=== null')
      .replace(/!==\s*None\b/g, '!== null')
      .replace(/\bNone\b(?=\s*[;,)\]}|&?:])/g, 'null')
      .replace(/===\s*True\b/g, '=== true')
      .replace(/===\s*False\b/g, '=== false')
      .replace(/\bTrue\b(?=\s*[;,)\]}|&?:])/g, 'true')
      .replace(/\bFalse\b(?=\s*[;,)\]}|&?:])/g, 'false');
  });
  // CDN → local Chart.js
  html = html.replace(/https?:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js[^"']*/g, '/lib/chart.min.js');
  html = html.replace(/https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/[^"']*/g, '/lib/chart.min.js');
  // Remove stray semicolons inside closing tags: </div>;" → </div>"
  html = html.replace(/<\/div>;"/g, '</div>"');
  html = html.replace(/<\/div>;'/g, "</div>'");
  return html;
}

router.get('/', (_req, res) => {
  res.json(listTemplates());
});

router.get('/:id', (req, res) => {
  const template = getTemplate(req.params.id);
  if (!template) return res.status(404).json({ error: 'not found' });
  res.json(template);
});

router.post('/', (req, res) => {
  const { name, type, html } = req.body;
  if (!name?.trim() || !html?.trim()) return res.status(400).json({ error: 'name and html required' });
  res.json(createTemplate(name.trim(), type || 'html', sanitizeTemplate(html)));
});

router.patch('/:id', (req, res) => {
  const { name, type, html } = req.body;
  if (!name?.trim() && !html?.trim()) return res.status(400).json({ error: 'name or html required' });
  const updates = {};
  if (name?.trim()) updates.name = name.trim();
  if (type?.trim()) updates.type = type.trim();
  if (html?.trim()) updates.html = sanitizeTemplate(html.trim());
  const template = updateTemplate(req.params.id, updates);
  if (!template) return res.status(404).json({ error: 'not found' });
  res.json(template);
});

router.put('/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  res.json(reorderTemplates(ids));
});

router.post('/:id/optimize', async (req, res) => {
  const template = getTemplate(req.params.id);
  if (!template) return res.status(404).json({ error: 'not found' });
  try {
    const { content } = await collectChatCompletion([
      { role: 'system', content: `You are an HTML/JS template optimizer. You receive an applet HTML template and return an IMPROVED version.

Rules:
- Return ONLY the complete HTML — no explanation, no markdown, no code fences
- Fix JavaScript bugs: None→null, True→true, False→false, undeclared variables
- Replace CDN URLs with local: Chart.js → /lib/chart.min.js
- Data loading: if template has hardcoded data arrays, convert to fetch from /files/FILENAME.csv or /files/FILENAME.json and parse client-side
- Use a const FILES = [...] array at the top of <script> for data filenames so the LLM can substitute them when using the template
- For select/dropdown elements: populate options dynamically from loaded data, never leave empty <select> elements
- Add error handling for fetch() calls with user-visible error messages
- Ensure the resize postMessage is present: window.parent.postMessage({type:'resize',height:document.body.scrollHeight},'*') on load and after data renders
- Remove hardcoded stock symbols, dollar amounts, account names, or personal data — replace with data-driven rendering
- Keep the exact same visual design, CSS, layout, and color scheme
- Keep it concise — do not add comments or expand minified code` },
      { role: 'user', content: template.html },
    ], { maxTokens: 8192 });
    if (!content?.trim()) return res.status(500).json({ error: 'LLM returned empty response' });
    // Strip markdown fences if LLM wrapped the output
    let optimized = content.trim();
    optimized = optimized.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    // Run deterministic sanitizer on top
    optimized = sanitizeTemplate(optimized);
    const updated = updateTemplate(req.params.id, { html: optimized });
    res.json({ ok: true, template: updated });
  } catch (err) {
    console.error('[template-optimize]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  deleteTemplate(req.params.id);
  res.json({ ok: true });
});

export default router;
