// Generates the report files in docs/ from rules.json, so they can't drift
// from the rules the site runs:
//   docs/data-dictionary.csv / .json — the data dictionary table
//   docs/test-suite-full.csv         — the generated test suite
//
//   npm run build:docs            write the files
//   node scripts/build-docs.js --check
//                                 only compare; exit 1 if a file is out of date
//                                 (npm test runs this check)
const fs = require('fs');
const path = require('path');
const RaC = require('../js/logic.js');

const root = path.join(__dirname, '..');

// The expected content of each generated file, keyed by its path.
function expectedFiles() {
  const rules = JSON.parse(fs.readFileSync(path.join(root, 'rules.json'), 'utf8'));
  const dictionary = RaC.dataDictionary(rules);
  const suite = RaC.testSuiteToCSV(RaC.generateTestSuite(rules), rules.attributes || []);
  return {
    'docs/data-dictionary.csv': RaC.dataDictionaryToCSV(dictionary),
    'docs/data-dictionary.json': JSON.stringify(dictionary, null, 2),
    'docs/test-suite-full.csv': suite.replace(/\r\n/g, '\n'),
  };
}

// Returns the paths of generated files whose content on disk differs.
function staleFiles() {
  return Object.entries(expectedFiles())
    .filter(([file, content]) => {
      const full = path.join(root, file);
      return !fs.existsSync(full) || fs.readFileSync(full, 'utf8') !== content;
    })
    .map(([file]) => file);
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const stale = staleFiles();
    if (stale.length) {
      console.error('Out of date (run "npm run build:docs"): ' + stale.join(', '));
      process.exit(1);
    }
    console.log('docs/ files match rules.json.');
  } else {
    for (const [file, content] of Object.entries(expectedFiles())) {
      fs.writeFileSync(path.join(root, file), content);
      console.log('Wrote ' + file);
    }
  }
}

module.exports = { staleFiles };
