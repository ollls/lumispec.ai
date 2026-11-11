// Troubleshoot (any answer) — builds the prompt the Troubleshoot button on an assistant bubble
// puts in the input box. Plain script (no modules): loaded by index.html ahead of app.js, and
// by test/troubleshoot.test.js in a vm context, so everything here must stay self-contained.
//
// The model sees its earlier answer as text only: tool rounds are not replayed and reasoning
// travels only with Retain. Asked "that number is wrong", it argues from memory. The button
// hands it (1) which answer is meant, (2) a turn report — facts the page already holds about
// that turn: which tools ran, which failed, fell back or were truncated, whether the answer was
// cut off — and (3) the conversation_read call that returns what the tools actually said.
// Nothing is sent until the user submits; the applet-level Troubleshoot button (app.js) is the
// same idea with a browser report.
(function (root) {
  'use strict';

  var PLACEHOLDER = '<what to check or correct>';
  var MAX_NOTABLE = 10;       // notable tool results listed one per line
  var MAX_SELECTION = 400;    // chars of selected text quoted as "Part in question"
  var READ_CAP = 3000;        // conversation_read's per-result cap in its list view
  var READ_NEWEST = 12;       // ...and how many results that list shows

  // The guidance paragraph. A saved prompt titled "Troubleshoot" replaces it (see app.js).
  var DEFAULT_GUIDANCE =
    'Check the answer against that evidence. Correct only what is described above and keep the rest as it is; ' +
    'if the answer was right, say so plainly instead of changing it. ' +
    'If nothing is described, ask me what to check instead of guessing.';

  function oneLine(s, max) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  // Same order as conversation_read's toolUsesOf(): chat tool uses, then per task, then its
  // subtasks — so "#3" here is `"tool": 3` there.
  function flatToolUses(turn) {
    var out = (turn.toolUses || []).slice();
    (turn.taskRun || []).forEach(function (task) {
      (task.toolUses || []).forEach(function (t) { out.push(t); });
      (task.subtasks || []).forEach(function (sub) {
        (sub.toolUses || []).forEach(function (t) { out.push(t); });
      });
    });
    return out;
  }

  function parse(result) {
    if (result && typeof result === 'object') return result;
    try { return JSON.parse(result); } catch (e) { return null; }
  }

  // What is worth a line about one stored tool result, or '' when it looks ordinary.
  function notable(tu) {
    var raw = typeof tu.result === 'string' ? tu.result : JSON.stringify(tu.result || '');
    var r = parse(tu.result);
    var bits = [];
    if (r && typeof r === 'object') {
      if (r.error) bits.push('error: ' + oneLine(typeof r.error === 'string' ? r.error : JSON.stringify(r.error), 160));
      if (r.fallback) bits.push('fell back to HTTP (' + oneLine(r.fallback, 100) + ')');
      if (r.loginWall) bits.push('returned a sign-in page');
      if (r._truncated) bits.push('result truncated' + (r.originalChars ? ' from ' + r.originalChars + ' chars' : ''));
      if (r.exitCode !== undefined && r.exitCode !== 0 && r.exitCode !== null) bits.push('exit code ' + r.exitCode);
      if (r.stderr && !r.error && /Error|Traceback/.test(String(r.stderr))) bits.push('stderr: ' + oneLine(r.stderr, 120));
    } else if (/^\s*(Error|\[Error)/.test(raw)) {
      bits.push(oneLine(raw, 160));
    }
    return { text: bits.join('; '), chars: raw.length };
  }

  /**
   * Facts about one stored assistant turn, one string per line (no bullets).
   * @param turn { text, toolUses, taskRun, reasoning } as stored on the message
   */
  function turnReport(turn) {
    turn = turn || {};
    var text = String(turn.text || '');
    var lines = [];
    var tools = flatToolUses(turn);

    if (turn.taskRun && turn.taskRun.length) {
      var steps = 0;
      turn.taskRun.forEach(function (t) { steps += t.subtasks ? t.subtasks.length : 1; });
      lines.push('task pipeline run: ' + turn.taskRun.length + ' task(s), ' + steps + ' step(s)');
      turn.taskRun.forEach(function (t, i) {
        if (t.error) lines.push('task ' + (i + 1) + ' ended with an error: ' + oneLine(t.error, 160));
        var cut = [t].concat(t.subtasks || []).filter(function (s) { return s.contextTruncated; });
        if (cut.length) lines.push('task ' + (i + 1) + ': the previous step\'s output was clipped before it was handed over');
      });
    }

    if (tools.length === 0) {
      lines.push('no tools ran in that turn');
    } else {
      var counts = {};
      var order = [];
      tools.forEach(function (t) {
        if (!counts[t.name]) { counts[t.name] = 0; order.push(t.name); }
        counts[t.name]++;
      });
      lines.push(tools.length + ' tool call(s): ' + order.map(function (n) {
        return counts[n] > 1 ? n + ' ×' + counts[n] : n;
      }).join(', '));

      var flagged = [];
      var long = [];
      tools.forEach(function (t, i) {
        var n = notable(t);
        if (n.text) flagged.push('#' + i + ' ' + t.name + ' → ' + n.text);
        else if (n.chars > READ_CAP) long.push('#' + i + ' ' + t.name + ' (' + n.chars + ' chars)');
      });
      flagged.slice(0, MAX_NOTABLE).forEach(function (l) { lines.push(l); });
      if (flagged.length > MAX_NOTABLE) lines.push('…and ' + (flagged.length - MAX_NOTABLE) + ' more flagged tool result(s)');
      if (flagged.length === 0) lines.push('no tool errors, fallbacks or truncated results recorded');
      if (long.length) lines.push('long results (read one in full with "tool": <index>): ' + long.slice(0, 6).join(', ') + (long.length > 6 ? ', …' : ''));
    }

    if (/^\[Error:/.test(text)) lines.push('the turn ended with an error instead of an answer: ' + oneLine(text, 200));
    else if (/^\[Stopped/.test(text)) lines.push('the turn was stopped before an answer was written');
    else if (/⚠ Answer cut off/.test(text)) lines.push('the answer was cut off at a limit (see its last line)');

    var applets = (text.match(/<applet\b/gi) || []).length;
    lines.push('answer: ' + text.length + ' chars' + (applets ? ', ' + applets + ' applet(s)' : ''));
    return lines;
  }

  /**
   * The text for the input box.
   * @param o { message, problem, selection, turn, guidance }
   *   message   index of the assistant message in the conversation
   *   problem   what the user had typed already ('' → a selected placeholder)
   *   selection text the user had selected inside that bubble, if any
   *   turn      { text, toolUses, taskRun, reasoning }
   *   guidance  replaces DEFAULT_GUIDANCE (a saved prompt titled "Troubleshoot")
   * @returns { text, selectStart, selectEnd } — the range to select (the placeholder), or the
   *          caret position after the problem text.
   */
  function buildPrompt(o) {
    o = o || {};
    var turn = o.turn || {};
    var idx = o.message;
    var tools = flatToolUses(turn);
    var hasReasoning = !!turn.reasoning || (turn.taskRun || []).some(function (t) {
      return t.reasoning || (t.subtasks || []).some(function (s) { return s.reasoning; });
    });

    var lead = 'Troubleshoot your earlier answer' + (idx !== undefined && idx !== null ? ' (message ' + idx + ')' : '') + '.\n\nProblem: ';
    var problem = String(o.problem || '').trim();
    var parts = [lead + (problem || PLACEHOLDER)];

    var sel = oneLine(o.selection, MAX_SELECTION);
    if (sel) parts.push('Part in question: "' + sel + '"');

    parts.push('Turn report (facts, not necessarily defects):\n' + turnReport(turn).map(function (l) { return '- ' + l; }).join('\n'));

    var call = function (what) {
      var c = { what: what };
      if (idx !== undefined && idx !== null) c.message = idx;
      return 'conversation_read ' + JSON.stringify(c);
    };
    var evidence;
    if (tools.length) {
      evidence = 'First call ' + call('tools') + ' to see what the tools actually returned in that turn' +
        (tools.length > READ_NEWEST ? ' (it lists the newest ' + READ_NEWEST + ' of ' + tools.length + ')' : '') +
        '; add "tool": <index> to read one result in full.';
    } else {
      evidence = 'No tools ran in that turn, so the answer in your history is all there is to check' +
        (/<applet\b/i.test(String(turn.text || '')) ? ' — except its applet code, which ' + call('applet') + ' returns' : '') + '.';
    }
    if (hasReasoning) evidence += ' If the question is why you answered that way, ' + call('reasoning') + ' returns your reasoning.';
    parts.push(evidence);

    parts.push(String(o.guidance || '').trim() || DEFAULT_GUIDANCE);

    var text = parts.join('\n\n');
    return problem
      ? { text: text, selectStart: lead.length + problem.length, selectEnd: lead.length + problem.length }
      : { text: text, selectStart: lead.length, selectEnd: lead.length + PLACEHOLDER.length };
  }

  // True when the stored answer is an error / stopped / cut-off turn: the button stays visible.
  function turnFailed(turn) {
    var text = String((turn && turn.text) || '');
    if (/^\[(Error:|Stopped)/.test(text) || /⚠ Answer cut off/.test(text)) return true;
    return ((turn && turn.taskRun) || []).some(function (t) { return !!t.error; });
  }

  root.Troubleshoot = {
    PLACEHOLDER: PLACEHOLDER,
    DEFAULT_GUIDANCE: DEFAULT_GUIDANCE,
    turnReport: turnReport,
    buildPrompt: buildPrompt,
    turnFailed: turnFailed,
  };
})(typeof window !== 'undefined' ? window : globalThis);
