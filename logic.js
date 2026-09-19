/**
 * logic.js
 * Pure, DOM-free logic for the Rule-as-Code prototype:
 *  - condition evaluation (per-node, json-rules-engine style: {fact, operator, value})
 *  - rules.json structural validation
 *  - exhaustive root-to-outcome path traversal with per-fact constraint narrowing
 *  - automatic test-suite generation (normal / boundary / negative rows)
 *  - CSV export
 *
 * No DOM/browser APIs are used here so this file can be loaded both in the
 * browser (index.html) and directly in Node for testing (node test.js).
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.RaC = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OPERATORS = [
    'equal', 'notEqual',
    'lessThan', 'lessThanInclusive',
    'greaterThan', 'greaterThanInclusive',
    'in', 'notIn'
  ];

  const NUMERIC_TYPES = new Set(['number']);

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
    const maxSteps = Object.keys(nodes).length + 2;
    let steps = 0;

    while (steps++ < maxSteps) {
      const node = nodes[currentId];
      if (!node) {
        throw new Error('Node not found: ' + currentId);
      }
      path.push(currentId);
      if (node.type === 'outcome') {
        return { outcomeId: currentId, outcomeNode: node, path };
      }
      if (node.type !== 'decision') {
        throw new Error('Unknown node type "' + node.type + '" at ' + currentId);
      }
      const branch = await evaluateCondition(node, facts);
      currentId = branch ? node.true : node.false;
    }
    throw new Error('Exceeded maximum steps — the rule graph likely has a cycle.');
  }

  // ---------------------------------------------------------------------
  // Structural validation
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
    const attrIds = new Set(attributes.map((a) => a.id));
    if (attributes.length === 0) {
      warnings.push('No "attributes" (data dictionary) declared — form rendering and validation will be limited.');
    }

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
        }
        if (!node.true || !rules.nodes[node.true]) {
          errors.push('Node "' + id + '": "true" target "' + node.true + '" does not exist.');
        }
        if (!node.false || !rules.nodes[node.false]) {
          errors.push('Node "' + id + '": "false" target "' + node.false + '" does not exist.');
        }
      } else if (node.type === 'outcome') {
        outcomeIds.add(id);
        if (!node.label) warnings.push('Node "' + id + '": no "label" — will display as the raw node id.');
      } else {
        errors.push('Node "' + id + '": unknown "type" ("' + node.type + '"); must be "decision" or "outcome".');
      }
    }

    if (outcomeIds.size === 0) errors.push('No outcome nodes found (type "outcome"). Every path must end at one.');

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

  // ---------------------------------------------------------------------
  // Path traversal with per-fact constraint narrowing
  // ---------------------------------------------------------------------

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

  function pickValue(attribute, entry, mode) {
    entry = entry || {};
    if (!attribute) return null;

    if (NUMERIC_TYPES.has(attribute.type)) {
      let lo = typeof entry.min === 'number' ? entry.min : (typeof attribute.min === 'number' ? attribute.min : 0);
      let hi = typeof entry.max === 'number' ? entry.max : (typeof attribute.max === 'number' ? attribute.max : lo + 100);
      if (!isFinite(lo)) lo = isFinite(hi) ? hi - 100 : 0;
      if (!isFinite(hi)) hi = lo + 100;
      if (lo > hi) { const t = lo; lo = hi; hi = t; } // shouldn't happen with consistent rules, but stay safe

      let value;
      if (mode === 'boundaryLow') value = lo;
      else if (mode === 'boundaryHigh') value = hi;
      else value = Math.round((lo + hi) / 2);

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
      return mode === 'boundaryHigh' ? true : false;
    }

    // enum / string
    if (entry.eq !== undefined) return entry.eq;
    if (entry.inSet) return Array.isArray(entry.inSet) ? entry.inSet[0] : entry.inSet;
    const domain = Array.isArray(attribute.values) ? attribute.values : [];
    const excluded = new Set((entry.neq || []).concat(entry.notInSet ? [].concat(...([entry.notInSet])) : []));
    const pick = domain.find((v) => !excluded.has(v));
    return pick !== undefined ? pick : (domain[0] !== undefined ? domain[0] : null);
  }

  function buildFacts(attributes, constraints, mode) {
    const facts = {};
    for (const attribute of attributes) {
      facts[attribute.id] = pickValue(attribute, constraints[attribute.id], mode);
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
        if (typeof attribute.min === 'number') return attribute.min - 1000;
        return -999999;
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

  function generateTestSuite(rules) {
    const { paths, attributesById } = traverseAllPaths(rules);
    const attributes = rules.attributes || [];
    const rows = [];
    let n = 1;

    // 1) Normal rows — one per full root-to-outcome path
    for (const p of paths) {
      const facts = buildFacts(attributes, p.constraints, 'normal');
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
        const facts = buildFacts(attributes, constraintsCopy, 'normal');

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
    const baseline = paths.length ? buildFacts(attributes, paths[0].constraints, 'normal') : {};
    for (const attribute of attributes) {
      const kinds = [];
      if (attribute.type === 'number') kinds.push('outOfRange', 'wrongType');
      if (attribute.type === 'boolean') kinds.push('wrongType');
      if (attribute.type === 'enum') kinds.push('badEnum');
      kinds.push('missing');

      for (const kind of kinds) {
        const facts = Object.assign({}, baseline);
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

  return {
    OPERATORS,
    evaluateCondition,
    loadRealEngine,
    getEngineStatus,
    run,
    validateRules,
    traverseAllPaths,
    generateTestSuite,
    testSuiteToCSV,
    buildFacts,
    pickValue,
    valueForBranch,
  };
});
