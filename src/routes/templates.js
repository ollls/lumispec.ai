import { Router } from 'express';
import { listTemplates, createTemplate, updateTemplate, deleteTemplate, getTemplate, reorderTemplates } from '../services/templates.js';

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

router.delete('/:id', (req, res) => {
  deleteTemplate(req.params.id);
  res.json({ ok: true });
});

export default router;
