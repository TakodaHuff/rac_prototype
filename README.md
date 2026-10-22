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

The decision tree is drawn in BPMN (bpmn.io, Camunda Modeler) and kept as **`rules.bpmn`** next to `rules.json`. `js/bpmn.js` turns it into `rules.json`, keeping every node ID. It runs in two places:

- **Command line** — writes `rules.json` directly:

  ```
  npm run import:bpmn -- rules.bpmn
  ```

- **Browser** — Author view → **Upload BPMN**. The converted rules replace the ones in the browser tab and a report shows what changed. **Download JSON** then saves them as `rules.json`; replace the file in the repo and save the BPMN as `rules.bpmn`, as the report says.

| BPMN | rules.json |
|---|---|
| Exclusive gateway `Q1_1` named `Q1.1 Question text? (Ch. 25 Sec. 13 Companies Act)` | Yes/no decision node `Q1_1` with `question` and `citation` |
| Arrows named `Yes…` / `No…` | `true` / `false` targets; a note after the dash (`No – defect: not convened`) goes into a new question's supportive text |
| End event | Outcome node; its name becomes the `description` |
| Start event | `start` |
| Task or intermediate event with one outgoing arrow | passed through |

**Update, not replace.** The import is meant for new versions of the same tree. For every node ID that still exists, it takes the left column below from the BPMN and keeps the right column from the current `rules.json`:

| From the BPMN (change it there) | Kept from rules.json (edit in the Build tab) |
|---|---|
| Questions, operator and value | Supportive texts (stödtext) |
| Citations | Short outcome labels |
| Yes/No targets, start node | Variables (data dictionary) |
| Defect warnings (a `No – defect…` arrow that leads on to another question) | Glossary |
| Outcome descriptions | Title, intro, audience, disclaimer |

A variable's `source` follows a changed citation; a variable `label` that differs from a changed question is kept and listed for review. New questions get a yes/no variable and a `TODO (stödtext)` marker. The import stores the BPMN's path in `meta.bpmnFile`; `npm test` re-imports that file and checks that it still gives the same tree as `rules.json`.

**A different law:** in the browser, click **New** first and then **Upload BPMN** — nothing is kept, and the rule set is named after the BPMN process. On the command line, import into a new file with `--out <new file>.json`.

In the Build tab, fields filled by the import carry a **from BPMN** mark, and a note at the top says which BPMN the rules came from. The import report lists what came from the BPMN, what was kept, and what is still to add in the Build tab.

**Defect warnings.** When an arrow's note contains "defect" and the arrow leads on to another question (e.g. Q2.2 `No – defect noted: auditor review missing`), the import stores the note as `"warnings": { "false": "Defect noted: auditor review missing." }` on that question. The result page then lists every defect noted on the way, and `decide()` returns them as `warnings`. Defect arrows that end the tree (e.g. Q2.1 → Liab_1) need no warning, because the outcome itself says so.

Every gateway must be exclusive (XOR) with exactly one `Yes` and one `No` arrow; otherwise nothing is written and the problems are listed. Questions that need a number or a choice instead of yes/no come in as yes/no — set their `type`, `values`/`min`/`max` and condition in `rules.json` afterwards. Use `--out <file>` to write somewhere other than `rules.json`.

### Updating to a new BPMN

1. Replace `rules.bpmn` with the new file (keep the name).
2. Import it (this overwrites `rules.json`):

   ```
   npm run import:bpmn -- rules.bpmn
   ```

   Or in the browser: Author view → **Upload BPMN** → **Download JSON**, and replace `rules.json` with the downloaded file.

3. Read the printed report: new, removed and changed nodes, questions that still need supportive text, and whether the data dictionary checks pass.
4. Review the changes with `git diff rules.json`. Question texts are taken from the BPMN exactly as written; supportive texts, short outcome labels, intro texts and variables are kept.
5. Regenerate the report files and run the tests:

   ```
   npm run build:docs
   npm test
   ```

6. Commit `rules.json`, the new BPMN and the `docs/` files together.

The import never changes the BPMN, and git keeps the previous `rules.json`, so a bad import can be undone with `git checkout rules.json`.

**For whoever draws the BPMN:**
- Every gateway needs exactly one arrow whose name starts with `Yes` and one starting with `No`. A note after a dash (`No – defect: …`) is fine and goes into the supportive text.
- Questions that ask for an amount, a date or a choice between several options are imported as yes/no, because the diagram doesn't say otherwise. List them for the IS team, who then set their `type` and condition in `rules.json`.

## Runner (command line)

`scripts/runner.js` executes a rules file without the browser. Requires `npm install`.

Decide one case — prints the outcome, the decision path and any defect warnings, or `ERROR` with the field:

```
npm run decide -- '{"q1_1_equity_below_half": false, "q1_2_enforcement_insufficient": false}'
```

```
{"outcome":"No duty to prepare a control balance sheet","path":["Q1_1","Q1_2","End_1"],"warnings":[]}
```

Run a test file — one PASS/FAIL line per test (outcome **and** path are compared) and a summary, also written to `docs/test-run.log` as execution evidence:

```
npm run test:suite
```

Any other test file works too:

```
node scripts/runner.js test rules.json path/to/our-test-cases.csv --log docs/our-test-run.log
```

The test file uses the columns of the generated suite: `test_id, description`, one column per variable id, `expected_outcome` (the outcome label, its node id, or `ERROR`), `expected_path(node_ids)` (e.g. `Q1_1>Q1_2>End_1`; empty for `ERROR`) and `edge_class`. Empty cells are missing inputs. Any other column name is rejected, so a misspelled variable id is reported instead of being read as a missing input.

## Files

```
index.html          the page: markup only
rules.bpmn          the decision tree (BPMN), source of rules.json
rules.json          the law the site runs
css/styles.css      all styles (light and dark theme)
js/logic.js         core logic, no DOM
js/bpmn.js          BPMN importer (browser and command line)
js/app.js           UI
vendor/             prebuilt json-rules-engine bundle
scripts/            build tooling (not loaded by the site)
test/               npm test
docs/               report deliverables (data dictionary, glossary, test suite)
```

- `rules.json` — **the** rules file: the law the site runs, including the data dictionary. The only source of truth; **New**, **Upload JSON** and **Upload BPMN** in the Author view only change the rules in the browser tab until you download them.
- `index.html` — markup and the page itself; styles are in `css/styles.css`.
- `js/logic.js` — condition evaluation, rules and input validation (data dictionary), `decide()`, path traversal, test-suite generation and running. No DOM; runs in Node.
- `js/app.js` — UI, built on `js/logic.js`.
- `test/test-logic.js` — `npm test`. Requires `npm install`. Checks that `rules.json` and its data dictionary validate, that the checks catch broken rules files, that every generated row gives its expected outcome and path (negative rows: `ERROR`), that `docs/test-suite-full.csv` passes in the runner, that the `docs/` files are up to date, and that importing the BPMN named in `meta.bpmnFile` gives the same tree as `rules.json`.
- `scripts/runner.js` — the command-line runner (`npm run decide`, `npm run test:suite`).
- `js/bpmn.js` — the BPMN importer, used by **Upload BPMN** and by `scripts/bpmn-to-rules.js` (`npm run import:bpmn`).
- `scripts/build-docs.js` — regenerates the `docs/` report files from `rules.json` (`npm run build:docs`).
- `scripts/engine-bundle-src.js`, `scripts/build-vendor.js` — build the browser engine bundle (`npm run build:engine`).
- `vendor/json-rules-engine.bundle.js` — committed, prebuilt. Not hand-edited.
- `rules.bpmn` — the Law students' decision tree in BPMN; `rules.json` is imported from it (node IDs match).
- `docs/data-dictionary.csv`/`.json`, `docs/glossary.csv`, `docs/test-suite-full.csv` — generated from `rules.json` for the report by `npm run build:docs`. `npm test` fails if they are out of date.

## Condition evaluation

Every condition runs through the real `json-rules-engine` — no reimplementation, no CDN.

- Node: `require('json-rules-engine')`.
- Browser: `vendor/json-rules-engine.bundle.js` (loads before `js/logic.js`, sets `window.JsonRulesEngine`).

If neither is available, `evaluateCondition` throws — badge reads "not loaded", Play tab shows the error. Run Setup.

## Views

The header switch picks the view; `#author` in the URL opens the Author view directly.

- **Check a rule** (default) — only the questionnaire, for people checking the rule.
- **Author** — adds the toolbar (New, Upload JSON, Upload BPMN, Download JSON, Download CSV, engine badge) and the Build and Test suite tabs.

## Tabs

- **Play** — starts with an intro (what the tool checks, who it's for, a "not legal advice" note), then one question per screen. Shows "Question N of up to M" (M = longest possible path from here) and each question's legal source, linked to the law text, plus a collapsible explanation (with the Swedish term and legal source) of any glossary term the question uses. Placeholder text starting with `TODO` (e.g. `TODO (stödtext)`) is hidden. Each answer is checked against the data dictionary before the next question. Ends with the outcome and the glossary terms it uses, the decision path (node IDs), a list of your answers with their sources (**Change** jumps back to any of them; answers given before stay highlighted), and **Print / save as PDF**, which prints just the result.
- **Build** — edit `rules.json`: law details, data dictionary, glossary, nodes, start node. For rules imported from a BPMN, a note at the top and **from BPMN** marks show which fields the next import overwrites. A flowchart shows the whole tree; click a box to jump to that node's editor, or **↓** to save it as an SVG (e.g. for the report). The flowchart uses Mermaid, loaded from cdn.jsdelivr.net the first time the Build tab opens, so it needs an internet connection. Validates on every edit (data dictionary, missing refs, missing outcomes, cycles, unreachable nodes). Deleting a node or variable never re-points what used it: those dropdowns show **⚠ missing** and validation lists them until you choose another. Edits stay in the browser — **Download JSON** saves them as `rules.json` in the same layout as the repo file (one variable or node per line); replace the file in the repo to make them permanent.
- **Test suite** — one row per path, one boundary row per numeric threshold, one negative row per variable. **Download CSV** in the toolbar. Columns: `test_id, description, inputs, expected_outcome, expected_path(node_ids), edge_class`. Draft — review before submitting.

## rules.json schema

```jsonc
{
  "meta": {
    "title": "...", "shortTitle": "Page header", "subtitle": "Line above the header",
    "description": "...", "legalSource": "...", "lawUrl": "https://www.riksdagen.se/...",
    "intro": "What this tool checks.", "audience": "Who it is for.", "disclaimer": "Not legal advice."
  },
  "glossary": [
    { "term": "control balance sheet", "swedish": "kontrollbalansräkning", "definition": "...", "source": "Ch. 25 Secs. 13–14 Companies Act." }
  ],
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
- `glossary`: the defined legal terms, written by the Law team. When a question or an outcome contains a `term` (whole words, case-insensitive), it is shown under it with its `swedish` term, `definition` and `source`. Terms whose definition is empty or `TODO` are hidden. `validateRules` reports a duplicate term as an error, and a missing definition or source, or a term that appears in no question or outcome, as a warning. `docs/glossary.csv` is generated from it for the report. Edit it in the Build tab (section 3, Glossary) or in the file.
- `meta.shortTitle` and `meta.subtitle`: the page header (fall back to `meta.title` and `meta.legalSource`).
- `meta.bpmnFile`: the BPMN this file was imported from (set by `npm run import:bpmn`, checked by `npm test`).
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
