# Rules as Code Prototype

ISAD20/JPA005 JSON-track app. Encodes a law as `rules.json`, runs it as a questionnaire.

The current `rules.json` covers control balance sheets and the duty to liquidate (25 kap. 13–20 §§ aktiebolagslagen).

The code contains no legal logic. Every question, branch, outcome and input rule is read from `rules.json`, so any rules file that follows the [schema](#rulesjson-schema) runs unchanged — in the site, the runner and the tests. To change the rule, edit `rules.json`; no code changes needed.

## Use cases

- **Board members of small limited companies (aktiebolag)** checking their duties once equity may have dropped below half of the registered share capital: what to do next, and when personal liability can arise.
- **Accountants and auditors** walking a client through the steps (control balance sheet, control meetings, court application) and printing the result for the file.
- **Law and business students** learning chapter 25: following each step with its legal source next to it.

## Setup

`vendor/json-rules-engine.bundle.js` is prebuilt and committed — the site works with no setup. Rebuild only after changing the `json-rules-engine` version:

```
npm install
npm run build:engine
```

## Run

The page loads `rules.json` with `fetch()`, which browsers block for `file://` pages — so serve the folder rather than opening `index.html` directly:

```
python3 -m http.server
```

then open `http://localhost:8000/`. On GitHub Pages it works as-is.

## Importing the BPMN

`scripts/bpmn-to-rules.js` turns the decision tree drawn in BPMN (bpmn.io, Camunda Modeler) into `rules.json`, keeping every node ID:

```
npm run import:bpmn -- docs/final.bpmn
```

| BPMN | rules.json |
|---|---|
| Exclusive gateway `Q1_1` named `Q1.1 Question text? (Ch. 25 Sec. 13 Companies Act)` | Yes/no decision node `Q1_1` with `question` and `citation` |
| Arrows named `Yes…` / `No…` | `true` / `false` targets; a note after the dash (`No – defect: not convened`) goes into the supportive text |
| End event | Outcome node; its name becomes the `description` |
| Start event | `start` |
| Task or intermediate event with one outgoing arrow | passed through |

Questions, citations, branches and outcome descriptions always come from the BPMN. What the BPMN doesn't hold is kept from the existing `rules.json` for every node ID that still exists: `meta`, `glossary`, short outcome labels, supportive texts and the variables in the data dictionary. New questions get a yes/no variable and a `TODO (stödtext)` marker. The import prints which nodes were added, removed or changed, which questions still need supportive text, and the validation result.

Every gateway must be exclusive (XOR) with exactly one `Yes` and one `No` arrow; otherwise nothing is written and the problems are listed. Questions that need a number or a choice instead of yes/no come in as yes/no — set their `type`, `values`/`min`/`max` and condition in `rules.json` afterwards. Use `--out <file>` to write somewhere other than `rules.json`. After importing: review `git diff`, then `npm run build:docs` and `npm test`.

## Runner (command line)

`scripts/runner.js` executes a rules file without the browser. Requires `npm install`.

Decide one case — prints the outcome and the decision path, or `ERROR` with the field:

```
npm run decide -- '{"q1_1_equity_below_half": false, "q1_2_enforcement_insufficient": false}'
```

```
{"outcome":"No duty to prepare a control balance sheet","path":["Q1_1","Q1_2","End_1"]}
```

Run a test file — one PASS/FAIL line per test (outcome **and** path are compared) and a summary, also written to `docs/test-run.log` as execution evidence:

```
npm run test:suite
```

Any other rules or test file works too:

```
node scripts/runner.js decide examples/calculation-example.json '{"equity_ratio": 0.3, "second_meeting": "Held in time"}'
node scripts/runner.js test rules.json path/to/our-test-cases.csv --log docs/our-test-run.log
```

The test file uses the columns of the generated suite: `test_id, description`, one column per variable id, `expected_outcome` (the outcome label, its node id, or `ERROR`), `expected_path(node_ids)` (e.g. `Q1_1>Q1_2>End_1`; empty for `ERROR`) and `edge_class`. Empty cells are missing inputs.

## Files

```
index.html          the page: markup only
rules.json          the law the site runs
css/styles.css      all styles (light and dark theme)
js/logic.js         core logic, no DOM
js/app.js           UI
vendor/             prebuilt json-rules-engine bundle
scripts/            build tooling (not loaded by the site)
test/               npm test
examples/           example rule files
docs/               BPMN source diagram and report deliverables
```

- `rules.json` — **the** rules file: the law the site runs, including the data dictionary. The only source of truth; **Upload JSON** in the Author view only tries another file in the browser tab.
- `index.html` — markup and the page itself; styles are in `css/styles.css`.
- `js/logic.js` — condition evaluation, rules and input validation (data dictionary), `decide()`, path traversal, test-suite generation and running. No DOM; runs in Node.
- `js/app.js` — UI, built on `js/logic.js`.
- `test/test-logic.js` — `npm test`. Requires `npm install`. Checks that `rules.json` and its data dictionary validate, that the checks catch broken rules files, that every generated row gives its expected outcome and path (negative rows: `ERROR`), that `docs/test-suite-full.csv` passes in the runner, that the `docs/` files are up to date, and that importing the BPMN in `docs/` gives the same tree as `rules.json`.
- `scripts/runner.js` — the command-line runner (`npm run decide`, `npm run test:suite`).
- `scripts/bpmn-to-rules.js` — the BPMN importer (`npm run import:bpmn`).
- `scripts/build-docs.js` — regenerates the `docs/` report files from `rules.json` (`npm run build:docs`).
- `scripts/engine-bundle-src.js`, `scripts/build-vendor.js` — build the browser engine bundle (`npm run build:engine`).
- `vendor/json-rules-engine.bundle.js` — committed, prebuilt. Not hand-edited.
- `docs/control-balance-sheet-website-v2.bpmn` — the BPMN diagram `rules.json` was translated from (node IDs match).
- `docs/data-dictionary.csv`/`.json`, `docs/test-suite-full.csv` — generated from `rules.json` for the report by `npm run build:docs`. `npm test` fails if they are out of date.

## Condition evaluation

Every condition runs through the real `json-rules-engine` — no reimplementation, no CDN.

- Node: `require('json-rules-engine')`.
- Browser: `vendor/json-rules-engine.bundle.js` (loads before `js/logic.js`, sets `window.JsonRulesEngine`).

If neither is available, `evaluateCondition` throws — badge reads "not loaded", Play tab shows the error. Run Setup.

## Views

The header switch picks the view; `#author` in the URL opens the Author view directly.

- **Check a rule** (default) — only the questionnaire, for people checking the rule.
- **Author** — adds the toolbar (New, Upload JSON, Download JSON, Download CSV, engine badge) and the Build and Test suite tabs.

## Tabs

- **Play** — starts with an intro (what the tool checks, who it's for, a "not legal advice" note), then one question per screen. Shows "Question N of up to M" (M = longest possible path from here) and each question's legal source, linked to the law text, plus a collapsible explanation of any glossary term the question uses. Placeholder text starting with `TODO` (e.g. `TODO (stödtext)`) is hidden. Each answer is checked against the data dictionary before the next question. Ends with the outcome, the decision path (node IDs), a list of your answers with their sources (**Change** jumps back to any of them; answers given before stay highlighted), and **Print / save as PDF**, which prints just the result.
- **Build** — edit `rules.json`: law details, data dictionary, nodes, start node. A flowchart shows the whole tree; click a box to jump to that node's editor, or **↓** to save it as an SVG (e.g. for the report). The flowchart uses Mermaid, loaded from cdn.jsdelivr.net the first time the Build tab opens, so it needs an internet connection. Validates on every edit (data dictionary, missing refs, missing outcomes, cycles, unreachable nodes). Edits stay in the browser — **Download JSON** saves them as `rules.json`; replace the file in the repo to make them permanent.
- **Test suite** — one row per path, one boundary row per numeric threshold, one negative row per variable. **Download CSV** in the toolbar. Columns: `test_id, description, inputs, expected_outcome, expected_path(node_ids), edge_class`. Draft — review before submitting.

## rules.json schema

```jsonc
{
  "meta": {
    "title": "...", "shortTitle": "Page header", "subtitle": "Line above the header",
    "description": "...", "legalSource": "...", "lawUrl": "https://www.riksdagen.se/...",
    "intro": "What this tool checks.", "audience": "Who it is for.", "disclaimer": "Not legal advice."
  },
  "glossary": [ { "term": "control balance sheet", "definition": "..." } ],
  "attributes": [
    { "id": "value", "label": "Value of the gift", "type": "number", "min": 0, "unit": "SEK", "example": 500, "source": "..." },
    { "id": "gift_type", "label": "Gift type", "type": "enum", "values": ["Christmas", "Anniversary", "Other"], "example": "Christmas", "source": "..." },
    { "id": "is_money", "label": "Is it a monetary gift?", "type": "boolean", "example": false, "source": "..." },
    { "id": "reserves", "label": "Untaxed reserves", "type": "number", "min": 0, "unit": "SEK", "default": 0, "example": 10000, "source": "..." }
  ],
  "start": "Q1",
  "nodes": {
    "Q1": {
      "type": "decision",
      "question": "Is the gift a Christmas gift?",
      "fact": "gift_type",
      "operator": "equal",
      "value": "Christmas",
      "supportiveText": "Shown near this question.",
      "citation": "Chapter X §Y",
      "true": "Q2",
      "false": "OUT_Taxable"
    },
    "OUT_Taxable": { "type": "outcome", "label": "Taxable", "description": "..." }
  }
}
```

- Node IDs: any string, stable across model/tests/report.
- Decision node: one condition, two targets (`true`, `false`).
- `inputMode: "yesno"`: ask the condition as Yes/No. For number-threshold questions; automatic for boolean facts.
- `meta.intro`, `meta.audience`, `meta.disclaimer`: shown on the intro screen; the disclaimer is also printed on the result. `meta.description` is for authors only and isn't shown.
- `glossary`: when a question contains a `term` (case-insensitive), its `definition` is shown under it. Terms whose definition is empty or `TODO` are hidden. Edit these in the file directly; the Build tab has no glossary editor.
- `meta.shortTitle` and `meta.subtitle`: the page header (fall back to `meta.title` and `meta.legalSource`).
- `meta.lawUrl`: the law text on riksdagen.se. A citation like `25 kap. 13 § ABL` or `Ch. 25 Sec. 13 Companies Act` links to `lawUrl#K25P13` (`12 b §` → `#K1P12b`, `25 kap. ABL` → `#K25`; ranges and lists use their first paragraph). Nodes without a citation show `meta.legalSource`.
- Outcome node: leaf. `label` is shown and used as `expected_outcome`.
- Operators: `equal, notEqual, lessThan, lessThanInclusive, greaterThan, greaterThanInclusive, in, notIn`.
- Attribute types: `number, boolean, enum, string`. `min`/`max` for numbers, `values` for enums.

### Data dictionary

`attributes` is the data dictionary: one entry per input the decision needs. `docs/data-dictionary.csv` is generated from it for the report.

| Field | Meaning |
|---|---|
| `id` | Variable name used in nodes, tests and the runner. |
| `label` | What it means, shown to users. |
| `type` | `boolean`, `number`, `enum` or `string`. |
| `values` | Allowed values (enum only). |
| `min` / `max` | Allowed range (number only). |
| `unit` | Unit or format, e.g. `SEK` (optional). |
| `default` | Null policy: used when the value is missing. Without a default, a missing value is an error once the decision reaches its question. |
| `example` | A typical valid value. |
| `source` | Legal reference. |

**Checks.** `validateRules` (Build tab, runner, `npm test`) reports a rules file whose data dictionary is broken: duplicate or missing ids, unknown types, an enum without values, `min` > `max`, an invalid `default` or `example`, a node that compares a variable with a value of the wrong type or one not in its `values` (e.g. `"true"` instead of `true`), a number operator on a non-number variable, and variables no node uses (warning).

Every input is checked against the data dictionary before the engine runs — in the questionnaire, in `decide()` and in the runner: wrong type, out of range, not an allowed value, or missing when needed. Invalid input gives `{"outcome": "ERROR", "errors": [{"field": "...", "error": "..."}]}` instead of an outcome.

## Final rules.json checklist

- Keep it at the project root as `rules.json`, and keep `meta.lawUrl`.
- `npm test` passes with no errors and no warnings.
- Citations name the paragraph (`25 kap. 13 §`), not just the chapter (`25 kap. ABL`), so they deep-link.
- Intro, audience and disclaimer texts reviewed, and every glossary term has a definition.
- Every variable has a `label`, `source` and `example`; numbers have their range and unit; optional inputs have a `default`.
- No `TODO (stödtext)` left. Only text starting with `TODO` is hidden; anything else (e.g. "TBD") is shown to users.
- Every outcome has a clear `label` and a `description` explaining what the result means.
- One language for all user-facing text.
- Yes/no questions use `equal` / `true`, so "Yes" follows the `true` branch (as in the flowchart).
- No variable is used by two questions, or users are asked the same thing twice.
- Node IDs stay stable (flowchart, test CSV, decision path).
- To update: edit the file directly, or Author → Build → **Download JSON** and replace it; then run `npm run build:docs`, `npm test` and reload.

## Limitations

- One condition per node — model AND/OR as separate nodes.
- Boundary test generation assumes a fact's range isn't narrowed further later on the same path.
- The BPMN import reads yes/no gateways only; number and choice questions need their type and condition set by hand after importing.
