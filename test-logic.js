// Sanity check for logic.js against the project's rules.json.
// Run with: node test-logic.js
const fs = require('fs');
const RaC = require('./logic.js');

const rules = JSON.parse(fs.readFileSync(__dirname + '/rules.json', 'utf8'));

function assert(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('ok  - ' + msg);
}

async function main() {
  // 0) Report which condition-evaluation engine is active.
  await RaC.loadRealEngine();
  console.log('Engine:', RaC.getEngineStatus());

  // 1) Validation should pass clean
  const { errors, warnings } = RaC.validateRules(rules);
  console.log('Validation errors:', errors);
  console.log('Validation warnings:', warnings);
  assert(errors.length === 0, 'rules.json validates with no errors');

  // 1b) rules.js (the file:// fallback bundle, loaded as a plain <script>
  //     when fetch() of rules.json is blocked) must match what build-rules.js
  //     would generate from the CURRENT rules.json, or it's silently stale.
  const rulesJsPath = __dirname + '/rules.js';
  if (fs.existsSync(rulesJsPath)) {
    const rulesJsOnDisk = fs.readFileSync(rulesJsPath, 'utf8');
    const expectedRulesJs =
      '// GENERATED FILE — do not edit by hand.\n' +
      '// Run "npm run build:rules" after changing rules.json to regenerate this.\n' +
      'window.RAC_RULES = ' + fs.readFileSync(__dirname + '/rules.json', 'utf8') + ';\n';
    assert(rulesJsOnDisk === expectedRulesJs,
      'rules.js matches the current rules.json (run "npm run build:rules" if this fails)');
  } else {
    console.log('skip - rules.js not found, skipping fallback-bundle staleness check');
  }

  // 1c) Mirrors app.js's own validateFactValue (the UI's input validation),
  //     so the test suite checks the same rule the browser enforces. Kept
  //     here, not imported from app.js, since app.js is browser-only code
  //     (uses window/document) and can't be required() under Node.
  function validateFactValue(attribute, value) {
    if (!attribute) return null;
    if (value === undefined || value === null || value === '') return attribute.label + ' is required.';
    if (attribute.type === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) return attribute.label + ' must be a number.';
      if (typeof attribute.min === 'number' && value < attribute.min) return attribute.label + ' must be ≥ ' + attribute.min + '.';
      if (typeof attribute.max === 'number' && value > attribute.max) return attribute.label + ' must be ≤ ' + attribute.max + '.';
    }
    if (attribute.type === 'boolean' && typeof value !== 'boolean') {
      return attribute.label + ' must be true or false.';
    }
    if (attribute.type === 'enum' && Array.isArray(attribute.values) && !attribute.values.includes(value)) {
      return attribute.label + ' must be one of: ' + attribute.values.join(', ');
    }
    return null;
  }

  // 2) Every root-to-outcome path should end at an outcome node
  const { paths } = RaC.traverseAllPaths(rules);
  console.log('\nAll paths:');
  for (const p of paths) {
    console.log(' ', p.steps.map(s => `${s.nodeId}=${s.branch}`).join(' > '), '->', p.outcomeId);
  }
  assert(paths.length > 0, paths.length + ' root-to-outcome paths found');
  assert(paths.every(p => rules.nodes[p.outcomeId].type === 'outcome'), 'every path ends at an outcome node');

  // 3) Generate the test suite and verify every generated "normal"/"boundary" row
  //    actually produces the expected outcome when run back through run().
  const suite = RaC.generateTestSuite(rules);
  console.log('\nGenerated', suite.length, 'test rows');
  let checked = 0;
  for (const row of suite) {
    if (row.edge_class === 'negative') continue; // checked separately below, against validateFactValue
    const result = await RaC.run(rules, row.inputs);
    const label = (rules.nodes[result.outcomeId] || {}).label || result.outcomeId;
    assert(label === row.expected_outcome,
      `${row.test_id} [${row.edge_class}] inputs=${JSON.stringify(row.inputs)} -> "${label}" (expected "${row.expected_outcome}")`);
    checked++;
  }
  console.log(`\nChecked ${checked} generated normal/boundary rows against the engine — all consistent.`);

  // 3b) Negative/invalid rows must be rejected by validateFactValue before
  //     they'd ever reach the engine — the engine itself has no concept
  //     of "ERROR", so input validation is what's actually responsible for
  //     every row the generator marked expected_outcome: 'ERROR'.
  let negChecked = 0;
  for (const row of suite) {
    if (row.edge_class !== 'negative') continue;
    const fieldErrors = (rules.attributes || [])
      .map((a) => validateFactValue(a, row.inputs[a.id]))
      .filter(Boolean);
    assert(fieldErrors.length > 0,
      `${row.test_id} [negative] ${row.description} -> correctly rejected ("${fieldErrors[0]}")`);
    negChecked++;
  }
  console.log(`\nChecked ${negChecked} generated negative/invalid rows — all correctly rejected before reaching the engine.`);

  // 4) CSV export sanity
  const csv = RaC.testSuiteToCSV(suite, rules.attributes);
  console.log('\n--- CSV preview (first 6 lines) ---');
  console.log(csv.split('\r\n').slice(0, 6).join('\n'));

  console.log('\nALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
