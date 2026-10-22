/**
 * logic.js
 * Pure, DOM-free logic for the Rule-as-Code prototype:
 *  - condition evaluation (per-node, json-rules-engine style: {fact, operator, value})
 *  - input validation against the data dictionary, and decide(): the
 *    decision service used by the runner and the tests
 *  - rules.json validation: the tree, the data dictionary and the glossary
 *  - exhaustive root-to-outcome path traversal with per-fact constraint narrowing
 *  - automatic test-suite generation (normal / boundary / negative rows)
 *  - CSV export, and running a test-suite CSV (outcome and path per row)
 *  - the data dictionary and glossary tables for the report, and writing rules.json
 *
 * No DOM/browser APIs are used here so this file can be loaded both in the
 * browser (index.html) and directly in Node for testing (npm test).
 */

// Export for both environments: module.exports in Node, window.RaC in the browser.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.RaC = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Operators a decision node may use (a subset of json-rules-engine's).
  const OPERATORS = [
    'equal', 'notEqual',
    'lessThan', 'lessThanInclusive',
    'greaterThan', 'greaterThanInclusive',
    'in', 'notIn'
  ];

  const NUMERIC_TYPES = new Set(['number']);

  // Variable types a data dictionary entry may declare.
  const ATTRIBUTE_TYPES = ['boolean', 'number', 'enum', 'string'];
  // Operators that only make sense on numbers, and those that compare against a list.
  const NUMERIC_OPERATORS = ['lessThan', 'lessThanInclusive', 'greaterThan', 'greaterThanInclusive'];
  const LIST_OPERATORS = ['in', 'notIn'];

  // ---------------------------------------------------------------------
  // json-rules-engine loading — real library only, no reimplementation
  // ---------------------------------------------------------------------
  // Node: require('json-rules-engine') directly (npm install json-rules-engine).
  // Browser: read the Engine class off window.JsonRulesEngine, which
  // vendor/json-rules-engine.bundle.js sets — a browser bundle of the same
  // npm package, built once with `npm run build:engine` (see README). No
  // CDN, no offline fallback: if the engine isn't found, evaluateCondition
  // throws instead of silently substituting different logic.

  let realEnginePromise = null;
  let engineStatus = 'not checked yet';

  function loadRealEngine() {
    if (realEnginePromise) return realEnginePromise;
    realEnginePromise = (async () => {
      if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
        const mod = require('json-rules-engine'); // throws if not installed — see README setup
        engineStatus = 'json-rules-engine (npm)';
        return mod.Engine;
      }
      if (typeof window !== 'undefined') {
        if (window.JsonRulesEngine && window.JsonRulesEngine.Engine) {
          engineStatus = 'json-rules-engine (bundled)';
          return window.JsonRulesEngine.Engine;
        }
        throw new Error(
          'json-rules-engine is not loaded. Run "npm install" then "npm run build:engine", ' +
          'and make sure vendor/json-rules-engine.bundle.js loads before logic.js.'
        );
      }
      throw new Error('json-rules-engine could not be loaded in this environment.');
    })();
    return realEnginePromise;
  }

  function getEngineStatus() {
    return engineStatus;
  }

  async function evaluateWithRealEngine(Engine, node, facts) {
    const engine = new Engine();
    engine.addRule({
      conditions: { all: [{ fact: node.fact, operator: node.operator, value: node.value }] },
      event: { type: 'match' },
    });
    const { events } = await engine.run(facts);
    return events.length > 0;
  }

  // ---------------------------------------------------------------------
  // Condition evaluation
  // ---------------------------------------------------------------------

  async function evaluateCondition(node, facts) {
    const Engine = await loadRealEngine();
    return evaluateWithRealEngine(Engine, node, facts);
  }

  /**
   * Walk the tree starting at rules.start, using `facts` to decide branches,
   * until an outcome node is reached (or a hard safety limit is hit, which
   * indicates a cycle that validateRules() should have already flagged).
   * Returns { outcomeId, outcomeNode, path: [nodeId, ...] } (path includes
   * every decision node visited plus the final outcome node id).
   */
  async function run(rules, facts) {
    const nodes = rules.nodes || {};
    let currentId = rules.start;
    const path = [];
    const warnings = [];
    const maxSteps = Object.keys(nodes).length + 2;
    let steps = 0;

    while (steps++ < maxSteps) {
      const node = nodes[currentId];
      if (!node) {
        throw new Error('Node not found: ' + currentId);
      }
      path.push(currentId);
      if (node.type === 'outcome') {
        return { outcomeId: currentId, outcomeNode: node, path, warnings };
      }
      if (node.type !== 'decision') {
        throw new Error('Unknown node type "' + node.type + '" at ' + currentId);
      }
      if (facts[node.fact] === undefined) {
        throw new MissingInputError(node.fact, currentId);
      }
      const branch = await evaluateCondition(node, facts);
      // A defect noted on the branch taken (e.g. auditor review missing).
      const warning = node.warnings && node.warnings[String(branch)];
      if (warning) warnings.push({ nodeId: currentId, warning });
      currentId = branch ? node.true : node.false;
    }
    throw new Error('Exceeded maximum steps — the rule graph likely has a cycle.');
  }

  // Thrown by run() when a node needs a variable that has no value, instead
  // of json-rules-engine's own "Undefined fact" error.
  class MissingInputError extends Error {
    constructor(field, nodeId) {
      super('No value for "' + field + '", needed at node ' + nodeId + '.');
      this.field = field;
    }
  }

  // ---------------------------------------------------------------------
  // Data dictionary: input validation
  // ---------------------------------------------------------------------
  // Every input is checked against its entry in rules.attributes (the data
  // dictionary) before the engine sees it: type, range, allowed values, and
  // the null policy (a missing value is an error unless there is a default).
  // The UI, the runner and the tests
  // all use these functions, so the rules are enforced in one place.

  function isMissing(value) {
    return value === undefined || value === null || value === '';
  }

  // Checks a present value against the entry's type, range and allowed
  // values. Returns the problem ("must be a number") or null.
  function valueProblem(attribute, value) {
    switch (attribute.type) {
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
        if (typeof attribute.min === 'number' && value < attribute.min) return 'must be ≥ ' + attribute.min;
        if (typeof attribute.max === 'number' && value > attribute.max) return 'must be ≤ ' + attribute.max;
        return null;
      case 'boolean':
        return typeof value === 'boolean' ? null : 'must be true or false';
      case 'enum':
        return Array.isArray(attribute.values) && attribute.values.includes(value)
          ? null
          : 'must be one of: ' + (attribute.values || []).join(', ');
      case 'string':
        return typeof value === 'string' ? null : 'must be text';
      default:
        return null;
    }
  }

  // The same check as a full message for users, e.g. "Age must be ≥ 0."
  function checkValue(attribute, value) {
    const problem = valueProblem(attribute, value);
    return problem ? (attribute.label || attribute.id) + ' ' + problem + '.' : null;
  }

  // Checks one answer to a question that was asked. Null policy: a missing
  // answer is an error unless the variable has a default.
  function validateValue(attribute, value) {
    if (!attribute) return null;
    if (isMissing(value)) {
      return attribute.default !== undefined ? null : (attribute.label || attribute.id) + ' is required.';
    }
    return checkValue(attribute, value);
  }

  // Checks every value that was given and fills in defaults for missing
  // ones. A missing value without a default is not an error here: the tree
  // only needs the variables on its path, so run() reports it if reached.
  // Returns { facts, errors: [{ field, error }] }.
  function validateInputs(rules, inputs) {
    const facts = {};
    const errors = [];
    for (const attribute of rules.attributes || []) {
      let value = inputs ? inputs[attribute.id] : undefined;
      if (isMissing(value)) {
        if (attribute.default === undefined) continue;
        value = attribute.default;
      }
      const error = checkValue(attribute, value);
      if (error) errors.push({ field: attribute.id, error });
      else facts[attribute.id] = value;
    }
    return { facts, errors };
  }

  /**
   * The decision service: validate inputs against the data dictionary, then
   * run the tree. This is what the CLI runner and the tests call.
   * Returns { outcome, outcomeId, path, warnings: [{ nodeId, warning }] } or,
   * for invalid or missing input,
   * { outcome: 'ERROR', errors: [{ field, error }], path: [] }.
   */
  async function decide(rules, inputs) {
    const { facts, errors } = validateInputs(rules, inputs);
    if (errors.length) return { outcome: 'ERROR', errors, path: [] };
    try {
      const result = await run(rules, facts);
      return { outcome: outcomeLabel(rules, result.outcomeId), outcomeId: result.outcomeId, path: result.path, warnings: result.warnings };
    } catch (e) {
      if (!(e instanceof MissingInputError)) throw e;
      const attribute = (rules.attributes || []).find((a) => a.id === e.field);
      return { outcome: 'ERROR', errors: [{ field: e.field, error: validateValue(attribute, undefined) || e.message }], path: [] };
    }
  }

  // ---------------------------------------------------------------------
  // Structural validation (the tree and the data dictionary)
  // ---------------------------------------------------------------------

  function validateRules(rules) {
    const errors = [];
    const warnings = [];

    if (!rules || typeof rules !== 'object') {
      return { errors: ['File is not a JSON object.'], warnings };
    }
    if (!rules.start) errors.push('Missing top-level "start" node id.');
    if (!rules.nodes || typeof rules.nodes !== 'object') {
      errors.push('Missing top-level "nodes" object.');
      return { errors, warnings };
    }
    if (rules.start && !rules.nodes[rules.start]) {
      errors.push('"start" points to node "' + rules.start + '" which does not exist.');
    }

    const attributes = Array.isArray(rules.attributes) ? rules.attributes : [];
    const attrIds = new Set(attributes.map((a) => a && a.id));
    if (attributes.length === 0) {
      warnings.push('No "attributes" (data dictionary) declared — form rendering and validation will be limited.');
    }
    validateDataDictionary(attributes, errors, warnings);
    validateGlossary(rules, errors, warnings);
    const attributesById = {};
    attributes.forEach((a) => { if (a && a.id) attributesById[a.id] = a; });
    const usedFacts = new Set();

    const nodeIds = Object.keys(rules.nodes);
    const outcomeIds = new Set();

    for (const id of nodeIds) {
      const node = rules.nodes[id];
      if (!node || typeof node !== 'object') {
        errors.push('Node "' + id + '" is not an object.');
        continue;
      }
      if (node.type === 'decision') {
        if (!node.question) warnings.push('Node "' + id + '": no "question" text for the questionnaire UI.');
        if (!node.fact) {
          errors.push('Node "' + id + '": missing "fact".');
        } else if (!attrIds.has(node.fact)) {
          errors.push('Node "' + id + '": fact "' + node.fact + '" is not declared in "attributes".');
        }
        if (!OPERATORS.includes(node.operator)) {
          errors.push('Node "' + id + '": unknown operator "' + node.operator + '". Must be one of: ' + OPERATORS.join(', '));
        }
        if (node.value === undefined) {
          errors.push('Node "' + id + '": missing "value" to compare against.');
        } else if (attributesById[node.fact] && OPERATORS.includes(node.operator)) {
          checkNodeValue(id, node, attributesById[node.fact], errors);
        }
        if (node.fact) usedFacts.add(node.fact);
        if (!node.true || !rules.nodes[node.true]) {
          errors.push('Node "' + id + '": "true" target "' + node.true + '" does not exist.');
        }
        if (!node.false || !rules.nodes[node.false]) {
          errors.push('Node "' + id + '": "false" target "' + node.false + '" does not exist.');
        }
        if (node.warnings !== undefined && (typeof node.warnings !== 'object' ||
            Object.keys(node.warnings).some((k) => !['true', 'false'].includes(k) || typeof node.warnings[k] !== 'string'))) {
          errors.push('Node "' + id + '": "warnings" must be { "true": text, "false": text } (either may be left out).');
        }
      } else if (node.type === 'outcome') {
        outcomeIds.add(id);
        if (!node.label) warnings.push('Node "' + id + '": no "label" — will display as the raw node id.');
      } else {
        errors.push('Node "' + id + '": unknown "type" ("' + node.type + '"); must be "decision" or "outcome".');
      }
    }

    if (outcomeIds.size === 0) errors.push('No outcome nodes found (type "outcome"). Every path must end at one.');

    for (const id of attrIds) {
      if (id && !usedFacts.has(id)) warnings.push('Variable "' + id + '" is declared but no decision node uses it.');
    }

    // Cycle detection (DFS with recursion stack) — only meaningful if the
    // basic references above are all valid.
    if (errors.length === 0) {
      const WHITE = 0, GRAY = 1, BLACK = 2;
      const color = {};
      nodeIds.forEach((id) => { color[id] = WHITE; });
      let cyclePath = null;

      function dfs(id, stack) {
        color[id] = GRAY;
        stack.push(id);
        const node = rules.nodes[id];
        if (node.type === 'decision') {
          for (const next of [node.true, node.false]) {
            if (color[next] === GRAY) {
              cyclePath = stack.concat(next);
              return true;
            }
            if (color[next] === WHITE && dfs(next, stack)) return true;
          }
        }
        stack.pop();
        color[id] = BLACK;
        return false;
      }

      if (rules.nodes[rules.start]) dfs(rules.start, []);
      if (cyclePath) {
        errors.push('Cycle detected: ' + cyclePath.join(' -> ') + '. Every path must terminate at an outcome node.');
      }

      // Unreachable nodes (authored but never reached from start) — warning only.
      const reachable = new Set();
      (function mark(id) {
        if (reachable.has(id) || !rules.nodes[id]) return;
        reachable.add(id);
        const node = rules.nodes[id];
        if (node.type === 'decision') { mark(node.true); mark(node.false); }
      })(rules.start);
      for (const id of nodeIds) {
        if (!reachable.has(id)) warnings.push('Node "' + id + '" is never reached from "start".');
      }
    }

    return { errors, warnings };
  }

  // Checks each data dictionary entry: a unique id, a known type, the
  // fields that type needs, and that its default and example are valid.
  function validateDataDictionary(attributes, errors, warnings) {
    const seen = new Set();
    attributes.forEach((a, i) => {
      const where = 'Variable ' + (a && a.id ? '"' + a.id + '"' : '#' + (i + 1));
      if (!a || typeof a !== 'object') { errors.push(where + ' is not an object.'); return; }

      if (!a.id || typeof a.id !== 'string') errors.push(where + ': missing "id".');
      else if (seen.has(a.id)) errors.push(where + ': the same id is declared twice.');
      else seen.add(a.id);

      if (!ATTRIBUTE_TYPES.includes(a.type)) {
        errors.push(where + ': unknown type "' + a.type + '". Must be one of: ' + ATTRIBUTE_TYPES.join(', '));
        return;
      }
      if (!a.label) warnings.push(where + ': no "label".');
      if (!a.source) warnings.push(where + ': no legal "source".');
      if (a.example === undefined) warnings.push(where + ': no "example" value.');

      if (a.type === 'enum') {
        if (!Array.isArray(a.values) || a.values.length === 0) errors.push(where + ': an enum needs a non-empty "values" list.');
        else if (new Set(a.values).size !== a.values.length) errors.push(where + ': "values" contains duplicates.');
      } else if (a.values !== undefined) {
        warnings.push(where + ': "values" only applies to enum variables and is ignored.');
      }

      if (a.type === 'number') {
        ['min', 'max'].forEach((k) => {
          if (a[k] !== undefined && typeof a[k] !== 'number') errors.push(where + ': "' + k + '" must be a number.');
        });
        if (typeof a.min === 'number' && typeof a.max === 'number' && a.min > a.max) errors.push(where + ': "min" is greater than "max".');
      } else if (a.min !== undefined || a.max !== undefined) {
        warnings.push(where + ': "min"/"max" only apply to number variables and are ignored.');
      }

      ['default', 'example'].forEach((k) => {
        if (a[k] === undefined) return;
        const problem = valueProblem(a, a[k]);
        if (problem) errors.push(where + ': "' + k + '" is ' + JSON.stringify(a[k]) + ', but it ' + problem + '.');
      });
    });
  }

  // Checks the glossary: every entry has a unique term; an entry without a
  // definition (hidden in the app until it's written), without a source, or
  // whose term appears in no question or outcome is reported as a warning.
  function validateGlossary(rules, errors, warnings) {
    if (rules.glossary === undefined) return;
    if (!Array.isArray(rules.glossary)) { errors.push('"glossary" must be a list.'); return; }
    const texts = Object.values(rules.nodes || {})
      .map((n) => [n.question, n.supportiveText, n.label, n.description].filter(Boolean).join(' '))
      .join(' ').toLowerCase();
    const seen = new Set();
    rules.glossary.forEach((g, i) => {
      if (!g || typeof g !== 'object' || !g.term) { errors.push('Glossary entry #' + (i + 1) + ': missing "term".'); return; }
      const where = 'Glossary term "' + g.term + '"';
      const key = g.term.toLowerCase();
      if (seen.has(key)) errors.push(where + ' is listed twice.');
      seen.add(key);
      if (!g.definition || /^\s*TODO\b/i.test(g.definition)) warnings.push(where + ': no definition yet, so the app doesn\'t show it.');
      if (!g.source) warnings.push(where + ': no legal "source".');
      if (!glossaryTermRegExp(g.term).test(texts)) warnings.push(where + ' appears in no question or outcome, so the app never shows it.');
    });
  }

  // Matches a glossary term as a whole word or phrase, ignoring case.
  function glossaryTermRegExp(term) {
    return new RegExp('\\b' + String(term).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  }

  // Checks that a decision node's comparison value fits its variable, e.g.
  // a boolean variable is compared with true/false, not with "true".
  function checkNodeValue(id, node, attribute, errors) {
    const where = 'Node "' + id + '"';
    if (NUMERIC_OPERATORS.includes(node.operator) && attribute.type !== 'number') {
      errors.push(where + ': operator "' + node.operator + '" needs a number variable, but "' + attribute.id + '" is ' + attribute.type + '.');
      return;
    }
    const isList = LIST_OPERATORS.includes(node.operator);
    if (isList && !Array.isArray(node.value)) {
      errors.push(where + ': operator "' + node.operator + '" needs a list of values.');
      return;
    }
    for (const v of isList ? node.value : [node.value]) {
      const problem = valueProblem(attribute, v);
      if (problem) errors.push(where + ': compares "' + attribute.id + '" with ' + JSON.stringify(v) + ', but the data dictionary says it ' + problem + '.');
    }
  }

  // ---------------------------------------------------------------------
  // Path traversal with per-fact constraint narrowing
  // ---------------------------------------------------------------------
  // While walking a path, each branch taken narrows what the fact can be:
  // numbers get a {min, max, exclude} range, other types get {eq, neq,
  // inSet, notInSet}. The test generator later picks values inside these
  // constraints so that each test row really follows its path.

  function cloneConstraints(c) {
    const out = {};
    for (const k in c) {
      const e = c[k];
      out[k] = Object.assign({}, e, {
        exclude: e.exclude ? e.exclude.slice() : undefined,
        neq: e.neq ? e.neq.slice() : undefined,
        notInSet: e.notInSet ? e.notInSet.slice() : undefined,
      });
    }
    return out;
  }

  // Returns a copy of `constraints` with this node's condition applied for
  // the given branch (true = condition holds). Numeric steps are ±1, so
  // this assumes whole numbers.
  function narrow(constraints, attribute, node, branch) {
    const out = cloneConstraints(constraints);
    const id = node.fact;

    if (attribute && NUMERIC_TYPES.has(attribute.type)) {
      const entry = out[id] || {
        min: typeof attribute.min === 'number' ? attribute.min : -Infinity,
        max: typeof attribute.max === 'number' ? attribute.max : Infinity,
      };
      const v = node.value;
      switch (node.operator) {
        case 'greaterThanInclusive':
          if (branch) entry.min = Math.max(entry.min, v); else entry.max = Math.min(entry.max, v - 1);
          break;
        case 'greaterThan':
          if (branch) entry.min = Math.max(entry.min, v + 1); else entry.max = Math.min(entry.max, v);
          break;
        case 'lessThanInclusive':
          if (branch) entry.max = Math.min(entry.max, v); else entry.min = Math.max(entry.min, v + 1);
          break;
        case 'lessThan':
          if (branch) entry.max = Math.min(entry.max, v - 1); else entry.min = Math.max(entry.min, v);
          break;
        case 'equal':
          if (branch) { entry.min = Math.max(entry.min, v); entry.max = Math.min(entry.max, v); }
          else { entry.exclude = (entry.exclude || []).concat(v); }
          break;
        case 'notEqual':
          if (branch) { entry.exclude = (entry.exclude || []).concat(v); }
          else { entry.min = Math.max(entry.min, v); entry.max = Math.min(entry.max, v); }
          break;
      }
      out[id] = entry;
    } else {
      // boolean / enum / string
      const entry = out[id] || {};
      const v = node.value;
      switch (node.operator) {
        case 'equal':
          if (branch) entry.eq = v; else entry.neq = (entry.neq || []).concat(v);
          break;
        case 'notEqual':
          if (branch) entry.neq = (entry.neq || []).concat(v); else entry.eq = v;
          break;
        case 'in':
          if (branch) entry.inSet = v; else entry.notInSet = (entry.notInSet || []).concat(v);
          break;
        case 'notIn':
          if (branch) entry.notInSet = (entry.notInSet || []).concat(v); else entry.inSet = v;
          break;
      }
      out[id] = entry;
    }
    return out;
  }

  /**
   * Enumerate every root-to-outcome path. Returns an array of:
   *   { steps: [{nodeId, branch}], outcomeId, constraints }
   */
  function traverseAllPaths(rules) {
    const attributesById = {};
    (rules.attributes || []).forEach((a) => { attributesById[a.id] = a; });
    const results = [];
    const maxDepth = Object.keys(rules.nodes).length + 2;

    function walk(nodeId, steps, constraints, depth) {
      if (depth > maxDepth) return; // safety valve; validateRules() should catch real cycles
      const node = rules.nodes[nodeId];
      if (!node) return;
      if (node.type === 'outcome') {
        results.push({ steps: steps.slice(), outcomeId: nodeId, constraints });
        return;
      }
      const attribute = attributesById[node.fact];
      walk(node.true, steps.concat([{ nodeId, branch: true }]), narrow(constraints, attribute, node, true), depth + 1);
      walk(node.false, steps.concat([{ nodeId, branch: false }]), narrow(constraints, attribute, node, false), depth + 1);
    }

    walk(rules.start, [], {}, 0);
    return { paths: results, attributesById };
  }

  // ---------------------------------------------------------------------
  // Representative value selection
  // ---------------------------------------------------------------------
  // Turns a path's constraints into concrete input values: the middle of a
  // numeric range, the required/allowed value for booleans and enums.

  function pickValue(attribute, entry) {
    entry = entry || {};
    if (!attribute) return null;

    if (NUMERIC_TYPES.has(attribute.type)) {
      let lo = typeof entry.min === 'number' ? entry.min : (typeof attribute.min === 'number' ? attribute.min : 0);
      let hi = typeof entry.max === 'number' ? entry.max : (typeof attribute.max === 'number' ? attribute.max : lo + 100);
      if (!isFinite(lo)) lo = isFinite(hi) ? hi - 100 : 0;
      if (!isFinite(hi)) hi = lo + 100;
      if (lo > hi) { const t = lo; lo = hi; hi = t; } // shouldn't happen with consistent rules, but stay safe

      let value = Math.round((lo + hi) / 2);

      // nudge off excluded values (from strict equal/notEqual narrowing)
      const excluded = new Set(entry.exclude || []);
      let guard = 0;
      while (excluded.has(value) && value < hi && guard++ < 1000) value++;
      while (excluded.has(value) && value > lo && guard++ < 1000) value--;

      return value;
    }

    if (attribute.type === 'boolean') {
      if (typeof entry.eq === 'boolean') return entry.eq;
      if (entry.neq && entry.neq.length) return !entry.neq[0];
      return false;
    }

    // enum / string
    if (entry.eq !== undefined) return entry.eq;
    if (entry.inSet) return Array.isArray(entry.inSet) ? entry.inSet[0] : entry.inSet;
    const domain = Array.isArray(attribute.values) ? attribute.values : [];
    const excluded = new Set((entry.neq || []).concat(entry.notInSet || []));
    const pick = domain.find((v) => !excluded.has(v));
    return pick !== undefined ? pick : (domain[0] !== undefined ? domain[0] : null);
  }

  function buildFacts(attributes, constraints) {
    const facts = {};
    for (const attribute of attributes) {
      facts[attribute.id] = pickValue(attribute, constraints[attribute.id]);
    }
    return facts;
  }

  // ---------------------------------------------------------------------
  // Invalid-value helpers (for negative/error test rows)
  // ---------------------------------------------------------------------

  function invalidValueFor(attribute, kind) {
    if (attribute.type === 'number') {
      if (kind === 'outOfRange') {
        if (typeof attribute.max === 'number') return attribute.max + 1000;
        return attribute.min - 1000; // only called when min or max is set
      }
      if (kind === 'wrongType') return 'not-a-number';
    }
    if (attribute.type === 'boolean' && kind === 'wrongType') return 'maybe';
    if (attribute.type === 'enum' && kind === 'badEnum') return '__INVALID_ENUM_VALUE__';
    return undefined;
  }

  // ---------------------------------------------------------------------
  // Test-suite generation
  // ---------------------------------------------------------------------

  function outcomeLabel(rules, outcomeId) {
    const node = rules.nodes[outcomeId];
    return (node && node.label) || outcomeId;
  }

  function pathString(steps, outcomeId) {
    return steps.map((s) => s.nodeId).concat([outcomeId]).join('>');
  }

  // Builds the draft test suite: one "normal" row per path, one "boundary"
  // row per numeric threshold and branch, and "negative" rows with one
  // invalid or missing input each.
  function generateTestSuite(rules) {
    const { paths, attributesById } = traverseAllPaths(rules);
    const attributes = rules.attributes || [];
    const rows = [];
    let n = 1;

    // 1) Normal rows — one per full root-to-outcome path
    for (const p of paths) {
      const facts = buildFacts(attributes, p.constraints);
      rows.push({
        test_id: 'TC' + n++,
        description: 'Path ' + pathString(p.steps, p.outcomeId),
        inputs: facts,
        expected_outcome: outcomeLabel(rules, p.outcomeId),
        expected_path: pathString(p.steps, p.outcomeId),
        edge_class: 'normal',
      });
    }

    // 2) Boundary rows — one per numeric decision node encountered on any path
    const seenBoundary = new Set();
    for (const p of paths) {
      for (const step of p.steps) {
        const node = rules.nodes[step.nodeId];
        const attribute = attributesById[node.fact];
        if (!attribute || attribute.type !== 'number') continue;
        const key = step.nodeId + ':' + step.branch;
        if (seenBoundary.has(key)) continue;
        seenBoundary.add(key);

        // Boundary value for this node's own test, then clamp into the
        // path's final aggregated range for that fact so it stays valid
        // for every other node on the same path.
        const finalRange = p.constraints[node.fact] || {};
        const lo = typeof finalRange.min === 'number' ? finalRange.min : -Infinity;
        const hi = typeof finalRange.max === 'number' ? finalRange.max : Infinity;
        let boundary;
        switch (node.operator) {
          case 'greaterThanInclusive': boundary = step.branch ? node.value : node.value - 1; break;
          case 'greaterThan': boundary = step.branch ? node.value + 1 : node.value; break;
          case 'lessThanInclusive': boundary = step.branch ? node.value : node.value + 1; break;
          case 'lessThan': boundary = step.branch ? node.value - 1 : node.value; break;
          default: boundary = node.value;
        }
        if (isFinite(lo)) boundary = Math.max(boundary, lo);
        if (isFinite(hi)) boundary = Math.min(boundary, hi);

        const constraintsCopy = cloneConstraints(p.constraints);
        constraintsCopy[node.fact] = Object.assign({}, constraintsCopy[node.fact], { min: boundary, max: boundary });
        const facts = buildFacts(attributes, constraintsCopy);

        rows.push({
          test_id: 'TC' + n++,
          description: 'Boundary at node ' + step.nodeId + ' (' + attribute.label + ' = ' + boundary + ')',
          inputs: facts,
          expected_outcome: outcomeLabel(rules, p.outcomeId),
          expected_path: pathString(p.steps, p.outcomeId),
          edge_class: 'boundary',
        });
      }
    }

    // 3) Negative / invalid rows — one baseline fact set, one field perturbed at a time
    const baseline = paths.length ? buildFacts(attributes, paths[0].constraints) : {};
    for (const attribute of attributes) {
      // A missing value only matters when the path reaches its question, so
      // that row starts from a path that uses this variable.
      const usingPath = paths.find((p) => p.steps.some((s) => rules.nodes[s.nodeId].fact === attribute.id));
      const kinds = [];
      const hasRange = typeof attribute.min === 'number' || typeof attribute.max === 'number';
      if (attribute.type === 'number' && hasRange) kinds.push('outOfRange');
      if (attribute.type === 'number') kinds.push('wrongType');
      if (attribute.type === 'boolean') kinds.push('wrongType');
      if (attribute.type === 'enum') kinds.push('badEnum');
      // Missing is only an error when there is no default to fall back on.
      if (attribute.default === undefined && usingPath) kinds.push('missing');

      for (const kind of kinds) {
        const facts = kind === 'missing' ? buildFacts(attributes, usingPath.constraints) : Object.assign({}, baseline);
        let desc;
        if (kind === 'missing') {
          delete facts[attribute.id];
          desc = attribute.label + ' missing';
        } else {
          facts[attribute.id] = invalidValueFor(attribute, kind);
          desc = attribute.label + ' ' + (kind === 'outOfRange' ? 'out of range' : kind === 'wrongType' ? 'wrong type' : 'invalid enum value');
        }
        rows.push({
          test_id: 'TC' + n++,
          description: '[invalid] ' + desc,
          inputs: facts,
          expected_outcome: 'ERROR',
          expected_path: '',
          edge_class: 'negative',
        });
      }
    }

    return rows;
  }

  // ---------------------------------------------------------------------
  // CSV export
  // ---------------------------------------------------------------------

  function csvEscape(value) {
    if (value === undefined || value === null) return '';
    const s = String(value);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function testSuiteToCSV(rows, attributes) {
    const attrCols = attributes.map((a) => a.id);
    const header = ['test_id', 'description'].concat(attrCols).concat(['expected_outcome', 'expected_path(node_ids)', 'edge_class']);
    const lines = [header.map(csvEscape).join(',')];
    for (const row of rows) {
      const line = [row.test_id, row.description]
        .concat(attrCols.map((id) => (row.inputs[id] === undefined ? '' : row.inputs[id])))
        .concat([row.expected_outcome, row.expected_path, row.edge_class]);
      lines.push(line.map(csvEscape).join(','));
    }
    return lines.join('\r\n');
  }

  // ---------------------------------------------------------------------
  // Running a test-suite CSV (the runner)
  // ---------------------------------------------------------------------
  // Reads a test file with the columns test_id, description, one column per
  // variable, expected_outcome, expected_path(node_ids) and edge_class, runs
  // every row through decide(), and compares the outcome and the path.

  // Splits CSV text into rows of cells; handles quoted cells with commas,
  // quotes ("") and line breaks.
  function parseCSV(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ''));
  }

  // Turns text (a CSV cell, an editor box) into a value of the variable's
  // type: "" is missing, "true"/"false" become booleans, numeric text
  // becomes a number. Anything else stays text, so wrong types still reach
  // the validation.
  function textToValue(attribute, raw) {
    if (raw === '') return undefined;
    if (attribute.type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : raw;
    if (attribute.type === 'number') {
      const n = Number(raw);
      return raw.trim() !== '' && Number.isFinite(n) ? n : raw;
    }
    return raw;
  }

  function splitPath(text) {
    return String(text || '').split(/\s*(?:>|→)\s*/).filter(Boolean);
  }

  /**
   * Runs every row of a test CSV. Returns one result per row:
   * { test_id, description, edge_class, pass, reason,
   *   expected: { outcome, path }, actual: { outcome, path, errors } }
   */
  async function runTestSuiteCSV(rules, csvText) {
    const rows = parseCSV(csvText);
    if (rows.length < 2) throw new Error('The test file has no rows.');
    const header = rows[0].map((h) => h.trim());
    const col = (name) => header.indexOf(name);
    const pathCol = col('expected_path(node_ids)') >= 0 ? col('expected_path(node_ids)') : col('expected_path');
    if (col('test_id') < 0 || col('expected_outcome') < 0 || pathCol < 0) {
      throw new Error('The test file needs the columns test_id, expected_outcome and expected_path(node_ids).');
    }
    // A misspelled variable column would otherwise be read as a missing
    // input, and the test would fail for a confusing reason.
    const known = new Set(['test_id', 'description', 'expected_outcome', 'expected_path(node_ids)', 'expected_path', 'edge_class']
      .concat((rules.attributes || []).map((a) => a.id)));
    const unknown = header.filter((h) => h && !known.has(h));
    if (unknown.length) {
      throw new Error('Unknown column(s) in the test file: ' + unknown.join(', ') + '. Input columns must be variable ids from the data dictionary.');
    }

    const results = [];
    for (const cells of rows.slice(1)) {
      const get = (i) => (i >= 0 && cells[i] !== undefined ? cells[i] : '');
      const inputs = {};
      for (const attribute of rules.attributes || []) {
        const value = textToValue(attribute, get(col(attribute.id)));
        if (value !== undefined) inputs[attribute.id] = value;
      }
      results.push(await runTestRow(rules, {
        test_id: get(col('test_id')),
        description: get(col('description')),
        edge_class: get(col('edge_class')),
        inputs,
        expected_outcome: get(col('expected_outcome')),
        expected_path: get(pathCol),
      }));
    }
    return results;
  }

  /**
   * Runs one test row through decide() and compares the outcome and the
   * path. Used for CSV rows (above) and by the Test results tab for the
   * rows of generateTestSuite(). expected_path may be "A>B>C" or an array.
   * Returns { test_id, description, edge_class, inputs, pass, reason,
   *   expected: { outcome, path }, actual: { outcome, outcomeId, path, errors, warnings } }
   */
  async function runTestRow(rules, row) {
    const actual = await decide(rules, row.inputs || {});
    const expectedOutcome = String(row.expected_outcome || '').trim();
    const expectedPath = Array.isArray(row.expected_path) ? row.expected_path : splitPath(row.expected_path);

    // An outcome may be given by its label or its node id. ERROR rows
    // don't have a path; for all others the path must match exactly.
    const outcomeOk = expectedOutcome === actual.outcome || expectedOutcome === actual.outcomeId;
    const pathOk = expectedOutcome === 'ERROR' || expectedPath.join('>') === actual.path.join('>');
    let reason = '';
    if (!outcomeOk) reason = 'outcome is "' + actual.outcome + '", expected "' + expectedOutcome + '"';
    else if (!pathOk) reason = 'path is ' + actual.path.join('>') + ', expected ' + expectedPath.join('>');

    return {
      test_id: row.test_id,
      description: row.description,
      edge_class: row.edge_class,
      inputs: row.inputs || {},
      pass: outcomeOk && pathOk,
      reason,
      expected: { outcome: expectedOutcome, path: expectedPath },
      actual: { outcome: actual.outcome, outcomeId: actual.outcomeId, path: actual.path, errors: actual.errors, warnings: actual.warnings },
    };
  }

  // ---------------------------------------------------------------------
  // Data dictionary table (for the report)
  // ---------------------------------------------------------------------
  // One row per variable with the columns the assignment asks for. Derived
  // from rules.attributes, so the report table can't drift from the rules.

  function allowedValuesText(a) {
    if (a.type === 'boolean') return 'true / false';
    if (a.type === 'enum') return (a.values || []).join(' / ');
    if (a.type === 'number') {
      const hasMin = typeof a.min === 'number', hasMax = typeof a.max === 'number';
      if (hasMin && hasMax) return a.min + '–' + a.max;
      if (hasMin) return '≥ ' + a.min;
      if (hasMax) return '≤ ' + a.max;
      return 'any number';
    }
    return 'any text';
  }

  function nullPolicyText(a) {
    if (a.default !== undefined) return 'Optional — defaults to ' + String(a.default) + ' when missing.';
    return 'Required when the decision reaches it — no default. Missing/empty value is rejected ("<label> is required.").';
  }

  function dataDictionary(rules) {
    return (rules.attributes || []).map((a) => ({
      id: a.id,
      label: a.label || '',
      type: a.type,
      allowed_values_range: allowedValuesText(a),
      unit_format: a.unit || a.format || '',
      default_null_policy: nullPolicyText(a),
      example: a.example === undefined ? '' : String(a.example),
      legal_reference: a.source || '',
    }));
  }

  function dataDictionaryToCSV(rows) {
    const columns = ['id', 'label', 'type', 'allowed_values_range', 'unit_format', 'default_null_policy', 'example', 'legal_reference'];
    return [columns.join(',')].concat(rows.map((r) => columns.map((c) => csvEscape(r[c])).join(','))).join('\n');
  }

  // The glossary (defined terms with citations) as a table for the report.
  function glossaryToCSV(rules) {
    const columns = ['term', 'swedish', 'definition', 'source'];
    return [columns.join(',')].concat((rules.glossary || []).map((g) => columns.map((c) => csvEscape(g[c])).join(','))).join('\n');
  }

  // ---------------------------------------------------------------------
  // Writing rules.json in the project's layout (one variable / node per line,
  // so a changed rule shows up as a small diff in git)
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
  // Questionnaire helper
  // ---------------------------------------------------------------------

  /**
   * Given a decision node, synthesize a fact value that is guaranteed to
   * satisfy (branch=true) or fail (branch=false) that node's own condition
   * — used to let the questionnaire ask "Yes/No" directly for a threshold
   * question (e.g. "20 or older?") instead of collecting a raw number and
   * comparing it. Only looks at this one node's condition, not the whole
   * path, so it's for UI convenience, not for test-suite generation.
   */
  function valueForBranch(node, branch) {
    const v = node.value;
    if (typeof v === 'boolean') {
      if (node.operator === 'equal') return branch ? v : !v;
      if (node.operator === 'notEqual') return branch ? !v : v;
    }
    switch (node.operator) {
      case 'greaterThanInclusive': return branch ? v : v - 1;
      case 'greaterThan': return branch ? v + 1 : v;
      case 'lessThanInclusive': return branch ? v : v + 1;
      case 'lessThan': return branch ? v - 1 : v;
      case 'equal': return branch ? v : (typeof v === 'number' ? v + 1 : undefined);
      case 'notEqual': return branch ? (typeof v === 'number' ? v + 1 : undefined) : v;
      case 'in': return branch ? (Array.isArray(v) ? v[0] : v) : undefined;
      case 'notIn': return branch ? undefined : (Array.isArray(v) ? v[0] : v);
      default: return v;
    }
  }

  // Public API, used by app.js, scripts/ and test/.
  return {
    OPERATORS,
    ATTRIBUTE_TYPES,
    evaluateCondition,
    loadRealEngine,
    getEngineStatus,
    decide,
    validateValue,
    validateRules,
    traverseAllPaths,
    generateTestSuite,
    testSuiteToCSV,
    runTestSuiteCSV,
    runTestRow,
    textToValue,
    dataDictionary,
    dataDictionaryToCSV,
    glossaryToCSV,
    formatRules,
    glossaryTermRegExp,
    valueForBranch,
  };
});
