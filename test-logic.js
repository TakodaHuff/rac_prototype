// Quick sanity check for logic.js against the alcohol demo data.
// Run with: node test-logic.js
const fs = require('fs');
const RaC = require('./logic.js');

const rules = JSON.parse(fs.readFileSync(__dirname + '/sample-data/alcohol-rules.json', 'utf8'));

function assert(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('ok  - ' + msg);
}

async function main() {
  // 0) Report which condition-evaluation engine is active (real
  //    json-rules-engine if installed via npm, offline fallback otherwise).
  await RaC.loadRealEngine();
  console.log('Engine:', RaC.getEngineStatus());

  // 1) Validation should pass clean
  const { errors, warnings } = RaC.validateRules(rules);
  console.log('Validation errors:', errors);
  console.log('Validation warnings:', warnings);
  assert(errors.length === 0, 'sample rules file validates with no errors');

  // 2) Spot-check run() against known scenarios from the diagram
  const cases = [
    [{ age: 25, visibly_intoxicated: false }, 'OUT_CanBuyAnywhere'],
    [{ age: 25, visibly_intoxicated: true }, 'OUT_CannotBuy'],
    [{ age: 19, visibly_intoxicated: false }, 'OUT_FolkOnly'],
    [{ age: 19, visibly_intoxicated: true }, 'OUT_CannotBuy'],
    [{ age: 17, visibly_intoxicated: false }, 'OUT_CannotBuy'],
    [{ age: 20, visibly_intoxicated: false }, 'OUT_CanBuyAnywhere'], // boundary
    [{ age: 18, visibly_intoxicated: false }, 'OUT_FolkOnly'], // boundary
  ];
  for (const [facts, expected] of cases) {
    const result = await RaC.run(rules, facts);
    assert(result.outcomeId === expected,
      `run(${JSON.stringify(facts)}) => ${result.outcomeId} (expected ${expected}), path=${result.path.join('>')}`);
  }

  // 3) Path traversal should find exactly 5 distinct root-to-outcome paths:
  //    Q1T-Q2T, Q1T-Q2F, Q1F-Q3T-Q4T, Q1F-Q3T-Q4F, Q1F-Q3F
  const { paths } = RaC.traverseAllPaths(rules);
  console.log('\nAll paths:');
  for (const p of paths) {
    console.log(' ', p.steps.map(s => `${s.nodeId}=${s.branch}`).join(' > '), '->', p.outcomeId, JSON.stringify(p.constraints));
  }
  assert(paths.length === 5, 'exactly 5 root-to-outcome paths found');

  // 4) Generate the test suite and verify every generated "normal"/"boundary" row
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

  // 5) CSV export sanity
  const csv = RaC.testSuiteToCSV(suite, rules.attributes);
  console.log('\n--- CSV preview (first 6 lines) ---');
  console.log(csv.split('\r\n').slice(0, 6).join('\n'));

  console.log('\nALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
