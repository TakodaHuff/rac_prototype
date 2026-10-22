// Automated checks for js/logic.js against the project's rules.json.
// Run with: npm test (or node test/test-logic.js)
const fs = require('fs');
const path = require('path');
const RaC = require('../js/logic.js');
const { staleFiles } = require('../scripts/build-docs.js');
const { bpmnToRules } = require('../js/bpmn.js');

const root = path.join(__dirname, '..');
const rules = JSON.parse(fs.readFileSync(path.join(root, 'rules.json'), 'utf8'));
const copy = (o) => JSON.parse(JSON.stringify(o));

function assert(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('ok  - ' + msg);
}

async function main() {
  // 0) Report which condition-evaluation engine is active.
  await RaC.loadRealEngine();
  console.log('Engine:', RaC.getEngineStatus());

  // 1) rules.json, including its data dictionary, validates cleanly.
  const { errors, warnings } = RaC.validateRules(rules);
  if (errors.length) console.log('Validation errors:', errors);
  if (warnings.length) console.log('Validation warnings:', warnings);
  assert(errors.length === 0, 'rules.json validates with no errors');

  // 2) The data dictionary checks catch broken rules files.
  const brokenCases = [
    ['a comparison value of the wrong type', (r) => { r.nodes[r.start].value = 'true'; }, /compares .* with "true"/],
    ['a duplicate variable id', (r) => { r.attributes.push(copy(r.attributes[0])); }, /declared twice/],
    ['an unknown variable type', (r) => { r.attributes[0].type = 'colour'; }, /unknown type "colour"/],
    ['an invalid example value', (r) => { r.attributes[0].example = 'yes'; }, /"example" is "yes"/],
    ['a number operator on a non-number variable', (r) => { r.nodes[r.start].operator = 'lessThan'; }, /needs a number variable/],
    ['an enum without values', (r) => { r.attributes[0].type = 'enum'; delete r.attributes[0].example; }, /non-empty "values" list/],
    ['a glossary term listed twice', (r) => { r.glossary = (r.glossary || []).concat([{ term: 'Duplicate', definition: 'x' }, { term: 'duplicate', definition: 'y' }]); }, /listed twice/],
  ];
  for (const [name, breakIt, expected] of brokenCases) {
    const broken = copy(rules);
    breakIt(broken);
    const found = RaC.validateRules(broken).errors;
    assert(found.some((e) => expected.test(e)), 'validateRules reports ' + name);
  }

  // 3) decide() validates inputs against the data dictionary.
  const start = rules.nodes[rules.start];
  const missing = await RaC.decide(rules, {});
  assert(missing.outcome === 'ERROR' && missing.errors[0].field === start.fact,
    'a missing answer that the path needs gives ERROR for "' + start.fact + '"');
  const wrongType = await RaC.decide(rules, { [start.fact]: 'maybe' });
  assert(wrongType.outcome === 'ERROR' && /must be true or false/.test(wrongType.errors[0].error),
    'a wrong type ("maybe" for a boolean) gives ERROR');

  // 4) Every root-to-outcome path ends at an outcome node.
  const { paths } = RaC.traverseAllPaths(rules);
  assert(paths.length > 0, paths.length + ' root-to-outcome paths found');
  assert(paths.every((p) => rules.nodes[p.outcomeId].type === 'outcome'), 'every path ends at an outcome node');

  // 5) Every generated row gives its expected outcome and path through
  //    decide(); negative rows must give ERROR.
  const suite = RaC.generateTestSuite(rules);
  const failures = [];
  for (const row of suite) {
    const result = await RaC.decide(rules, row.inputs);
    const ok = row.edge_class === 'negative'
      ? result.outcome === 'ERROR'
      : result.outcome === row.expected_outcome && result.path.join('>') === row.expected_path;
    if (!ok) failures.push(row.test_id + ' [' + row.edge_class + '] got ' + JSON.stringify(result));
  }
  failures.slice(0, 10).forEach((f) => console.log('  ' + f));
  const count = (cls) => suite.filter((r) => r.edge_class === cls).length;
  assert(failures.length === 0, suite.length + ' generated rows (' + count('normal') + ' normal, ' + count('boundary') +
    ' boundary, ' + count('negative') + ' negative) give the expected outcome and path');

  // 6) The committed test file runs clean through the runner (outcome and path).
  const results = await RaC.runTestSuiteCSV(rules, fs.readFileSync(path.join(root, 'docs/test-suite-full.csv'), 'utf8'));
  results.filter((r) => !r.pass).slice(0, 10).forEach((r) => console.log('  FAIL ' + r.test_id + ': ' + r.reason));
  assert(results.every((r) => r.pass), 'docs/test-suite-full.csv: all ' + results.length + ' rows pass');

  // 7) The generated report files in docs/ match the current rules.json.
  const stale = staleFiles();
  assert(stale.length === 0, 'docs/ files are up to date' + (stale.length ? ' (stale: ' + stale.join(', ') + ' — run "npm run build:docs")' : ''));

  // 8) formatRules (Download JSON, the importer) changes only the layout:
  //    reading its output back gives exactly the same rules.
  const roundTrip = JSON.parse(RaC.formatRules(rules));
  assert(JSON.stringify(roundTrip) === JSON.stringify(rules), 'formatRules keeps every value of rules.json');

  // 9) The BPMN importer rebuilds the same tree from the BPMN that
  //    rules.json was made from (meta.bpmnFile, set by the importer):
  //    same nodes, branches and variables.
  const bpmnFile = rules.meta && rules.meta.bpmnFile;
  if (!bpmnFile) {
    console.log('skip - rules.json has no meta.bpmnFile, so there is no BPMN to compare with');
    console.log('\nALL CHECKS PASSED');
    return;
  }
  if (!fs.existsSync(path.join(root, bpmnFile))) {
    throw new Error('FAILED: rules.json was imported from ' + bpmnFile + ', but that file is missing. ' +
      'Save the BPMN there (or re-import it with "npm run import:bpmn -- <file>").');
  }
  const bpmn = fs.readFileSync(path.join(root, bpmnFile), 'utf8');
  const imported = bpmnToRules(bpmn, rules);
  assert(imported.errors.length === 0, bpmnFile + ' converts without errors');
  const sameTree = Object.keys(rules.nodes).join() === Object.keys(imported.rules.nodes).join() &&
    Object.entries(rules.nodes).every(([id, n]) => {
      const m = imported.rules.nodes[id];
      return m.type === n.type && m.true === n.true && m.false === n.false && m.fact === n.fact;
    });
  assert(sameTree && imported.rules.start === rules.start, 'importing ' + bpmnFile + ' gives the same nodes, branches and variables as rules.json');

  // 10) An update keeps the texts the BPMN doesn't hold; an import after
  //     "New" (empty rules) keeps nothing and names the rules after the process.
  const keptCount = Object.values(rules.nodes).filter((n) => n.type === 'decision' && n.supportiveText).length;
  assert(imported.report.kept.supportiveText === keptCount && imported.report.kept.glossary === (rules.glossary || []).length,
    'an update keeps the st\u00f6dtext (' + keptCount + ') and the glossary (' + (rules.glossary || []).length + ' terms)');
  const fresh = bpmnToRules(bpmn, { meta: { title: '', description: '' }, attributes: [], start: '', nodes: {} });
  assert(fresh.report.kept.supportiveText === 0 && fresh.report.kept.variables === 0 && fresh.rules.meta.title,
    'an import after "New" keeps nothing and is titled "' + fresh.rules.meta.title + '"');

  // 11) Defect warnings: the importer keeps them in step with the BPMN, and
  //     decide() reports the warning of every branch taken.
  const sameWarnings = Object.entries(rules.nodes).every(([id, n]) =>
    JSON.stringify(n.warnings || {}) === JSON.stringify(imported.rules.nodes[id].warnings || {}));
  assert(sameWarnings, 'the defect warnings in rules.json match ' + bpmnFile);
  const warned = Object.entries(rules.nodes).find(([, n]) => n.warnings && n.warnings.false);
  if (warned) {
    const [warnedId, warnedNode] = warned;
    const row = suite.find((r) => r.edge_class !== 'negative' && r.expected_path.split('>').includes(warnedId) &&
      r.inputs[warnedNode.fact] === false);
    const result = await RaC.decide(rules, row.inputs);
    assert(result.warnings.some((w) => w.nodeId === warnedId && w.warning === warnedNode.warnings.false),
      'decide() reports the defect warning at ' + warnedId + ' ("' + warnedNode.warnings.false + '")');
  }

  console.log('\nALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
