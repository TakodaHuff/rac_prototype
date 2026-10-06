// Build script: regenerates rules.js from rules.json, so the app has a
// fallback copy of the data that works even when index.html is opened
// directly via file:// (where fetch() of a sibling file is blocked by the
// browser). Run with `npm run build:rules` any time rules.json changes.
// rules.json stays the single source of truth — rules.js is just a
// generated snapshot of it, loaded as a plain <script> tag instead of
// fetched, since file:// does allow that.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'rules.json');
const dest = path.join(__dirname, 'rules.js');

const json = fs.readFileSync(src, 'utf8');
JSON.parse(json); // fail loudly here, not silently in the browser, if rules.json is broken

const banner =
  '// GENERATED FILE — do not edit by hand.\n' +
  '// Run "npm run build:rules" after changing rules.json to regenerate this.\n';
fs.writeFileSync(dest, banner + 'window.RAC_RULES = ' + json + ';\n');
console.log('Wrote rules.js from rules.json (' + json.length + ' bytes).');
