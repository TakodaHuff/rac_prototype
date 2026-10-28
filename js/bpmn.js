/**
 * bpmn.js
 * BPMN import and export. bpmnToRules turns a decision tree drawn in BPMN
 * (e.g. bpmn.io or Camunda Modeler) into a rules object, keeping every node
 * ID; it is used by "Upload BPMN" and `npm run import:bpmn`. rulesToBpmn
 * does the reverse for "Download BPMN": it draws the current rules as a BPMN
 * diagram, so edits made in the Build tab are in the downloaded file.
 *
 * Mapping:
 *   exclusive gateway   -> decision node, asked as a yes/no question
 *                          ("Q1.1 Question text? (citation)" -> question + citation).
 *                          An optional "[name]" names its yes/no variable;
 *                          "[age >= 20 years]" makes it a number question
 *                          (Yes = the condition holds). Gateways with the same
 *                          variable, or the same question text, share one
 *                          variable, so the user is asked only once.
 *   arrows "Yes…"/"No…" -> the node's true / false targets ("Yes", "Yes – note",
 *                          "Yes, note" and "Yes: note" all work); any note goes
 *                          into a new node's supportive text; a note with
 *                          "defect" on an arrow that leads on to another
 *                          question becomes a warning shown on the result
 *   end event           -> outcome node (its name becomes the description; an
 *                          unnamed one takes the text of the arrow or task
 *                          leading into it)
 *   start event         -> "start"
 *   text annotation     -> rule-set texts, one per line: "Law text: <url>",
 *                          "Legal source: …", "Intro: …", "Who it is for: …",
 *                          "Disclaimer: …"
 *   other tasks/events with one outgoing arrow are passed through.
 *
 * The BPMN holds the legal logic, so questions, citations, branches and
 * outcome descriptions always come from it. Texts the diagram doesn't show
 * are kept from the previous rules for every node ID that still exists:
 * meta, glossary, short outcome labels, supportive texts and the variables
 * (data dictionary). A BPMN made by Download BPMN carries those texts itself
 * (the full rules, inside <extensionElements>), so uploading it again gives
 * back exactly the rules it was made from; what the diagram shows still
 * wins, so a question renamed in a BPMN editor is renamed in the rules too.
 * New questions get a yes/no variable; the import report lists the ones
 * still without a supportive text.
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

  function unescapeXml(s) {
    return String(s || '')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  function decodeXml(s, keepLines) {
    const text = unescapeXml(s);
    return keepLines
      ? text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
      : text.replace(/\s+/g, ' ').trim();
  }

  // The text of every text annotation, line breaks kept.
  function readAnnotations(xml) {
    const out = [];
    const re = /<(?:[\w-]+:)?textAnnotation\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?textAnnotation>/g;
    let m;
    while ((m = re.exec(xml))) {
      const t = /<(?:[\w-]+:)?text\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?text>/.exec(m[1]);
      if (t) out.push(decodeXml(t[1], true));
    }
    return out;
  }

  // Rule-set texts written in text annotations, one "Key: value" per line
  // (a line without a known key continues the previous value).
  const META_KEYS = {
    'law text': 'lawUrl', 'law url': 'lawUrl', 'law link': 'lawUrl',
    'legal source': 'legalSource', 'title': 'title', 'short title': 'shortTitle', 'subtitle': 'subtitle',
    'intro': 'intro', 'what this tool checks': 'intro',
    'audience': 'audience', 'who it is for': 'audience', 'disclaimer': 'disclaimer',
  };
  function metaFromAnnotations(texts) {
    const meta = {};
    texts.forEach((text) => {
      let key = null;
      text.split('\n').forEach((line) => {
        const m = /^([A-Za-z ]+):\s*(.*)$/.exec(line);
        const k = m && META_KEYS[m[1].trim().toLowerCase()];
        if (k) { key = k; meta[k] = m[2]; } else if (key) meta[key] = (meta[key] + ' ' + line).trim();
      });
    });
    return meta;
  }

  // The rules saved inside a BPMN by Download BPMN (rulesToBpmn): a
  // <rac:rules> element in the process's <extensionElements>. null if absent.
  const RAC_NS = 'https://takodahuff.github.io/rac_prototype/rules';
  function readEmbeddedRules(xml) {
    const re = /<([\w-]+):rules\b[^>]*>([\s\S]*?)<\/\1:rules>/g;
    let m;
    while ((m = re.exec(xml))) {
      if (!new RegExp('xmlns:' + m[1] + '="' + RAC_NS.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '"').test(xml)) continue;
      const body = m[2].replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, '$1');
      try {
        const rules = JSON.parse(/^\s*<!\[CDATA\[/.test(m[2]) ? body : unescapeXml(body));
        if (rules && typeof rules === 'object' && rules.nodes) return rules;
      } catch (e) { /* not ours, or damaged: import from the diagram alone */ }
    }
    return null;
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
  // "[age >= 20 years]" -> { name: 'age', operator: 'greaterThanInclusive', value: 20, unit: 'years' };
  // "[visibly_intoxicated]" -> { name: 'visibly_intoxicated' } (a yes/no variable).
  const OPERATORS = { '>=': 'greaterThanInclusive', '≥': 'greaterThanInclusive', '>': 'greaterThan',
    '<=': 'lessThanInclusive', '≤': 'lessThanInclusive', '<': 'lessThan', '=': 'equal', '==': 'equal', '!=': 'notEqual', '≠': 'notEqual' };
  function readVariable(name) {
    const m = /\[\s*([A-Za-z_][\w]*)\s*(?:(>=|<=|==|!=|≥|≤|≠|>|<|=)\s*(-?\d+(?:[.,]\d+)?)\s*([^\]]*?))?\s*\]/.exec(name || '');
    if (!m) return { text: name || '', variable: null };
    const variable = { name: m[1] };
    if (m[2]) {
      variable.operator = OPERATORS[m[2]];
      variable.value = Number(m[3].replace(',', '.'));
      if (m[4].trim()) variable.unit = m[4].trim();
    }
    return { text: (name.slice(0, m.index) + ' ' + name.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim(), variable };
  }

  function splitQuestion(name, keepNumber) {
    const { text: withoutVariable, variable } = readVariable(name);
    // The numbering is "Q1", "Q1.1", "Q4_1a" or "1.1"; a plain number such as
    // "2 weeks …" belongs to the question.
    let text = keepNumber ? withoutVariable : withoutVariable.replace(/^(?:Q\s?\d+(?:[._]\d+)*[a-z]?|\d+(?:[._]\d+)+[a-z]?)[.:)]?\s+/i, '');
    let citation = '';
    const m = /\s*\(([^()]*)\)\s*$/.exec(text);
    if (m && /\b(Ch\.|Chapter|Sec\.|Section|kap\.|§|Act|lagen|ABL)/i.test(m[1])) {
      citation = m[1].trim();
      text = text.slice(0, m.index).trim();
    }
    return { question: text, citation, variable };
  }

  // A short label for a new outcome: the end event's text up to the first
  // ";", " – " or "(" — e.g. "No duty to prepare a control balance sheet".
  function shortLabel(name) {
    return name.split(/;|\s[–—-]\s|\s\(/)[0].trim();
  }

  function withPeriod(s) {
    return s && !/[.!?]$/.test(s) ? s + '.' : s;
  }

  // Equal apart from spacing and a final full stop.
  function sameText(a, b) {
    const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
    return norm(a) === norm(b);
  }

  // "No – defect: not convened" -> { answer: 'no', note: 'defect: not convened' }.
  // A comma, colon or full stop after Yes / No works too ("Yes, 20 or older").
  function readBranch(flowName) {
    const m = /^\s*(yes|ja|true|no|nej|false)\b\s*(?:[–—:,.;-]\s*(.*))?$/i.exec(flowName || '');
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
    // A BPMN from Download BPMN carries its own rules: those come first.
    const embedded = readEmbeddedRules(xml);
    const prev = embedded || previous || { meta: {}, attributes: [], nodes: {} };
    const prevNodes = prev.nodes || {};
    const prevAttrs = {};
    (prev.attributes || []).forEach((a) => { prevAttrs[a.id] = a; });

    const elements = readElements(xml);
    const byId = {};
    elements.forEach((e) => { byId[e.id] = e; });
    const flows = elements.filter((e) => e.kind === 'sequenceFlow');
    const outgoing = (id) => flows.filter((f) => f.sourceRef === id);
    const errors = [];
    // How an element is named in messages: its text, else its ID.
    const describe = (id) => (byId[id] && byId[id].name ? '"' + byId[id].name + '"' : '"' + id + '"');

    // An unnamed end event takes the text of an arrow or task leading into it.
    function nameFromIncoming(id) {
      for (const f of flows.filter((x) => x.targetRef === id)) {
        // An arrow's text, or the note on a Yes/No arrow ("No – too young").
        const branch = f.name ? readBranch(f.name) : null;
        if (f.name && (!branch || branch.note)) return branch ? branch.note : f.name;
        const source = byId[f.sourceRef];
        if (source && source.name && !/Gateway$|Event$/.test(source.kind)) return source.name;
      }
      return '';
    }

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
    const createdAttrs = {}; // variable id -> variable, for sharing between gateways
    const sharedByQuestion = {}; // question text (lower case) -> variable id
    const report = {
      added: [], removed: [], changed: [], needsSupportiveText: [], newVariables: [], reviewLabels: [], newOutcomeLabels: [],
      // What came from the previous rules rather than the BPMN (see importReport).
      kept: { supportiveText: 0, outcomeLabels: 0, variables: 0, glossary: (prev.glossary || []).length, metaTexts: 0 },
      embedded: !!embedded,
    };

    for (const el of elements) {
      if (el.kind === 'exclusiveGateway') {
        const old = prevNodes[el.id] && prevNodes[el.id].type === 'decision' ? prevNodes[el.id] : null;
        let { question, citation, variable } = splitQuestion(el.name);
        if (old) {
          // Keep a question that starts with a number ("1.5 million …") or
          // ends with a citation the pattern below doesn't know ("Art. 6 GDPR").
          const whole = splitQuestion(el.name, true);
          if (whole.question === old.question || (old.citation && whole.question === old.question + ' (' + old.citation + ')')) question = old.question;
          if (!citation && old.citation && question === old.question && whole.question.endsWith('(' + old.citation + ')')) citation = old.citation;
        }
        const label = '"' + (question || el.id) + '" (' + el.id + ')';
        const branches = {};
        const notes = [];
        const warnings = {};
        for (const f of outgoing(el.id)) {
          const b = readBranch(f.name);
          if (!b) {
            errors.push('The arrow from ' + label + ' to ' + describe(f.targetRef) + ' is named "' + (f.name || '') +
              '". Arrows leaving a question must start with Yes or No, for example "Yes – 20 or older".');
            continue;
          }
          if (branches[b.answer]) { errors.push(label + ' has two "' + b.answer + '" arrows; it needs one Yes and one No.'); continue; }
          branches[b.answer] = resolveTarget(f.targetRef);
          if (b.note) notes.push('If ' + b.answer + ': ' + withPeriod(b.note));
          // A defect on an arrow that continues to the next question would
          // otherwise be lost, so it is shown as a warning on the result.
          // A note that is the warning saved for this branch stays one.
          const key = b.answer === 'yes' ? 'true' : 'false';
          const oldWarning = old && old.warnings && old.warnings[key];
          if (b.note && oldWarning && sameText(oldWarning, b.note)) warnings[key] = oldWarning;
          else if (/\bdefect\b/i.test(b.note) && byId[branches[b.answer]] && byId[branches[b.answer]].kind === 'exclusiveGateway') {
            warnings[key] = withPeriod(b.note.charAt(0).toUpperCase() + b.note.slice(1));
          }
        }
        if (!branches.yes || !branches.no) errors.push(label + ' needs one arrow starting with Yes and one starting with No.');

        // The variable. A named one ("[age >= 20 years]", "[name]") and one
        // already made for the same question text are shared between
        // gateways, so the user is asked only once. Otherwise: the old one
        // for this node, or a new yes/no variable.
        const numeric = !!(variable && variable.operator);
        let attr = null;
        const sharedId = variable ? variable.name : (!old && sharedByQuestion[question.toLowerCase()]);
        if (sharedId && createdAttrs[sharedId]) {
          attr = createdAttrs[sharedId];
          if ((attr.type === 'number') !== numeric) errors.push(label + ': the variable "' + sharedId + '" is used both as a number and as yes/no.');
        } else if (variable) {
          attr = prevAttrs[variable.name] ? Object.assign({}, prevAttrs[variable.name]) : null;
          if (!attr) {
            attr = numeric
              ? { id: variable.name, label: question, type: 'number', min: 0, example: variable.value }
              : { id: variable.name, label: question, type: 'boolean', example: true };
            if (variable.unit) attr.unit = variable.unit;
            if (citation) attr.source = citation;
            report.newVariables.push(attr.id);
          }
        } else if (old && prevAttrs[old.fact]) {
          attr = Object.assign({}, prevAttrs[old.fact]);
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
        createdAttrs[attr.id] = attr;
        if (!variable && !sharedByQuestion[question.toLowerCase()]) sharedByQuestion[question.toLowerCase()] = attr.id;
        if (!usedAttrIds.has(attr.id)) { attributes.push(attr); usedAttrIds.add(attr.id); }

        const node = {
          type: 'decision',
          question,
          fact: attr.id,
          // A comparison the diagram can't show (e.g. "equal false", or an
          // option of a list) is kept from the previous rules.
          operator: numeric ? variable.operator : (old && old.fact === attr.id && old.operator) || 'equal',
          value: numeric ? variable.value : (old && old.fact === attr.id && old.operator ? old.value : true),
          supportiveText: old ? old.supportiveText : notes.join(' '),
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
        const name = el.name || nameFromIncoming(el.id);
        if (old && old.label) report.kept.outcomeLabels++;
        else report.newOutcomeLabels.push(el.id + ': "' + (shortLabel(name) || el.id) + '"');
        nodes[el.id] = {
          type: 'outcome',
          label: (old && old.label) || shortLabel(name) || el.id,
          description: !old ? withPeriod(name) || ''
            : sameText(name, old.description) ? old.description
            : !old.description && sameText(name, old.label) ? ''
            : withPeriod(name) || old.description || '',
        };
        // An outcome without a description stays without one.
        if (!nodes[el.id].description && !(old && old.description === '')) delete nodes[el.id].description;
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
    // Texts written in text annotations ("Law text: …", "Intro: …") replace
    // the old ones: like the questions, they live in the BPMN.
    const fromAnnotations = metaFromAnnotations(readAnnotations(xml));
    if (Object.keys(fromAnnotations).length) {
      // The text box holds these texts, so one deleted there is deleted.
      ANNOTATION_KEYS.forEach(([k]) => { if (!(k in fromAnnotations)) delete rules.meta[k]; });
    }
    Object.keys(fromAnnotations).forEach((k) => {
      if (!sameText(fromAnnotations[k], rules.meta[k])) rules.meta[k] = fromAnnotations[k];
    });
    if (!rules.meta.title) delete rules.meta.title;
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
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------
  // Export: rules -> BPMN (Download BPMN)
  // ---------------------------------------------------------------------

  // The rule-set texts written in the diagram's text box (read back by
  // metaFromAnnotations).
  const ANNOTATION_KEYS = [['title', 'Title'], ['lawUrl', 'Law text'], ['legalSource', 'Legal source'],
    ['intro', 'Intro'], ['audience', 'Who it is for'], ['disclaimer', 'Disclaimer']];
  const SYMBOLS = { greaterThanInclusive: '>=', greaterThan: '>', lessThanInclusive: '<=', lessThan: '<', equal: '=', notEqual: '!=' };

  function escapeXml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function oneLine(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  // Rough height of a label wrapped to `width` pixels (bpmn.io: 11px Arial).
  function textHeight(text, width, lineHeight) {
    const perLine = Math.max(8, Math.floor(width / 6.2));
    let lines = 0;
    String(text || '').split('\n').forEach((para) => {
      let len = 0;
      lines++;
      para.split(/\s+/).filter(Boolean).forEach((w) => {
        if (len && len + 1 + w.length > perLine) { lines++; len = w.length; } else len += (len ? 1 : 0) + w.length;
        while (len > perLine) { lines++; len -= perLine; }
      });
    });
    return lines * lineHeight;
  }

  // Columns from left to right: each node one column after the furthest
  // question leading to it. An arrow that skips columns gets a waypoint in
  // each column it crosses, so it never runs through a node. In a column,
  // nodes and waypoints sit level with the question they come from where
  // there is room (the Yes branch first), else below.
  // Returns { place: id -> { cx, cy, size, labelHeight }, routes: "from>to" -> [[x, y], …] }.
  function layoutTree(nodes, start, labelOf) {
    const ids = Object.keys(nodes);
    const children = (id) => (nodes[id].type === 'decision' ? [nodes[id].true, nodes[id].false] : [])
      .filter((t, i, a) => t && nodes[t] && a.indexOf(t) === i);
    const column = {};
    ids.forEach((id) => { column[id] = 0; });
    for (let pass = 0; pass < ids.length; pass++) {
      let changed = false;
      ids.forEach((id) => children(id).forEach((c) => {
        if (column[c] < column[id] + 1 && column[id] + 1 < ids.length) { column[c] = column[id] + 1; changed = true; }
      }));
      if (!changed) break;
    }

    // The graph with waypoints ("~" ids) on arrows that skip columns.
    const next = {};
    const chains = {};
    ids.forEach((id) => { next[id] = []; });
    ids.forEach((id) => children(id).forEach((c) => {
      let from = id;
      const chain = [];
      for (let k = column[id] + 1; k < column[c]; k++) {
        const w = '~' + id + '>' + c + '~' + k;
        column[w] = k; next[w] = []; chain.push(w);
        next[from].push(w); from = w;
      }
      next[from].push(c);
      chains[id + '>' + c] = chain;
    }));
    const all = Object.keys(next);
    const parents = {};
    all.forEach((id) => { parents[id] = []; });
    all.forEach((id) => next[id].forEach((c) => { if (!parents[c].includes(id)) parents[c].push(id); }));

    const order = [];
    const seen = new Set();
    const visit = (id) => {
      const stack = [id];
      while (stack.length) {
        const x = stack.pop();
        if (seen.has(x)) continue;
        seen.add(x); order.push(x);
        next[x].slice().reverse().forEach((c) => stack.push(c));
      }
    };
    if (nodes[start]) visit(start);
    ids.filter((id) => !parents[id].length).forEach(visit);
    all.forEach(visit);

    const isWaypoint = (id) => id.charAt(0) === '~';
    const size = (id) => (isWaypoint(id) ? 0 : nodes[id].type === 'decision' ? 50 : 36);
    const place = {};
    const columns = Math.max(0, ...all.map((id) => column[id])) + 1;
    for (let c = 0; c < columns; c++) {
      const inColumn = order.filter((id) => column[id] === c).map((id, i) => {
        const placed = parents[id].filter((p) => place[p]);
        const want = placed.length ? Math.min(...placed.map((p) => place[p].cy)) : null;
        return { id, i, want };
      });
      inColumn.sort((a, b) => (a.want === null) - (b.want === null) || (a.want || 0) - (b.want || 0) || a.i - b.i);
      let bottom = 0;
      inColumn.forEach(({ id, want }) => {
        const half = size(id) / 2;
        const labelHeight = isWaypoint(id) ? 0 : textHeight(labelOf(id), 90, 14);
        const cy = Math.max(want === null ? bottom + half : want, bottom + half + (isWaypoint(id) ? 12 : 0));
        place[id] = { cx: c * 210, cy, size: size(id), labelHeight };
        bottom = cy + half + (isWaypoint(id) ? 12 : 8 + labelHeight + 40);
      });
    }
    const routes = {};
    Object.keys(chains).forEach((k) => { routes[k] = chains[k].map((w) => [place[w].cx, place[w].cy]); });
    ids.forEach((id) => { place[id].column = column[id]; });
    return { place, routes };
  }

  /**
   * Draws `rules` as a BPMN 2.0 diagram (with layout) that bpmnToRules reads
   * back as the same rules. Every rule text is in the diagram or, for what
   * the diagram doesn't show (variables, supportive texts, glossary, short
   * labels), in the embedded copy of the rules.
   */
  function rulesToBpmn(input) {
    const rules = JSON.parse(JSON.stringify(input || {}));
    rules.nodes = rules.nodes || {};
    if (rules.meta) delete rules.meta.bpmnFile;

    // Node IDs become BPMN IDs, which must be XML names; others are renamed.
    const taken = new Set(['Definitions_rules', 'Process_rules', 'StartEvent', 'Flow_start', 'RulesInfo', 'Diagram_rules', 'Plane_rules']);
    const rename = {};
    Object.keys(rules.nodes).forEach((id) => {
      let x = /^[A-Za-z_][\w.-]*$/.test(id) && !taken.has(id) ? id : 'Node_' + id.replace(/[^\w.-]/g, '_');
      while (taken.has(x)) x += '_';
      taken.add(x);
      rename[id] = x;
    });
    const renamed = {};
    Object.keys(rules.nodes).forEach((id) => {
      const n = Object.assign({}, rules.nodes[id]);
      if (n.type === 'decision') { n.true = rename[n.true] || n.true; n.false = rename[n.false] || n.false; }
      renamed[rename[id]] = n;
    });
    rules.nodes = renamed;
    rules.start = rename[rules.start] || rules.start;
    const nodes = rules.nodes;
    const ids = Object.keys(nodes);
    const attrs = {};
    (rules.attributes || []).forEach((a) => { if (a && a.id) attrs[a.id] = a; });
    // Questions asked with different words but about the same yes/no
    // variable get "[variable]", so the import shares it (the same words
    // are shared anyway).
    const wording = {};
    ids.forEach((id) => {
      if (nodes[id].type !== 'decision') return;
      (wording[nodes[id].fact] = wording[nodes[id].fact] || new Set()).add(oneLine(nodes[id].question).toLowerCase());
    });

    function gatewayName(id) {
      const n = nodes[id];
      const attr = attrs[n.fact];
      let name = oneLine(n.question) || id;
      const simple = /^[A-Za-z_]\w*$/.test(n.fact || '');
      if (simple && attr && attr.type === 'number' && SYMBOLS[n.operator] && typeof n.value === 'number') {
        name += ' [' + n.fact + ' ' + SYMBOLS[n.operator] + ' ' + n.value + (attr.unit ? ' ' + oneLine(attr.unit) : '') + ']';
      } else if (simple && wording[n.fact].size > 1) {
        name += ' [' + n.fact + ']';
      }
      if (n.citation) name += ' (' + oneLine(n.citation) + ')';
      return name;
    }
    const isDecision = (id) => nodes[id] && nodes[id].type === 'decision';
    const nameOf = (id) => (isDecision(id) ? gatewayName(id) : oneLine(nodes[id].description) || oneLine(nodes[id].label) || id);

    const flows = [];
    const flowId = (from, answer) => { let x = 'Flow_' + from + '_' + answer; while (taken.has(x)) x += '_'; taken.add(x); return x; };
    ids.filter(isDecision).forEach((id) => {
      const n = nodes[id];
      [['true', 'Yes'], ['false', 'No']].forEach(([key, answer]) => {
        if (!n[key] || !nodes[n[key]]) return;
        const warning = n.warnings && n.warnings[key];
        flows.push({ id: flowId(id, answer.toLowerCase()), from: id, to: n[key], name: answer + (warning ? ' – ' + oneLine(warning) : '') });
      });
    });
    if (nodes[rules.start]) flows.unshift({ id: 'Flow_start', from: 'StartEvent', to: rules.start, name: '' });

    // Layout. The text box sits above the tree, the start event left of it.
    const meta = rules.meta || {};
    const info = ANNOTATION_KEYS.filter(([k]) => oneLine(meta[k])).map(([k, label]) => label + ': ' + oneLine(meta[k])).join('\n');
    const infoWidth = 420;
    const infoHeight = info ? textHeight(info, infoWidth - 10, 14) + 14 : 0;
    const left = 160;
    const top = 40 + (info ? infoHeight + 60 : 0);
    const { place, routes } = layoutTree(nodes, rules.start, nameOf);
    const startCy = nodes[rules.start] ? place[rules.start].cy : 0;
    const bounds = {};
    ids.forEach((id) => {
      const p = place[id];
      const x = left + 130 + p.cx;
      const y = top + p.cy;
      bounds[id] = { x: x - p.size / 2, y: y - p.size / 2, w: p.size, h: p.size, cx: x, cy: y, labelHeight: p.labelHeight };
    });
    bounds.StartEvent = { x: left - 18, y: top + startCy - 18, w: 36, h: 36, cx: left, cy: top + startCy, labelHeight: 14 };

    const r = (v) => Math.round(v);
    const out = [];
    const push = (indent, line) => out.push('  '.repeat(indent) + line);
    push(0, '<?xml version="1.0" encoding="UTF-8"?>');
    push(0, '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" ' +
      'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:rac="' + RAC_NS + '" ' +
      'id="Definitions_rules" targetNamespace="http://bpmn.io/schema/bpmn" exporter="Rule-as-Code prototype" exporterVersion="1">');
    push(1, '<bpmn:process id="Process_rules" name="' + escapeXml(oneLine(meta.title)) + '" isExecutable="false">');
    push(2, '<bpmn:extensionElements>');
    push(3, '<rac:rules>' + escapeXml(JSON.stringify(rules, null, 2)) + '</rac:rules>');
    push(2, '</bpmn:extensionElements>');
    const ioLines = (id) => flows.filter((f) => f.to === id).map((f) => '<bpmn:incoming>' + f.id + '</bpmn:incoming>')
      .concat(flows.filter((f) => f.from === id).map((f) => '<bpmn:outgoing>' + f.id + '</bpmn:outgoing>'));
    const element = (tag, id, name) => {
      push(2, '<bpmn:' + tag + ' id="' + id + '" name="' + escapeXml(name) + '">');
      ioLines(id).forEach((l) => push(3, l));
      push(2, '</bpmn:' + tag + '>');
    };
    element('startEvent', 'StartEvent', 'Start');
    ids.forEach((id) => element(isDecision(id) ? 'exclusiveGateway' : 'endEvent', id, nameOf(id)));
    flows.forEach((f) => push(2, '<bpmn:sequenceFlow id="' + f.id + '"' + (f.name ? ' name="' + escapeXml(f.name) + '"' : '') +
      ' sourceRef="' + f.from + '" targetRef="' + f.to + '" />'));
    if (info) {
      push(2, '<bpmn:textAnnotation id="RulesInfo">');
      push(3, '<bpmn:text>' + escapeXml(info) + '</bpmn:text>');
      push(2, '</bpmn:textAnnotation>');
    }
    push(1, '</bpmn:process>');

    push(1, '<bpmndi:BPMNDiagram id="Diagram_rules">');
    push(2, '<bpmndi:BPMNPlane id="Plane_rules" bpmnElement="Process_rules">');
    const shape = (id, b, label, extra) => {
      push(3, '<bpmndi:BPMNShape id="' + id + '_di" bpmnElement="' + id + '"' + (extra || '') + '>');
      push(4, '<dc:Bounds x="' + r(b.x) + '" y="' + r(b.y) + '" width="' + r(b.w) + '" height="' + r(b.h) + '" />');
      if (label) {
        push(4, '<bpmndi:BPMNLabel>');
        push(5, '<dc:Bounds x="' + r(b.cx - 45) + '" y="' + r(b.y + b.h + 6) + '" width="90" height="' + r(b.labelHeight) + '" />');
        push(4, '</bpmndi:BPMNLabel>');
      }
      push(3, '</bpmndi:BPMNShape>');
    };
    shape('StartEvent', bounds.StartEvent, true);
    ids.forEach((id) => shape(id, bounds[id], true, isDecision(id) ? ' isMarkerVisible="true"' : ''));
    const labelSpots = {};
    flows.forEach((f) => {
      const a = bounds[f.from];
      const b = bounds[f.to];
      // Right side of the source, through the waypoints, to the left side of
      // the target; a change of height bends just after the source or at a
      // waypoint.
      const via = (routes[f.from + '>' + f.to] || []).map(([x, y]) => [left + 130 + x, top + y]);
      // (Bends after a waypoint are in the gap after its column, clear of
      // the nodes and labels in it.)
      const stops = [[a.x + a.w, a.cy, a.x + a.w + 30]].concat(via.map(([x, y]) => [x, y, x + 70]), [[b.x, b.cy]]);
      const points = [[stops[0][0], stops[0][1]]];
      for (let i = 1; i < stops.length; i++) {
        const [px, py, bendX] = stops[i - 1];
        const [qx, qy] = stops[i];
        if (Math.abs(py - qy) > 1) points.push([bendX, py], [bendX, qy]);
        points.push([qx, qy]);
      }
      const clean = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1])
        .filter((p, i, list) => i === 0 || i === list.length - 1 ||
          !((p[0] === list[i - 1][0] && p[0] === list[i + 1][0]) || (p[1] === list[i - 1][1] && p[1] === list[i + 1][1])));
      points.length = 0; clean.forEach((p) => points.push(p));
      // "Yes"/"No" next to where the arrow leaves its question; if the other
      // arrow's label is already there, where it turns to its target, or
      // below the line.
      const [x0, y0] = points[0];
      const firstBend = points.length > 2 && points[1][1] === y0 ? points[1] : null;
      const turn = points[points.length - 2];
      const candidates = [
        firstBend ? [firstBend[0] + 6, points[2][1] > y0 ? y0 + 4 : y0 - 20] : [x0 + 6, y0 - 20],
        points.length > 2 ? [turn[0] + 6, turn[1] - 20] : null,
        [x0 + 26, y0 + 4], // right of the question's own label
      ].filter(Boolean);
      const taken = labelSpots[f.from] = labelSpots[f.from] || [];
      const labelAt = candidates.find(([x, y]) => !taken.some(([tx, ty]) => Math.abs(tx - x) < 40 && Math.abs(ty - y) < 18)) || candidates[0];
      taken.push(labelAt);
      push(3, '<bpmndi:BPMNEdge id="' + f.id + '_di" bpmnElement="' + f.id + '">');
      points.forEach(([x, y]) => push(4, '<di:waypoint x="' + r(x) + '" y="' + r(y) + '" />'));
      if (f.name) {
        push(4, '<bpmndi:BPMNLabel>');
        push(5, '<dc:Bounds x="' + r(labelAt[0]) + '" y="' + r(labelAt[1]) + '" width="' + (f.name.length > 4 ? 90 : 24) + '" height="' + r(textHeight(f.name, 90, 14)) + '" />');
        push(4, '</bpmndi:BPMNLabel>');
      }
      push(3, '</bpmndi:BPMNEdge>');
    });
    if (info) {
      push(3, '<bpmndi:BPMNShape id="RulesInfo_di" bpmnElement="RulesInfo">');
      push(4, '<dc:Bounds x="' + (left - 18) + '" y="40" width="' + infoWidth + '" height="' + r(infoHeight) + '" />');
      push(3, '</bpmndi:BPMNShape>');
    }
    push(2, '</bpmndi:BPMNPlane>');
    push(1, '</bpmndi:BPMNDiagram>');
    push(0, '</bpmn:definitions>');
    return out.join('\n') + '\n';
  }

  return { bpmnToRules, importReport, rulesToBpmn, readEmbeddedRules };
});
