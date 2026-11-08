// Which Python the tools run, and how to add a package to it. Detected once from PYTHON_VENV (or
// the `python3` on PATH when it is unset), told to the model in one prompt line and in the hint on
// a ModuleNotFoundError, and used to "activate" the environment for every subprocess the tools
// spawn — PATH with the venv's bin first plus VIRTUAL_ENV, which is all `source activate` does.
//
// 2026-11-07: run_python failed on a missing `reportlab`; the model ran `pip install` through
// source_run, which resolved to the system pip (a uv venv has no pip at all), then forced it with
// --break-system-packages into the user site. The venv never saw the package. Nothing had told the
// model which interpreter it was using or how to add to it.
//
// The classify/hint/activate helpers are pure; `probePythonEnv()` does the filesystem and process
// probes; `getPythonEnv()` caches one probe per process.

import { existsSync, readFileSync } from 'fs';
import { join, delimiter } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

export function expandHome(p) {
  return String(p || '').replace(/^~(?=$|[\\/])/, homedir());
}

/**
 * Turn probe results into the environment description the rest of the app uses.
 *   kind: 'uv' | 'venv' | 'conda' | 'system' | 'missing'
 *   bin: interpreter path; version: '3.12.3' or ''; venvPath: '' when PYTHON_VENV is unset
 *   hasPip: whether `<bin> -m pip` works; install(pkg): the command that adds a package HERE
 *   note: one sentence for the prompt when something is worth saying (no venv, uv not on PATH)
 */
export function classifyPythonEnv({ venvPath = '', bin = 'python3', exists = true, version = '', hasPip = false, uvManaged = false, uvOnPath = false, conda = false } = {}) {
  const base = { venvPath, bin, version, hasPip, note: '' };
  if (!exists) {
    return { ...base, kind: 'missing', install: (pkg) => `# no Python interpreter found at ${bin}`, note: venvPath ? `PYTHON_VENV points at ${venvPath} but ${bin} does not exist.` : 'No python3 was found on PATH.' };
  }
  if (!venvPath) {
    return { ...base, kind: 'system', install: (pkg) => hasPip ? `python3 -m pip install --user ${pkg}` : `# python3 has no pip; install python3-pip (or set PYTHON_VENV to a venv) first`, note: 'Packages install to the user site; a dedicated venv via PYTHON_VENV in .env is the cleaner setup.' };
  }
  if (conda) {
    return { ...base, kind: 'conda', install: (pkg) => `conda install -y -p ${venvPath} ${pkg}` + (hasPip ? ` (or ${bin} -m pip install ${pkg})` : '') };
  }
  if (uvManaged) {
    // A uv venv ships without pip; `uv pip` targets it by --python (works whether or not it is activated)
    return { ...base, kind: 'uv', install: (pkg) => `uv pip install --python ${bin} ${pkg}`, note: uvOnPath ? '' : 'This is a uv-managed venv but `uv` is not on PATH; install uv or add pip to the venv (`' + bin + ' -m ensurepip`).' };
  }
  if (hasPip) return { ...base, kind: 'venv', install: (pkg) => `${bin} -m pip install ${pkg}` };
  return { ...base, kind: 'venv', install: (pkg) => `${bin} -m ensurepip --upgrade && ${bin} -m pip install ${pkg}`, note: 'The venv has no pip; the install command bootstraps it first.' };
}

function run(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: r.status === 0, out: (r.stdout || '').trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

/** The real probe: filesystem + three short subprocess calls. ~50 ms. */
export function probePythonEnv(venvSetting = '') {
  const venvPath = expandHome(venvSetting);
  const bin = venvPath ? join(venvPath, 'bin', 'python') : 'python3';
  const ver = run(bin, ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])']);
  if (!ver.ok) return classifyPythonEnv({ venvPath, bin, exists: false });
  const hasPip = run(bin, ['-m', 'pip', '--version']).ok;
  let uvManaged = false;
  try { uvManaged = venvPath ? /^uv\s*=/m.test(readFileSync(join(venvPath, 'pyvenv.cfg'), 'utf-8')) : false; } catch {}
  const conda = venvPath ? existsSync(join(venvPath, 'conda-meta')) : false;
  const uvOnPath = uvManaged ? run('uv', ['--version']).ok : false;
  return classifyPythonEnv({ venvPath, bin, exists: true, version: ver.out, hasPip, uvManaged, uvOnPath, conda });
}

let cached = null;
/** One probe per process, on first use (importing this module never spawns anything). */
export function getPythonEnv(venvSetting) {
  if (!cached) {
    cached = probePythonEnv(venvSetting);
    console.log(`[python-env] ${cached.kind}: ${cached.bin}${cached.version ? ' (Python ' + cached.version + ')' : ''}${cached.venvPath ? ' · PYTHON_VENV=' + cached.venvPath : ''} · install: ${cached.install('<pkg>')}`);
  }
  return cached;
}
export function resetPythonEnvCache() { cached = null; }

/** What `source bin/activate` does, as an env object for child processes. Unset venv → the base env unchanged. */
export function activatedEnv(venvPath, baseEnv = process.env) {
  if (!venvPath) return baseEnv;
  return { ...baseEnv, VIRTUAL_ENV: venvPath, PATH: join(venvPath, 'bin') + delimiter + (baseEnv.PATH || '') };
}

/** Env for the tools' subprocesses (run_python, source_run, source_test). */
export function toolEnv(env = getPythonEnv()) {
  return activatedEnv(env.venvPath);
}

// Import name → distribution name, for the usual traps
const MODULE_TO_PACKAGE = {
  cv2: 'opencv-python', PIL: 'pillow', yaml: 'pyyaml', sklearn: 'scikit-learn', bs4: 'beautifulsoup4',
  dateutil: 'python-dateutil', dotenv: 'python-dotenv', Crypto: 'pycryptodome', jwt: 'pyjwt', docx: 'python-docx',
  pptx: 'python-pptx', fitz: 'pymupdf', skimage: 'scikit-image', attr: 'attrs', websocket: 'websocket-client',
  serial: 'pyserial', usb: 'pyusb', Levenshtein: 'python-levenshtein', magic: 'python-magic', OpenSSL: 'pyopenssl',
};

/** The missing module from a traceback, or null. `import foo.bar` → 'foo'. */
export function missingModule(stderr) {
  const m = String(stderr || '').match(/ModuleNotFoundError: No module named '([^'.]+)/);
  return m ? m[1] : null;
}

/** A sentence telling the model how to add the missing module on this machine, or null. */
export function missingModuleHint(stderr, env) {
  const mod = missingModule(stderr);
  if (!mod) return null;
  const pkg = MODULE_TO_PACKAGE[mod] || mod;
  const cmd = env.install(pkg);
  if (cmd.startsWith('#')) return `Module "${mod}" is not installed and no package manager is available: ${cmd.slice(2)}`;
  return `Module "${mod}" is not installed in the Python that run_python uses (${env.bin}). Install it with source_run: ${cmd}`;
}

/** `pip install …`, `pip3 install …`, `python -m pip install …`, with or without sudo. */
export function isPipInstall(command) {
  return /^\s*(?:sudo\s+(?:-H\s+)?)?(?:pip3?|python3?(?:\.\d+)?\s+-m\s+pip)\s+install\b/.test(String(command || ''));
}

/**
 * For source_run: a `pip install` that cannot reach the interpreter run_python uses — a venv with
 * no pip of its own, where `pip` on PATH is the system one — is refused with the right command.
 * Anywhere pip exists in the environment, the command runs as given.
 */
export function pipRedirect(command, env) {
  if (!isPipInstall(command) || !env.venvPath || env.hasPip) return null;
  // package names: after `install`, before any shell operator, flags dropped
  const pkgs = String(command).replace(/^.*?\binstall\b/, '').split(/\s*(?:\||&&|;|\d?>)/)[0].replace(/\s--?[\w-]+(?:=\S+)?/g, '').trim() || '<pkg>';
  return {
    error: `Not run: "${command.trim()}" would use the system pip, not the Python that run_python uses (${env.bin}, ${env.kind} venv without pip).`,
    suggestion: env.install(pkgs),
  };
}

/** The line in the Code Execution prompt section. */
export function pythonEnvPromptLine(env) {
  if (env.kind === 'missing') return `- Python: NOT AVAILABLE — ${env.note} run_python will fail until this is fixed; say so instead of retrying.`;
  const where = env.venvPath ? `${env.kind === 'uv' ? 'uv venv' : env.kind === 'conda' ? 'conda env' : 'venv'} at ${env.venvPath}` : 'the system python3';
  const parts = [`- Python: run_python and shell commands in source_run use ${where} (${env.bin}, Python ${env.version}).`,
    `To add a package run via source_run: ${env.install('<package>')} — never \`pip install\` into the system Python and never \`--break-system-packages\`.`];
  if (env.note) parts.push(env.note);
  return parts.join(' ');
}
