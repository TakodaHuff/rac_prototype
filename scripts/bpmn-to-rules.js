// Command line for the BPMN importer in js/bpmn.js: converts a BPMN file
// and writes rules.json (or --out <file>) in the project's layout.
//
//   npm run import:bpmn -- <file.bpmn> [--out <rules.json>]
const fs = require('fs');
const path = require('path');
const RaC = require('../js/logic.js');
const { bpmnToRules, importReport } = require('../js/bpmn.js');

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

// Remember which BPMN this rules.json came from (relative to the project
// folder); npm test re-imports it and compares the two.
rules.meta.bpmnFile = path.relative(path.join(__dirname, '..'), path.resolve(bpmnFile)).split(path.sep).join('/');
fs.writeFileSync(outFile, RaC.formatRules(rules));

const validation = RaC.validateRules(rules);
console.log('Wrote ' + outFile + ': ' + importReport(rules, report, validation));
console.log('\nNext: review the changes (git diff), then run "npm run build:docs" and "npm test".');
process.exit(validation.errors.length ? 1 : 0);
