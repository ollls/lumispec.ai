import { mkdir, writeFile, readFile, stat, unlink } from 'fs/promises';
import { join, resolve, basename } from 'path';
import config from '../config.js';
import { listTemplates, getTemplateByName } from '../services/templates.js';
import { fixPythonBooleans, tagLineCount } from './index.js';

// Original SOURCE_DIR from .env — used by source_project to reset
const originalSourceDir = config.sourceDir;

// ── source_edit helpers ────────────────────────────────
const fileEditLocks = new Map();

async function withFileLock(filePath, fn) {
  const prev = fileEditLocks.get(filePath) || Promise.resolve();
  const current = prev.then(fn, fn);
  fileEditLocks.set(filePath, current);
  try { return await current; }
  finally { if (fileEditLocks.get(filePath) === current) fileEditLocks.delete(filePath); }
}

function simpleDiff(oldContent, newContent, filePath) {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  let top = 0;
  while (top < oldLines.length && top < newLines.length && oldLines[top] === newLines[top]) top++;
  let oldBot = oldLines.length - 1;
  let newBot = newLines.length - 1;
  while (oldBot > top && newBot > top && oldLines[oldBot] === newLines[newBot]) { oldBot--; newBot--; }
  if (top > oldBot && top > newBot) return `--- ${filePath}\n+++ ${filePath}\n(no changes)`;
  const ctx = 3;
  const hunkStart = Math.max(0, top - ctx);
  const hunkOldEnd = Math.min(oldLines.length - 1, oldBot + ctx);
  const hunkNewEnd = Math.min(newLines.length - 1, newBot + ctx);
  const out = [`--- ${filePath}`, `+++ ${filePath}`,
    `@@ -${hunkStart + 1},${hunkOldEnd - hunkStart + 1} +${hunkStart + 1},${hunkNewEnd - hunkStart + 1} @@`];
  for (let i = hunkStart; i < top; i++) out.push(` ${oldLines[i]}`);
  for (let i = top; i <= oldBot; i++) out.push(`-${oldLines[i]}`);
  for (let i = top; i <= newBot; i++) out.push(`+${newLines[i]}`);
  for (let i = oldBot + 1; i <= hunkOldEnd; i++) out.push(` ${oldLines[i]}`);
  return out.join('\n');
}

export default {
  group: 'source',
  condition: () => !!config.sourceDir,
  prompt: `## Self-Awareness
You have access to your own source code via source tools. You are "LLM Workbench" — an Express-based chat app.

Source tool workflow:
1. Use source_project to switch to a different project directory (if needed — always do this BEFORE using other source tools on a non-default project)
2. Use source_read to browse files (tree/read/grep)
3. Use source_edit for ALL changes to existing files (targeted string replacement — always prefer this over source_write)
4. Use source_write ONLY to create new files — never use it to modify existing files
5. Use source_delete to remove files
6. Use source_run to execute scripts and commands in the project directory
7. Use source_test to verify changes work
8. Use source_git for version control

IMPORTANT: When writing Python code, use correct Python syntax — True, False, None (not JavaScript true, false, null).

CRITICAL RULE: When asked to modify code, IMMEDIATELY use source_edit or source_write. Do NOT show code snippets, examples, or previews in chat — apply the change directly with tools. Never describe what you would change — just change it. Read the file first with source_read if needed, then edit it.`,
  tools: {
    source_project: {
      description: 'Switch the source code working directory to a different project. All source tools (source_read, source_write, source_edit, source_delete, source_git, source_test) will operate on the new directory.\n\n'
        + 'Actions:\n'
        + '- "switch": switch to a new project. Requires "path" (absolute or ~/ path, e.g. "~/prj/my_app")\n'
        + '- "reset": revert to the original project directory from .env\n'
        + '- "status": show current and original source directories\n\n'
        + 'Always requires user approval.',
      parameters: {
        action: 'string (switch, reset, status)',
        path: 'string (optional, absolute path for switch action)',
      },
      execute: async ({ action, path: targetPath }, context) => {
        if (!context?.confirmFn) return { error: 'No confirmation channel available' };

        switch (action) {
          case 'status':
            return { current: config.sourceDir || '(not set)', original: originalSourceDir || '(not set)' };

          case 'reset': {
            if (!originalSourceDir) return { error: 'No original SOURCE_DIR configured in .env' };
            if (config.sourceDir === originalSourceDir) return { message: 'Already pointing to original project', current: config.sourceDir };
            const prev = config.sourceDir;
            const approved = await context.confirmFn(`Reset source directory:\n  from: ${prev}\n  to:   ${originalSourceDir}`);
            if (!approved) return { denied: true, message: 'User denied project reset.' };
            config.sourceDir = originalSourceDir;
            return { switched: true, previous: prev, current: config.sourceDir };
          }

          case 'switch': {
            if (!targetPath?.trim()) return { error: 'path is required for switch action' };
            const expanded = targetPath.startsWith('~') ? targetPath.replace('~', process.env.HOME || '') : targetPath;
            const full = resolve(expanded);
            try {
              const s = await stat(full);
              if (!s.isDirectory()) return { error: `Not a directory: ${full}` };
            } catch (err) {
              if (err.code === 'ENOENT') return { error: `Directory not found: ${full}` };
              return { error: err.message };
            }
            if (config.sourceDir === full) return { message: 'Already pointing to this directory', current: full };
            const prev = config.sourceDir;
            const approved = await context.confirmFn(`Switch source directory:\n  from: ${prev || '(not set)'}\n  to:   ${full}`);
            if (!approved) return { denied: true, message: 'User denied project switch.' };
            config.sourceDir = full;
            return { switched: true, previous: prev || '(not set)', current: full };
          }

          case 'tree': {
            if (!config.sourceDir) return { error: 'SOURCE_DIR not configured in .env' };
            const { execSync } = await import('child_process');
            const treeRoot = resolve(config.sourceDir);
            try {
              const output = execSync(
                'find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/data/*" -not -path "*/logs/*" -not -path "*/public/css/output.css" -not -path "*/public/lib/*" -not -name "package-lock.json" | sort',
                { cwd: treeRoot, encoding: 'utf-8', timeout: 5000 }
              );
              const files = output.trim().split('\n').filter(Boolean);
              return { root: treeRoot, fileCount: files.length, files };
            } catch (err) {
              return { error: err.message };
            }
          }

          default:
            return { error: 'Unknown action. Use: switch, reset, status, tree' };
        }
      },
    },
    source_read: {
      description: 'Read this application\'s own source code. This is YOUR source code — use it to understand how you work, review your own implementation, or help the user modify you.\n\n'
        + 'Actions:\n'
        + '- "tree": list all source files (respects .gitignore, excludes node_modules/data/logs)\n'
        + '- "read": read a file. Requires "path" (relative to project root, e.g. "src/server.js")\n'
        + '- "grep": search source code. Requires "pattern" (regex). Optional "glob" to filter files (e.g. "*.js")',
      parameters: {
        action: 'string (tree, read, grep)',
        path: 'string (optional, relative file path for read)',
        pattern: 'string (optional, regex for grep)',
        glob: 'string (optional, file glob for grep)',
      },
      execute: async ({ action, path: filePath, pattern, glob: fileGlob }) => {
        if (!action && filePath) action = 'read';
        if (!action && pattern) action = 'grep';
        if (!action) action = 'tree';

        if (!config.sourceDir) return { error: 'SOURCE_DIR not configured in .env' };
        const sourceRoot = resolve(config.sourceDir);

        switch (action) {
          case 'tree': {
            const { execSync } = await import('child_process');
            try {
              const output = execSync(
                'find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/data/*" -not -path "*/logs/*" -not -path "*/public/css/output.css" -not -path "*/public/lib/*" -not -name "package-lock.json" | sort',
                { cwd: sourceRoot, encoding: 'utf-8', timeout: 5000 }
              );
              const files = output.trim().split('\n').filter(Boolean);
              return { root: sourceRoot, fileCount: files.length, files };
            } catch (err) {
              return { error: err.message };
            }
          }
          case 'read': {
            if (!filePath?.trim()) return { error: 'path is required for read action' };
            const full = resolve(sourceRoot, filePath);
            if (!full.startsWith(sourceRoot)) return { error: 'Path escapes source directory' };
            try {
              let content = await readFile(full, 'utf-8');
              const lines = content.split('\n').length;
              if (content.length > 15000) content = content.slice(0, 15000) + '\n...[truncated]';
              return { path: filePath, lines, content };
            } catch (err) {
              if (err.code === 'ENOENT') {
                const dirName = basename(sourceRoot);
                const hint = filePath.startsWith(dirName) ? ` (hint: you are already in ${dirName}/ — use "${filePath.replace(dirName + '/', '')}" instead)` : '';
                return { error: `File not found: ${filePath}${hint}` };
              }
              return { error: err.message };
            }
          }
          case 'grep': {
            if (!pattern?.trim()) return { error: 'pattern is required for grep action' };
            const { execSync } = await import('child_process');
            try {
              let cmd = `grep -rn --include="*.js" --include="*.json" --include="*.html" --include="*.css" --include="*.md"`;
              if (fileGlob) cmd = `grep -rn --include="${fileGlob.replace(/"/g, '')}"`;
              cmd += ` -E ${JSON.stringify(pattern)} . || true`;
              const output = execSync(cmd, {
                cwd: sourceRoot, encoding: 'utf-8', timeout: 10000, maxBuffer: 512 * 1024,
              });
              const lines = output.trim().split('\n').filter(Boolean);
              if (lines.length > 50) {
                return { pattern, matchCount: lines.length, matches: lines.slice(0, 50), truncated: true };
              }
              return { pattern, matchCount: lines.length, matches: lines };
            } catch (err) {
              return { error: err.message };
            }
          }
          default:
            return { error: 'Unknown action. Use: tree, read, grep' };
        }
      },
    },
    template_save: {
      description: 'Save a stored applet template as a file in the source project directory. Use this when the user asks to copy/extract/export a template to a file.\n\n'
        + 'Parameters:\n'
        + '- "name": template name (case-insensitive lookup)\n'
        + '- "path": relative file path to save to (e.g. "watch.html"). Defaults to "<name>.html"\n\n'
        + 'Lists available templates if name not found. Requires user approval unless autorun is enabled.',
      parameters: {
        name: 'string (template name)',
        path: 'string (optional, relative file path)',
      },
      execute: async ({ name, path: filePath }, context) => {
        if (!config.sourceDir) return { error: 'SOURCE_DIR not configured in .env' };
        if (!name?.trim()) {
          const all = listTemplates();
          if (!all.length) return { error: 'No templates saved' };
          return { error: 'name is required', available: all.map(t => t.name) };
        }

        const tpl = getTemplateByName(name.trim());
        if (!tpl) {
          const all = listTemplates();
          return { error: `Template "${name}" not found`, available: all.map(t => t.name) };
        }

        const safeName = tpl.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        if (!filePath?.trim()) filePath = `${safeName}.html`;

        const sourceRoot = resolve(config.sourceDir);
        const full = resolve(sourceRoot, filePath);
        if (!full.startsWith(sourceRoot)) return { error: 'Path escapes source directory' };

        const content = tpl.html;
        let oldContent = '';
        try { oldContent = await readFile(full, 'utf-8'); } catch {}
        const diff = simpleDiff(oldContent, content, filePath);

        let approved;
        if (context.autorun) {
          console.log(`[template_save] autorun enabled, skipping confirmation`);
          approved = true;
        } else {
          approved = await context.confirmFn(`Save template "${tpl.name}" to: ${filePath}\n${diff}`);
        }
        if (!approved) return { denied: true, message: 'User denied template save.' };

        try {
          const { dirname: dirnameFn } = await import('path');
          const { mkdir: mkdirFn, writeFile: writeFn } = await import('fs/promises');
          await mkdirFn(dirnameFn(full), { recursive: true });
          await writeFn(full, content, 'utf-8');
          const lines = content.split('\n').length;
          return { template: tpl.name, path: filePath, lines, size: Buffer.byteLength(content, 'utf-8'), _diff: diff };
        } catch (err) {
          return { error: err.message };
        }
      },
    },
    source_write: {
      description: 'Create a new file or fully replace an existing file in the source code directory. For small changes to existing files, prefer source_edit instead.\n\n'
        + 'Parameters:\n'
        + '- "path": relative file path (e.g. "src/services/newFile.js")\n'
        + '- "content": the full file content to write\n\n'
        + 'Creates parent directories automatically. Shows a diff preview to the user. Requires user approval unless autorun is enabled.',
      parameters: {
        path: 'string (relative file path)',
        content: 'string (file content)',
      },
      execute: async ({ path: filePath, content }, context) => {
        if (!config.sourceDir) return { error: 'SOURCE_DIR not configured in .env' };
        if (!filePath?.trim()) return { error: 'path is required' };
        if (content == null) return { error: 'content is required' };
        if (!context?.confirmFn) return { error: 'No confirmation channel available' };

        const { resolve: resolvePath, dirname } = await import('path');
        const { mkdir: mkdirFn, writeFile: fsWriteFile } = await import('fs/promises');
        const sourceRoot = resolvePath(config.sourceDir);
        const full = resolvePath(sourceRoot, filePath);
        if (!full.startsWith(sourceRoot)) return { error: 'Path escapes source directory' };

        if (filePath.endsWith('.py')) content = fixPythonBooleans(content);

        let oldContent = '';
        try { oldContent = await readFile(full, 'utf-8'); } catch {}
        const diff = simpleDiff(oldContent, content, filePath);

        let approved;
        if (context.autorun) {
          console.log(`[source_write] autorun enabled, skipping confirmation`);
          approved = true;
        } else {
          approved = await context.confirmFn(`Write file: ${filePath}\n${diff}`);
        }
        if (!approved) return { denied: true, message: 'User denied file write.' };

        try {
          await mkdirFn(dirname(full), { recursive: true });
          await fsWriteFile(full, content, 'utf-8');
          const lines = content.split('\n').length;
          return { path: filePath, lines, size: Buffer.byteLength(content, 'utf-8'), _diff: diff };
        } catch (err) {
          return { error: err.message };
        }
      },
    },
    source_edit: {
      description: 'Make targeted edits to source files. Replaces an exact string with new content — use source_read first to see the current file, then specify the exact text to replace.\n\n'
        + 'Parameters:\n'
        + '- "path": relative file path (e.g. "src/services/tools.js")\n'
        + '- "old_string": exact text to find and replace (must match exactly one location in the file). Empty string = create new file.\n'
        + '- "new_string": replacement text. Empty string = delete the matched text.\n\n'
        + 'Rules:\n'
        + '- old_string must be unique in the file. If multiple matches found, the tool returns all match locations — retry with more surrounding context.\n'
        + '- Copy old_string exactly from source_read output, including indentation.\n'
        + '- A color-coded diff is always shown to the user. Requires approval unless autorun is enabled.',
      parameters: {
        path: 'string (relative file path)',
        old_string: 'string (exact text to find, or empty to create new file)',
        new_string: 'string (replacement text)',
      },
      execute: async ({ path: filePath, old_string: oldStr, new_string: newStr }, context) => {
        if (!config.sourceDir) return { error: 'SOURCE_DIR not configured in .env' };
        if (!filePath?.trim()) return { error: 'path is required' };
        if (newStr == null) return { error: 'new_string is required' };
        if (!context?.confirmFn) return { error: 'No confirmation channel available' };

        const sourceRoot = resolve(config.sourceDir);
        const full = resolve(sourceRoot, filePath);
        if (!full.startsWith(sourceRoot)) return { error: 'Path escapes source directory' };

        // CREATE mode
        if (!oldStr) {
          try {
            await stat(full);
            return { error: 'old_string is required when editing an existing file' };
          } catch {
            let approved;
            if (context.autorun) { approved = true; }
            else { approved = await context.confirmFn(`Create file: ${filePath}\n(${newStr.split('\n').length} lines)`); }
            if (!approved) return { denied: true, message: 'User denied file creation.' };
            const { dirname } = await import('path');
            await mkdir(dirname(full), { recursive: true });
            await writeFile(full, newStr, 'utf-8');
            return { path: filePath, created: true, lines: newStr.split('\n').length, size: Buffer.byteLength(newStr, 'utf-8') };
          }
        }

        if (filePath.endsWith('.py')) {
          oldStr = fixPythonBooleans(oldStr);
          newStr = fixPythonBooleans(newStr);
        }

        if (oldStr === newStr) return { noChange: true, message: 'old_string and new_string are identical' };

        // EDIT mode
        return withFileLock(full, async () => {
          let content;
          try {
            content = await readFile(full, 'utf-8');
          } catch (err) {
            if (err.code === 'ENOENT') return { error: `File not found: ${filePath}` };
            return { error: err.message };
          }

          const buf = Buffer.from(content.slice(0, 8192));
          if (buf.includes(0)) return { error: 'Binary file — use source_write for binary content' };
          if (Buffer.byteLength(content, 'utf-8') > 1024 * 1024) {
            return { error: `File too large (${Buffer.byteLength(content, 'utf-8')} bytes) — use source_run with sed for large files` };
          }
          if (oldStr.includes('[truncated]')) {
            return { warning: 'old_string contains "[truncated]" — this is a truncation marker from source_read, not actual file content. Re-read the file to get the real text.' };
          }

          let matchCount = 0;
          let idx = -1;
          let searchFrom = 0;
          const matchPositions = [];
          while ((idx = content.indexOf(oldStr, searchFrom)) !== -1) {
            matchCount++;
            const lineNum = content.slice(0, idx).split('\n').length;
            const lines = content.split('\n');
            const ctxStart = Math.max(0, lineNum - 3);
            const ctxEnd = Math.min(lines.length - 1, lineNum + 1);
            matchPositions.push({ line: lineNum, context: lines.slice(ctxStart, ctxEnd + 1).join('\n') });
            searchFrom = idx + 1;
          }

          // Whitespace fallback
          let whitespaceAdjusted = false;
          if (matchCount === 0) {
            const normalize = s => s.replace(/[ \t]+/g, ' ');
            const normOld = normalize(oldStr);
            const normContent = normalize(content);
            let normIdx = -1;
            let normCount = 0;
            let normSearchFrom = 0;
            while ((normIdx = normContent.indexOf(normOld, normSearchFrom)) !== -1) {
              normCount++;
              normSearchFrom = normIdx + 1;
            }
            if (normCount === 1) {
              const contentLines = content.split('\n');
              const oldLines = oldStr.split('\n');
              outer: for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
                for (let j = 0; j < oldLines.length; j++) {
                  if (normalize(contentLines[i + j]) !== normalize(oldLines[j])) continue outer;
                }
                oldStr = contentLines.slice(i, i + oldLines.length).join('\n');
                matchCount = 1;
                whitespaceAdjusted = true;
                break;
              }
            }
          }

          if (matchCount === 0) {
            return { error: 'No match found for old_string', hint: 'Verify current file content with source_read.', fileLines: content.split('\n').length };
          }
          if (matchCount > 1) {
            return { error: `Found ${matchCount} matches — old_string must be unique. Include more surrounding context.`, matches: matchPositions };
          }

          const newContent = content.replace(oldStr, newStr);
          const diff = simpleDiff(content, newContent, filePath);

          let approved;
          if (context.autorun) {
            console.log(`[source_edit] autorun enabled, skipping confirmation`);
            approved = true;
          } else {
            approved = await context.confirmFn(`Edit file: ${filePath}\n${diff}`);
          }
          if (!approved) return { denied: true, message: 'User denied edit.' };

          await writeFile(full, newContent, 'utf-8');
          const oldLineCount = oldStr.split('\n').length;
          const newLineCount = newStr.split('\n').length;
          const result = { path: filePath, linesRemoved: oldLineCount, linesAdded: newLineCount, size: Buffer.byteLength(newContent, 'utf-8'), _diff: diff };
          if (whitespaceAdjusted) result.whitespaceAdjusted = true;
          return result;
        });
      },
    },
    source_delete: {
      description: 'Delete a file from the application\'s source code directory. Use during refactors to remove unused files.\n\n'
        + 'Parameters:\n'
        + '- "path": relative file path to delete (e.g. "src/services/old.js")\n\n'
        + 'Requires user approval unless autorun is enabled.',
      parameters: {
        path: 'string (relative file path)',
      },
      execute: async ({ path: filePath }, context) => {
        if (!config.sourceDir) return { error: 'SOURCE_DIR not configured in .env' };
        if (!filePath?.trim()) return { error: 'path is required' };
        if (!context?.confirmFn) return { error: 'No confirmation channel available' };

        const sourceRoot = resolve(config.sourceDir);
        const full = resolve(sourceRoot, filePath);
        if (!full.startsWith(sourceRoot)) return { error: 'Path escapes source directory' };

        let fileStats;
        try {
          fileStats = await stat(full);
        } catch (err) {
          if (err.code === 'ENOENT') return { error: `File not found: ${filePath}` };
          return { error: err.message };
        }
        if (fileStats.isDirectory()) return { error: 'Cannot delete directories — only files' };

        let approved;
        if (context.autorun) {
          console.log(`[source_delete] autorun enabled, skipping confirmation`);
          approved = true;
        } else {
          approved = await context.confirmFn(`Delete file: ${filePath} (${fileStats.size} bytes)`);
        }
        if (!approved) return { denied: true, message: 'User denied file deletion.' };

        let diff = '';
        try {
          const oldContent = await readFile(full, 'utf-8');
          diff = simpleDiff(oldContent, '', filePath);
        } catch {}

        await unlink(full);
        return { path: filePath, deleted: true, size: fileStats.size, _diff: diff };
      },
    },
    source_git: {
      description: 'Run git commands in the source code directory. Pass the git subcommand and arguments as "command" (without the "git" prefix).\n\n'
        + 'Examples: {"command": "status"}, {"command": "diff src/server.js"}, {"command": "log --oneline -10"}, {"command": "add src/"}, {"command": "commit -m \'fix bug\'"}, {"command": "push"}\n\n'
        + 'Safety tiers:\n'
        + '- Read-only (status, diff, log, show, branch -l): no approval needed\n'
        + '- Local writes (add, commit, checkout, branch, stash, merge, tag): approval or autorun\n'
        + '- Remote (push, pull, fetch): always requires approval\n'
        + '- Blocked: reset --hard, push --force, clean -f, rebase',
      parameters: {
        command: 'string (git subcommand + args, without "git" prefix)',
      },
      execute: async ({ command }, context) => {
        if (!config.sourceDir) return { error: 'SOURCE_DIR not configured in .env' };
        if (!command?.trim()) return { error: 'command is required — use {"command": "status"} not {"action": "status"}' };
        if (!context?.confirmFn) return { error: 'No confirmation channel available' };

        const sourceRoot = resolve(config.sourceDir);
        const parts = command.trim().split(/\s+/);
        const sub = parts[0];
        const fullCmd = command.trim();

        const blocked = [
          { match: () => fullCmd.match(/reset\s+--hard/), reason: 'reset --hard discards uncommitted work — use checkout or stash instead' },
          { match: () => fullCmd.match(/push\s+.*--force/) || fullCmd.match(/push\s+-f/), reason: 'force push can destroy remote history — not allowed' },
          { match: () => fullCmd.match(/clean\s+.*-f/), reason: 'clean -f permanently deletes untracked files — use status to review first' },
          { match: () => sub === 'rebase', reason: 'rebase rewrites history — use merge instead, or run via source_run if needed' },
        ];
        for (const b of blocked) {
          if (b.match()) return { error: `Blocked: ${b.reason}` };
        }

        const safe = ['status', 'diff', 'log', 'show', 'blame', 'shortlog', 'describe', 'remote', 'ls-files', 'rev-parse'];
        const isBranchList = sub === 'branch' && (parts.includes('-l') || parts.includes('--list') || parts.includes('-a') || parts.includes('-r') || parts.length === 1);
        const isReadOnly = safe.includes(sub) || isBranchList;
        const remote = ['push', 'pull', 'fetch'];
        const isRemote = remote.includes(sub);

        let approved;
        if (isReadOnly) {
          approved = true;
        } else if (isRemote) {
          approved = await context.confirmFn(`git ${fullCmd}`);
        } else if (context.autorun) {
          console.log(`[source_git] autorun enabled, skipping confirmation`);
          approved = true;
        } else {
          approved = await context.confirmFn(`git ${fullCmd}`);
        }
        if (!approved) return { denied: true, message: 'User denied git command.' };

        const { exec } = await import('child_process');
        return new Promise((res) => {
          exec(`git ${fullCmd}`, {
            cwd: sourceRoot,
            encoding: 'utf-8',
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          }, (err, stdout, stderr) => {
            if (err) {
              res({
                command: `git ${fullCmd}`,
                exitCode: typeof err.code === 'number' ? err.code : 1,
                stdout: tagLineCount(stdout, 8000),
                stderr: ((stderr || '') + (err.killed ? '\n[source_git] killed: exceeded 30s timeout' : '')).slice(0, 4000),
              });
            } else {
              res({ command: `git ${fullCmd}`, exitCode: 0, stdout: tagLineCount(stdout, 8000), stderr: (stderr || '').slice(0, 4000) });
            }
          });
        });
      },
    },
    source_run: {
      description: 'Run a shell command in the source project directory. Unlike run_python (which runs in the saved files directory), this runs in the source project directory.\n\n'
        + 'Examples: "python3 colorful_text.py", "npm run build", "make", "go run main.go"\n\n'
        + 'Requires user approval unless autorun is enabled.',
      parameters: {
        command: 'string (shell command to run in the source project directory)',
      },
      execute: async ({ command }, context) => {
        if (!config.sourceDir) return { error: 'SOURCE_DIR not configured in .env' };
        if (!command?.trim()) return { error: 'command is required' };
        if (!context?.confirmFn) return { error: 'No confirmation channel available' };

        const sourceRoot = resolve(config.sourceDir);
        let approved;
        if (context.autorun) {
          console.log(`[source_run] autorun enabled, skipping confirmation`);
          approved = true;
        } else {
          approved = await context.confirmFn(`Run in ${sourceRoot}:\n${command}`);
        }
        if (!approved) return { denied: true, message: 'User denied command.' };

        const { exec } = await import('child_process');
        return new Promise((res) => {
          exec(command, {
            cwd: sourceRoot,
            encoding: 'utf-8',
            timeout: 120000,
            maxBuffer: 2 * 1024 * 1024,
          }, (err, stdout, stderr) => {
            if (err) {
              res({
                command,
                exitCode: typeof err.code === 'number' ? err.code : 1,
                stdout: tagLineCount(stdout, 8000),
                stderr: ((stderr || '') + (err.killed ? '\n[source_run] killed: exceeded 120s timeout' : '')).slice(0, 4000),
              });
            } else {
              res({ command, exitCode: 0, stdout: tagLineCount(stdout, 8000), stderr: (stderr || '').slice(0, 4000) });
            }
          });
        });
      },
    },
    source_test: {
      description: 'Run the project\'s test/check command to verify code changes work. No parameters needed — runs the command configured in SOURCE_TEST env var.\n\n'
        + 'Call this after making code changes with source_edit or source_write to catch errors early. '
        + 'If tests fail, review the output, fix the issue with source_edit, and run source_test again.',
      parameters: {},
      execute: async () => {
        if (!config.sourceDir) return { error: 'SOURCE_DIR not configured in .env' };
        if (!config.sourceTest) return { error: 'SOURCE_TEST not configured in .env — set it to your project\'s test command (e.g. "npm test", "pytest -x", "cargo test", "go test ./...")' };

        const sourceRoot = resolve(config.sourceDir);
        const { exec } = await import('child_process');
        return new Promise((res) => {
          exec(config.sourceTest, {
            cwd: sourceRoot,
            encoding: 'utf-8',
            timeout: 120000,
            maxBuffer: 2 * 1024 * 1024,
          }, (err, stdout, stderr) => {
            const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
            const timedOut = err?.killed || false;
            res({
              command: config.sourceTest,
              exitCode,
              passed: exitCode === 0,
              stdout: tagLineCount(stdout, 8000),
              stderr: ((stderr || '') + (timedOut ? '\n[source_test] killed: exceeded 120s timeout' : '')).slice(0, 4000),
            });
          });
        });
      },
    },
  },
};
