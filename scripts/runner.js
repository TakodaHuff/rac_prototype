// The runner for the JSON track: executes any rules.json without knowing
// anything about the law in it. All decision logic is read from the rules
// file; this script only parses arguments and prints results.
//
//   node scripts/runner.js decide <rules.json> <inputs>
//       <inputs> is a JSON object or a path to a .json file. Prints
//       {"outcome", "path"} or {"outcome": "ERROR", "errors": [...]}.
//
//   node scripts/runner.js test <rules.json> <tests.csv> [--log <file>]
//       Runs every row of the test file, prints PASS/FAIL per test and a
//       summary, and optionally writes the same report to a log file.
//       Exits with code 1 if any test fails.
const fs = require('fs');
const path = require('path');
const RaC = require('../js/logic.js');

function usage() {
  console.error('Usage:\n' +
    '  node scripts/runner.js decide <rules.json> <inputs.json | \'{"var": value}\'>\n' +
    '  node scripts/runner.js test <rules.json> <tests.csv> [--log <file>]');
  process.exit(2);
}

// Loads a rules file and refuses to run one that fails validation.
function loadRules(file) {
  const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { errors } = RaC.validateRules(rules);
  if (errors.length) {
    console.error(file + ' has validation errors:\n' + errors.map((e) => '  - ' + e).join('\n'));
    process.exit(1);
  }
  return rules;
}

async function decideCommand(rulesFile, inputArg) {
  const rules = loadRules(rulesFile);
  const text = fs.existsSync(inputArg) ? fs.readFileSync(inputArg, 'utf8') : inputArg;
  const result = await RaC.decide(rules, JSON.parse(text));
  const out = result.outcome === 'ERROR'
    ? { outcome: 'ERROR', errors: result.errors }
    : { outcome: result.outcome, path: result.path, warnings: result.warnings.map((w) => w.nodeId + ': ' + w.warning) };
  console.log(JSON.stringify(out));
  process.exit(result.outcome === 'ERROR' ? 1 : 0);
}

async function testCommand(rulesFile, testsFile, logFile) {
  const rules = loadRules(rulesFile);
  await RaC.loadRealEngine();
  const results = await RaC.runTestSuiteCSV(rules, fs.readFileSync(testsFile, 'utf8'));

  const lines = [
    'Test run: ' + new Date().toISOString(),
    'Rules:    ' + rulesFile + (rules.meta && rules.meta.title ? ' (' + rules.meta.title + ')' : ''),
    'Tests:    ' + testsFile,
    'Engine:   ' + RaC.getEngineStatus(),
    '',
  ];
  for (const r of results) {
    const got = r.actual.outcome === 'ERROR'
      ? 'ERROR (' + r.actual.errors.map((e) => e.field).join(', ') + ')'
      : '"' + r.actual.outcome + '" via ' + r.actual.path.join('>');
    lines.push((r.pass ? 'PASS ' : 'FAIL ') + r.test_id + ' [' + r.edge_class + '] ' + got + (r.pass ? '' : ' — ' + r.reason));
  }

  const failed = results.filter((r) => !r.pass);
  const byClass = {};
  results.forEach((r) => { byClass[r.edge_class || 'unclassified'] = (byClass[r.edge_class || 'unclassified'] || 0) + 1; });
  lines.push('');
  lines.push('Summary: ' + results.length + ' tests (' +
    Object.entries(byClass).map(([k, n]) => n + ' ' + k).join(', ') + ') — ' +
    (results.length - failed.length) + ' passed, ' + failed.length + ' failed.');

  const report = lines.join('\n');
  console.log(report);
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, report + '\n');
    console.log('\nLog written to ' + logFile);
  }
  process.exit(failed.length ? 1 : 0);
}

const [command, rulesFile, third, flag, logFile] = process.argv.slice(2);
if (!command || !rulesFile || !third) usage();
const run = command === 'decide' ? decideCommand(rulesFile, third)
  : command === 'test' ? testCommand(rulesFile, third, flag === '--log' ? logFile : null)
  : usage();
run.catch((e) => { console.error(e.message); process.exit(1); });
