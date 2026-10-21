/**
 * bpmn.js
 * BPMN importer: turns the decision tree drawn in BPMN (e.g. bpmn.io or
 * Camunda Modeler) into a rules object, keeping every node ID. Used by the
 * Author view's "Upload BPMN" button and by `npm run import:bpmn`.
 *
 * Mapping:
 *   exclusive gateway   -> decision node, asked as a yes/no question
 *                          ("Q1.1 Question text? (citation)" -> question + citation)
 *   arrows "Yes…"/"No…" -> the node's true / false targets; any note after
 *                          the dash ("No – defect: …") goes into a new node's
 *                          supportive text; a note with "defect" on an arrow
 *                          that leads on to another question becomes a
 *                          warning shown on the result ("warnings")
 *   end event           -> outcome node (its name becomes the description)
 *   start event         -> "start"
 *   other tasks/events with one outgoing arrow are passed through.
 *
 * The BPMN holds the legal logic, so questions, citations, branches and
 * outcome descriptions always come from it. Texts the BPMN doesn't have are
 * kept from the previous rules for every node ID that still exists: meta,
 * glossary, short outcome labels, supportive texts and the variables (data
 * dictionary). New questions get a yes/no variable and a "TODO (stödtext)"
 * marker so the Law team sees what still needs writing.
 *
 * No DOM or Node APIs, so it runs in both (like logic.js).
 */

// Export for both environments: module.exports in Node, window.RaCBpmn in the browser.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.RaCBpmn = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

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
    const kinds = 'process|startEvent|endEvent|exclusiveGateway|inclusiveGateway|parallelGateway|eventBasedGateway|complexGateway|' +
      'sequenceFlow|task|userTask|serviceTask|scriptTask|businessRuleTask|manualTask|sendTask|receiveTask|' +
      'intermediateThrowEvent|intermediateCatchEvent|subProcess|callActivity';
    // Attribute values may contain ">", so quoted strings are matched as a whole.
    const re = new RegExp('<(?:[\\w-]+:)?(' + kinds + ')\\b((?:[^>"]|"[^"]*")*?)/?>', 'g');
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
    // The numbering is "Q1", "Q1.1", "Q4_1a" or "1.1"; a plain number such as
    // "2 weeks …" belongs to the question.
    let text = name.replace(/^(?:Q\s?\d+(?:[._]\d+)*[a-z]?|\d+(?:[._]\d+)+[a-z]?)[.:)]?\s+/i, '');
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
    const report = {
      added: [], removed: [], changed: [], needsSupportiveText: [], newVariables: [], reviewLabels: [], newOutcomeLabels: [],
      // What came from the previous rules rather than the BPMN (see importReport).
      kept: { supportiveText: 0, outcomeLabels: 0, variables: 0, glossary: (prev.glossary || []).length, metaTexts: 0 },
    };

    for (const el of elements) {
      if (el.kind === 'exclusiveGateway') {
        const old = prevNodes[el.id] && prevNodes[el.id].type === 'decision' ? prevNodes[el.id] : null;
        const { question, citation } = splitQuestion(el.name);
        const branches = {};
        const notes = [];
        const warnings = {};
        for (const f of outgoing(el.id)) {
          const b = readBranch(f.name);
          if (!b) { errors.push('Gateway "' + el.id + '": the arrow to "' + f.targetRef + '" must be named "Yes…" or "No…" (it is "' + f.name + '").'); continue; }
          if (branches[b.answer]) { errors.push('Gateway "' + el.id + '" has two "' + b.answer + '" arrows.'); continue; }
          branches[b.answer] = resolveTarget(f.targetRef);
          if (b.note) notes.push('If ' + b.answer + ': ' + withPeriod(b.note));
          // A defect on an arrow that continues to the next question would
          // otherwise be lost, so it is shown as a warning on the result.
          if (/\bdefect\b/i.test(b.note) && byId[branches[b.answer]] && byId[branches[b.answer]].kind === 'exclusiveGateway') {
            warnings[b.answer === 'yes' ? 'true' : 'false'] = withPeriod(b.note.charAt(0).toUpperCase() + b.note.slice(1));
          }
        }
        if (!branches.yes || !branches.no) errors.push('Gateway "' + el.id + '" needs one "Yes" and one "No" arrow.');

        // The variable: reuse the old one for this node, else a new yes/no variable.
        let attr = old && prevAttrs[old.fact] ? Object.assign({}, prevAttrs[old.fact]) : null;
        if (attr) {
          // Keep the data dictionary in step with the BPMN: a source or label
          // that copied the old citation or question follows the new one; a
          // label written by hand is kept but listed for review.
          if (citation && old.citation !== citation && attr.source === old.citation) attr.source = citation;
          if (old.question !== question) {
            if (attr.label === old.question) attr.label = question;
            else report.reviewLabels.push(attr.id + ' (question ' + el.id + ' changed)');
          }
        } else {
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
          warnings: Object.keys(warnings).length ? warnings : undefined,
        };
        if (old && old.inputMode) node.inputMode = old.inputMode;
        Object.keys(node).forEach((k) => { if (node[k] === undefined || node[k] === '') delete node[k]; });
        if (!old || !old.supportiveText) report.needsSupportiveText.push(el.id);
        else report.kept.supportiveText++;
        if (old && prevAttrs[old.fact]) report.kept.variables++;
        nodes[el.id] = node;
      } else if (el.kind === 'endEvent') {
        const old = prevNodes[el.id] && prevNodes[el.id].type === 'outcome' ? prevNodes[el.id] : null;
        if (old && old.label) report.kept.outcomeLabels++;
        else report.newOutcomeLabels.push(el.id + ': "' + (shortLabel(el.name) || el.id) + '"');
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
        if (JSON.stringify(old.warnings || {}) !== JSON.stringify(n.warnings || {})) diffs.push('defect warnings');
        if (old.question !== n.question) diffs.push('question text');
        if ((old.citation || '') !== (n.citation || '')) diffs.push('citation');
      } else if ((old.description || '') !== n.description) diffs.push('description');
      if (diffs.length) report.changed.push(id + ': ' + diffs.join(', '));
    }
    report.removed = Object.keys(prevNodes).filter((id) => !nodes[id]);

    const rules = {};
    rules.meta = Object.assign({}, prev.meta || {});
    report.kept.metaTexts = ['title', 'shortTitle', 'subtitle', 'intro', 'audience', 'disclaimer']
      .filter((k) => rules.meta[k]).length;
    const proc = elements.find((e) => e.kind === 'process' && e.name);
    if (!rules.meta.title) rules.meta.title = (proc && proc.name) || (starts[0] && starts[0].name) || 'Imported rules';
    for (const key of Object.keys(prev)) {
      if (!['meta', 'attributes', 'start', 'nodes'].includes(key)) rules[key] = prev[key]; // glossary, constants, …
    }
    rules.attributes = attributes;
    rules.start = start;
    rules.nodes = nodes;
    return { rules, errors: [...new Set(errors)], report };
  }

  // ---------------------------------------------------------------------
  // Import report
  // ---------------------------------------------------------------------

  // The result of an import as readable text, in three parts: what came
  // from the BPMN, what was kept from the previous rules (the texts the BPMN
  // doesn't hold), and what still has to be added in the Build tab.
  // `validation` is validateRules() of the new rules.
  function importReport(rules, report, validation) {
    const count = (type) => Object.values(rules.nodes).filter((n) => n.type === type).length;
    const lines = [count('decision') + ' questions, ' + count('outcome') + ' outcomes, ' + rules.attributes.length + ' variables.'];
    const list = (title, items) => {
      if (items && items.length) lines.push('', title + ' (' + items.length + '):', ...items.map((i) => '  - ' + i));
    };

    lines.push('', 'From the BPMN: the questions with their citations and Yes/No branches, the defect warnings on the arrows, the outcome descriptions and the start.');

    const k = report.kept || {};
    const kept = [];
    if (k.supportiveText) kept.push('st\u00f6dtext for ' + k.supportiveText + ' questions');
    if (k.outcomeLabels) kept.push(k.outcomeLabels + ' short outcome labels');
    if (k.variables) kept.push(k.variables + ' variables (data dictionary)');
    if (k.glossary) kept.push('the glossary (' + k.glossary + ' terms)');
    if (k.metaTexts) kept.push('the title and intro texts');
    lines.push('', kept.length
      ? 'Kept from the current rules (texts the BPMN does not hold): ' + kept.join(', ') + '.'
      : 'Nothing was kept from the current rules: this is a new rule set.');

    list('New nodes', report.added);
    list('Removed nodes', report.removed);
    list('Changed nodes', report.changed);
    list('Variable labels to review (their question changed in the BPMN)', report.reviewLabels);

    const openGlossary = (rules.glossary || []).filter((g) => g && g.term && !String(g.definition || '').trim()).map((g) => g.term);
    const todo = (report.needsSupportiveText || []).length + (report.newOutcomeLabels || []).length +
      (report.newVariables || []).length + openGlossary.length;
    if (todo) {
      lines.push('', 'Still to add in the Build tab:');
      list('Questions without supportive text (st\u00f6dtext)', report.needsSupportiveText);
      list('New outcomes: check the short label taken from the BPMN', report.newOutcomeLabels);
      list('New variables: check label and example', report.newVariables);
      list('Glossary terms without a definition', openGlossary);
    }
    if (validation) {
      list('Validation errors', validation.errors);
      list('Validation warnings', validation.warnings.filter((w) => !/^Glossary term .*no definition yet/.test(w)));
    }
    lines.push('', 'Upload BPMN updates the current rule set. For a different law, click New first, then Upload BPMN.');
    return lines.join('\n');
  }

  return { bpmnToRules, importReport };
});
