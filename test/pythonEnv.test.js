import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPythonEnv, activatedEnv, missingModule, missingModuleHint, isPipInstall, pipRedirect, pythonEnvPromptLine, expandHome,
} from '../src/services/pythonEnv.js';

const UV = classifyPythonEnv({ venvPath: '/home/u/uv_env', bin: '/home/u/uv_env/bin/python', version: '3.12.3', hasPip: false, uvManaged: true, uvOnPath: true });
const VENV = classifyPythonEnv({ venvPath: '/home/u/venv', bin: '/home/u/venv/bin/python', version: '3.11.9', hasPip: true });
const CONDA = classifyPythonEnv({ venvPath: '/home/u/miniconda3/envs/fin', bin: '/home/u/miniconda3/envs/fin/bin/python', version: '3.10.14', hasPip: true, conda: true });
const SYSTEM = classifyPythonEnv({ venvPath: '', bin: 'python3', version: '3.12.3', hasPip: true });
const MISSING = classifyPythonEnv({ venvPath: '/nope', bin: '/nope/bin/python', exists: false });

test('classifyPythonEnv derives the install command that works for each kind of environment', () => {
  assert.equal(UV.kind, 'uv');
  assert.equal(UV.install('reportlab'), 'uv pip install --python /home/u/uv_env/bin/python reportlab');
  assert.equal(VENV.kind, 'venv');
  assert.equal(VENV.install('reportlab'), '/home/u/venv/bin/python -m pip install reportlab');
  assert.equal(CONDA.kind, 'conda');
  assert.match(CONDA.install('reportlab'), /^conda install -y -p \/home\/u\/miniconda3\/envs\/fin reportlab/);
  assert.equal(SYSTEM.kind, 'system');
  assert.equal(SYSTEM.install('reportlab'), 'python3 -m pip install --user reportlab');
  assert.match(SYSTEM.note, /PYTHON_VENV/);
  assert.equal(MISSING.kind, 'missing');
  // a uv venv with uv missing from PATH says so; a plain venv without pip bootstraps it
  assert.match(classifyPythonEnv({ venvPath: '/v', bin: '/v/bin/python', uvManaged: true, uvOnPath: false }).note, /not on PATH/);
  assert.match(classifyPythonEnv({ venvPath: '/v', bin: '/v/bin/python', hasPip: false }).install('x'), /ensurepip/);
});

test('activatedEnv is what `source activate` does; no venv leaves the environment untouched', () => {
  const base = { PATH: '/usr/bin:/bin', HOME: '/home/u' };
  const act = activatedEnv('/home/u/uv_env', base);
  assert.equal(act.VIRTUAL_ENV, '/home/u/uv_env');
  assert.ok(act.PATH.startsWith('/home/u/uv_env/bin:'));
  assert.equal(act.HOME, '/home/u');
  assert.equal(activatedEnv('', base), base);
  assert.equal(expandHome('~/x'), process.env.HOME + '/x');
  assert.equal(expandHome('/abs/~/x'), '/abs/~/x');
});

test('a ModuleNotFoundError becomes a hint with the install command for this interpreter', () => {
  const stderr = 'Traceback (most recent call last):\n  File ".tmp_script.py", line 35, in build\n    from reportlab.lib.pagesizes import A4\nModuleNotFoundError: No module named \'reportlab\'';
  assert.equal(missingModule(stderr), 'reportlab');
  assert.equal(missingModule("ModuleNotFoundError: No module named 'yaml.loader'"), 'yaml');
  assert.equal(missingModule('NameError: x'), null);
  assert.equal(missingModuleHint(stderr, UV), 'Module "reportlab" is not installed in the Python that run_python uses (/home/u/uv_env/bin/python). Install it with source_run: uv pip install --python /home/u/uv_env/bin/python reportlab');
  assert.match(missingModuleHint("ModuleNotFoundError: No module named 'cv2'", VENV), /pip install opencv-python$/);
  assert.match(missingModuleHint("ModuleNotFoundError: No module named 'PIL'", SYSTEM), /--user pillow$/);
  assert.equal(missingModuleHint('ok', UV), null);
});

test('pipRedirect refuses a pip install only where pip cannot reach the interpreter', () => {
  for (const c of ['pip install reportlab', 'pip3 install -q reportlab', 'python3 -m pip install reportlab', 'sudo pip install x', 'python -m pip install --break-system-packages reportlab']) {
    assert.ok(isPipInstall(c), c);
  }
  assert.ok(!isPipInstall('pip list'));
  assert.ok(!isPipInstall('npm install'));
  const r = pipRedirect('pip install --quiet --break-system-packages reportlab 2>&1 | tail -1', UV);
  assert.match(r.error, /system pip/);
  assert.equal(r.suggestion, 'uv pip install --python /home/u/uv_env/bin/python reportlab');
  assert.equal(pipRedirect('pip3 install -q numpy pandas && echo ok', UV).suggestion, 'uv pip install --python /home/u/uv_env/bin/python numpy pandas');
  assert.equal(pipRedirect('pip install reportlab', VENV), null, 'a venv with pip runs it as given');
  assert.equal(pipRedirect('pip install reportlab', SYSTEM), null, 'no venv: not our business');
  assert.equal(pipRedirect('npm install', UV), null);
});

test('the prompt line names the interpreter and the install command, or the absence of Python', () => {
  assert.match(pythonEnvPromptLine(UV), /^- Python: run_python and shell commands in source_run use uv venv at \/home\/u\/uv_env \(\/home\/u\/uv_env\/bin\/python, Python 3\.12\.3\)\. To add a package run via source_run: uv pip install --python \/home\/u\/uv_env\/bin\/python <package> — never `pip install` into the system Python/);
  assert.match(pythonEnvPromptLine(SYSTEM), /use the system python3 .*python3 -m pip install --user <package>.*PYTHON_VENV/);
  assert.match(pythonEnvPromptLine(MISSING), /NOT AVAILABLE/);
});
