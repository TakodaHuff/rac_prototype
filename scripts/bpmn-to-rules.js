// BPMN importer: turns the decision tree drawn in BPMN (e.g. bpmn.io or
// Camunda Modeler) into rules.json, keeping every node ID.
//
//   npm run import:bpmn -- <file.bpmn> [--out <rules.json>]
//
// Mapping:
//   exclusive gateway  -> decision node, asked as a yes/no question
//                         ("Q1.1 Question text? (citation)" -> question + citation)
//   arrows "Yes…"/"No…" -> the node's true / false targets; any note after
//                         the dash ("No – defect: …") goes into its supportive text
//   end event          -> outcome node (its name becomes the description)
//   start event        -> "start"
//   other tasks/events with one outgoing arrow are passed through.
//
// The BPMN holds the legal logic, so questions, citations, branches and
// outcome descriptions always come from it. Texts the BPMN doesn't have are
// kept from the existing rules.json for every node ID that still exists:
// meta, glossary, short outcome labels, supportive texts and the variables
// (data dictionary). New questions get a yes/no variable and a
// "TODO (stödtext)" marker so the Law team sees what still needs writing.
const fs = require('fs');
const path = require('path');
const RaC = require('../js/logic.js');

// ---------------------------------------------------------------------
// Reading the BPMN XML
// ---------------------------------------------------------------------

function decodeXml(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

// Every BPMN element of the given kinds, in document order, as
// { kind, id, name, sourceRef, targetRef }. Works with any namespace prefix.
function readElements(xml) {
  const kinds = 'startEvent|endEvent|exclusiveGateway|inclusiveGateway|parallelGateway|eventBasedGateway|complexGateway|' +
    'sequenceFlow|task|userTask|serviceTask|scriptTask|businessRuleTask|manualTask|sendTask|receiveTask|' +
    'intermediateThrowEvent|intermediateCatchEvent|subProcess|callActivity';
  const re = new RegExp('<(?:[\\w-]+:)?(' + kinds + ')\\b([^>]*?)/?>', 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    m[2].replace(/([\w:-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = decodeXml(v); });
    out.push({ kind: m[1], id: attrs.id, name: attrs.name || '', sourceRef: attrs.sourceRef, targetRef: attrs.targetRef });
  }
  return out;
}

// ---------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------

// "Q1.1 Question text? (Ch. 25 Sec. 13 Companies Act)" ->
// { question: "Question text?", citation: "Ch. 25 Sec. 13 Companies Act" }.
// Only a final bracket that looks like a legal reference counts as citation.
function splitQuestion(name) {
  let text = name.replace(/^Q?\d+(?:[._]\d+)*[a-z]?[.:)]?\s+/i, '');
  let citation = '';
  const m = /\s*\(([^()]*)\)\s*$/.exec(text);
  if (m && /\b(Ch\.|Chapter|Sec\.|Section|kap\.|§|Act|lagen|ABL)/i.test(m[1])) {
    citation = m[1].trim();
    text = text.slice(0, m.index).trim();
  }
  return { question: text, citation };
}

// A short label for a new outcome: the end event's text up to the first
// ";", " – " or "(" — e.g. "No duty to prepare a control balance sheet".
function shortLabel(name) {
  return name.split(/;|\s[–—-]\s|\s\(/)[0].trim();
}

function withPeriod(s) {
  return s && !/[.!?]$/.test(s) ? s + '.' : s;
}

// "No – defect: not convened" -> { answer: 'no', note: 'defect: not convened' }
function readBranch(flowName) {
  const m = /^\s*(yes|ja|true|no|nej|false)\b\s*(?:[–—:-]\s*(.*))?$/i.exec(flowName || '');
  if (!m) return null;
  return { answer: /^(yes|ja|true)$/i.test(m[1]) ? 'yes' : 'no', note: (m[2] || '').trim() };
}

// ---------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------

/**
 * Converts BPMN XML to a rules object, merging in the texts of `previous`
 * (the current rules.json, may be null). Returns { rules, errors, report }.
 */
function bpmnToRules(xml, previous) {
  const prev = previous || { meta: {}, attributes: [], nodes: {} };
  const prevNodes = prev.nodes || {};
  const prevAttrs = {};
  (prev.attributes || []).forEach((a) => { prevAttrs[a.id] = a; });

  const elements = readElements(xml);
  const byId = {};
  elements.forEach((e) => { byId[e.id] = e; });
  const flows = elements.filter((e) => e.kind === 'sequenceFlow');
  const outgoing = (id) => flows.filter((f) => f.sourceRef === id);
  const errors = [];

  // Follows a flow through pass-through elements (tasks, intermediate
  // events) to the next gateway or end event.
  function resolveTarget(id, seen) {
    const el = byId[id];
    if (!el) { errors.push('An arrow points to "' + id + '", which is not in the BPMN.'); return id; }
    if (el.kind === 'exclusiveGateway' || el.kind === 'endEvent') return id;
    const next = outgoing(id);
    if (next.length !== 1 || (seen || []).includes(id)) {
      errors.push('"' + id + '" (' + el.kind + ') must have exactly one outgoing arrow to be passed through.');
      return id;
    }
    return resolveTarget(next[0].targetRef, (seen || []).concat(id));
  }

  elements.filter((e) => /Gateway$/.test(e.kind) && e.kind !== 'exclusiveGateway')
    .forEach((e) => errors.push('"' + e.id + '" is a ' + e.kind + '; only exclusive (XOR) gateways can be converted.'));

  const starts = elements.filter((e) => e.kind === 'startEvent');
  if (starts.length !== 1) errors.push('The BPMN needs exactly one start event (found ' + starts.length + ').');
  const startFlows = starts.length ? outgoing(starts[0].id) : [];
  const start = startFlows.length === 1 ? resolveTarget(startFlows[0].targetRef) : '';
  if (starts.length === 1 && startFlows.length !== 1) errors.push('The start event must have exactly one outgoing arrow.');

  const nodes = {};
  const attributes = [];
  const usedAttrIds = new Set();
  const report = { added: [], removed: [], changed: [], needsSupportiveText: [], newVariables: [] };

  for (const el of elements) {
    if (el.kind === 'exclusiveGateway') {
      const old = prevNodes[el.id] && prevNodes[el.id].type === 'decision' ? prevNodes[el.id] : null;
      const { question, citation } = splitQuestion(el.name);
      const branches = {};
      const notes = [];
      for (const f of outgoing(el.id)) {
        const b = readBranch(f.name);
        if (!b) { errors.push('Gateway "' + el.id + '": the arrow to "' + f.targetRef + '" must be named "Yes…" or "No…" (it is "' + f.name + '").'); continue; }
        if (branches[b.answer]) { errors.push('Gateway "' + el.id + '" has two "' + b.answer + '" arrows.'); continue; }
        branches[b.answer] = resolveTarget(f.targetRef);
        if (b.note) notes.push('If ' + b.answer + ': ' + withPeriod(b.note));
      }
      if (!branches.yes || !branches.no) errors.push('Gateway "' + el.id + '" needs one "Yes" and one "No" arrow.');

      // The variable: reuse the old one for this node, else a new yes/no variable.
      let attr = old && prevAttrs[old.fact];
      if (!attr) {
        let id = el.id.toLowerCase();
        while (prevAttrs[id] || usedAttrIds.has(id)) id += '_';
        attr = { id, label: question, type: 'boolean', example: true, source: citation || undefined };
        if (!attr.source) delete attr.source;
        report.newVariables.push(id);
      }
      if (!usedAttrIds.has(attr.id)) { attributes.push(attr); usedAttrIds.add(attr.id); }

      const node = {
        type: 'decision',
        question,
        fact: attr.id,
        operator: 'equal',
        value: true,
        supportiveText: old ? old.supportiveText : ['TODO (stödtext).'].concat(notes).join(' '),
        citation: citation || (old && old.citation) || undefined,
        true: branches.yes,
        false: branches.no,
      };
      if (old && old.inputMode) node.inputMode = old.inputMode;
      Object.keys(node).forEach((k) => { if (node[k] === undefined || node[k] === '') delete node[k]; });
      if (!old || !old.supportiveText) report.needsSupportiveText.push(el.id);
      nodes[el.id] = node;
    } else if (el.kind === 'endEvent') {
      const old = prevNodes[el.id] && prevNodes[el.id].type === 'outcome' ? prevNodes[el.id] : null;
      nodes[el.id] = {
        type: 'outcome',
        label: (old && old.label) || shortLabel(el.name) || el.id,
        description: withPeriod(el.name) || (old && old.description) || '',
      };
    }
  }

  // What changed compared with the previous rules.json.
  for (const id of Object.keys(nodes)) {
    const old = prevNodes[id];
    if (!old) { report.added.push(id); continue; }
    const n = nodes[id];
    const diffs = [];
    if (old.type !== n.type) diffs.push('type');
    if (n.type === 'decision') {
      if (old.true !== n.true || old.false !== n.false) diffs.push('branches (' + old.true + '/' + old.false + ' → ' + n.true + '/' + n.false + ')');
      if (old.question !== n.question) diffs.push('question text');
      if ((old.citation || '') !== (n.citation || '')) diffs.push('citation');
    } else if ((old.description || '') !== n.description) diffs.push('description');
    if (diffs.length) report.changed.push(id + ': ' + diffs.join(', '));
  }
  report.removed = Object.keys(prevNodes).filter((id) => !nodes[id]);

  const rules = {};
  rules.meta = Object.assign({}, prev.meta || {});
  if (!rules.meta.title) rules.meta.title = (starts[0] && starts[0].name) || 'Imported rules';
  for (const key of Object.keys(prev)) {
    if (!['meta', 'attributes', 'start', 'nodes'].includes(key)) rules[key] = prev[key]; // glossary, constants, …
  }
  rules.attributes = attributes;
  rules.start = start;
  rules.nodes = nodes;
  return { rules, errors: [...new Set(errors)], report };
}

// ---------------------------------------------------------------------
// Writing rules.json in the project's layout (one variable / node per line)
// ---------------------------------------------------------------------

function inline(v) {
  if (Array.isArray(v)) return '[' + v.map(inline).join(', ') + ']';
  if (v && typeof v === 'object') return '{ ' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ': ' + inline(x)).join(', ') + ' }';
  return JSON.stringify(v);
}

function formatRules(rules) {
  const parts = Object.entries(rules).map(([key, value]) => {
    let body;
    if (key === 'attributes' || key === 'glossary') body = '[\n' + value.map((x) => '    ' + inline(x)).join(',\n') + '\n  ]';
    else if (key === 'nodes') {
      // A blank line before each question groups it with the outcomes it leads to.
      body = '{\n' + Object.entries(value).map(([id, n], i) =>
        (i > 0 && n.type === 'decision' ? '\n' : '') + '    ' + JSON.stringify(id) + ': ' + inline(n)).join(',\n') + '\n  }';
    }
    else body = JSON.stringify(value, null, 2).replace(/\n/g, '\n  ');
    return '  ' + JSON.stringify(key) + ': ' + body;
  });
  return '{\n' + parts.join(',\n') + '\n}\n';
}

// ---------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const bpmnFile = args[0];
  const outIndex = args.indexOf('--out');
  const outFile = outIndex >= 0 ? args[outIndex + 1] : path.join(__dirname, '..', 'rules.json');
  if (!bpmnFile || (outIndex >= 0 && !outFile)) {
    console.error('Usage: npm run import:bpmn -- <file.bpmn> [--out <rules.json>]');
    process.exit(2);
  }

  const previous = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
  const { rules, errors, report } = bpmnToRules(fs.readFileSync(bpmnFile, 'utf8'), previous);
  if (errors.length) {
    console.error('Could not convert ' + bpmnFile + ':\n' + errors.map((e) => '  - ' + e).join('\n'));
    process.exit(1);
  }

  fs.writeFileSync(outFile, formatRules(rules));
  const count = (type) => Object.values(rules.nodes).filter((n) => n.type === type).length;
  console.log('Wrote ' + outFile + ': ' + count('decision') + ' questions, ' + count('outcome') + ' outcomes, ' + rules.attributes.length + ' variables.');
  const list = (title, items) => { if (items.length) console.log('\n' + title + ' (' + items.length + '):\n' + items.map((i) => '  - ' + i).join('\n')); };
  list('New nodes', report.added);
  list('Removed nodes', report.removed);
  list('Changed nodes', report.changed);
  list('New variables (yes/no; check type, label and example in the data dictionary)', report.newVariables);
  list('Questions without supportive text (stödtext)', report.needsSupportiveText);

  const { errors: ruleErrors, warnings } = RaC.validateRules(rules);
  list('Validation errors', ruleErrors);
  list('Validation warnings', warnings);
  console.log('\nNext: review the changes (git diff), then run "npm run build:docs" and "npm test".');
  process.exit(ruleErrors.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { bpmnToRules, formatRules };
