// Build entry for the browser bundle of the real json-rules-engine npm
// package. `npm run build:engine` (webpack) bundles this file, plus
// json-rules-engine and its dependencies, into vendor/json-rules-engine.bundle.js.
// index.html loads that file before logic.js, which reads Engine off
// window.JsonRulesEngine. See README.md.
import { Engine } from 'json-rules-engine';

window.JsonRulesEngine = { Engine };
