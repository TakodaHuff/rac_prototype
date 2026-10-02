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
    if (row.edge_class === 'negative') continue; // these are intentionally malformed
    const result = await RaC.run(rules, row.inputs);
    const label = (rules.nodes[result.outcomeId] || {}).label || result.outcomeId;
    assert(label === row.expected_outcome,
      `${row.test_id} [${row.edge_class}] inputs=${JSON.stringify(row.inputs)} -> "${label}" (expected "${row.expected_outcome}")`);
    checked++;
  }
  console.log(`\nChecked ${checked} generated normal/boundary rows against the engine — all consistent.`);

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
