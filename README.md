# Rules as Code Prototype

ISAD20/JPA005 JSON-track app. Encodes a law as `rules.json`, runs it as a questionnaire.

The current `rules.json` covers control balance sheets and the duty to liquidate (25 kap. 13–20 §§ aktiebolagslagen).

The code contains no legal logic. Every question, branch, outcome and input rule is read from `rules.json`, so any rules file that follows the [schema](#rulesjson-schema) runs unchanged — in the site, the runner and the tests. To change the rule, edit `rules.json`; no code changes needed.

## Use cases

- **Board members of small limited companies (aktiebolag)** checking their duties once equity may have dropped below half of the registered share capital: what to do next, and when personal liability can arise.
- **Accountants and auditors** walking a client through the steps (control balance sheet, control meetings, court application) and printing the result for the file.
- **Law and business students** learning chapter 25: following each step with its legal source next to it.

## Quick start

1. Open the site: [takodahuff.github.io/rac_prototype](https://takodahuff.github.io/rac_prototype/). To run it locally, see [Run](#run).
2. **User** (the default view) is the questionnaire. Answer the questions to get a result, the legal source of each step, and the rule json-rules-engine checked at each step.
3. **Developer** adds the tools:
   - **Example** dropdown: switch between the Chapter 25 rules and the alcohol purchase example. A link ending in `?example=alcohol` opens the example directly.
   - **Upload BPMN / Upload JSON**: load your own decision tree. It replaces what's loaded.
   - **Build** tab: edit questions, variables (e.g. a maximum age) and outcomes. The flowchart, Play and the tests update immediately.
   - **Download JSON / Download BPMN**: save your changes. Edits only last until the page is reloaded, so download them.

## Run

The site needs no installing: the engine (`vendor/json-rules-engine.bundle.js`) is prebuilt and committed. The page loads its rules with `fetch()`, which browsers block for `file://` pages, so serve the folder instead of opening `index.html` directly:

```
python3 -m http.server      # Windows: py -m http.server
```

Then open `http://localhost:8000/`. On GitHub Pages it works as is.

The tests and command-line tools need Node.js. Run `npm install` once, then `npm test`. Rebuild the engine (`npm run build:engine`) only after changing the `json-rules-engine` version.

## BPMN

The Chapter 25 decision tree is drawn in BPMN (bpmn.io, Camunda Modeler) and kept as **`rules.bpmn`** next to `rules.json`. `js/bpmn.js` converts it, keeping every node ID.

- **Upload BPMN** (browser) replaces the loaded rules with the uploaded tree.
- **Download BPMN** draws the current rules, edits included, as a new BPMN diagram (laid out automatically). Everything the diagram doesn't show (variable ranges, supportive texts, short labels, glossary, intro texts) is saved inside the same file, so uploading it again gives back exactly the same rules. What the diagram shows still wins: a question renamed in bpmn.io is renamed in the rules too.
- **`npm run import:bpmn -- rules.bpmn`** (command line) updates `rules.json` from a new version of the tree (see [Updating to a new BPMN](#updating-to-a-new-bpmn)).

**How to draw it:**
- Use exclusive (XOR) gateways for questions. Each needs exactly one arrow whose name starts with `Yes` and one starting with `No`. A note after it (`No – too young`) is fine.
- For a number, write the condition in square brackets in the gateway's name: `How old is the person? [age >= 20 years]`. A later gateway with `[age >= 18 years]` reuses the age instead of asking again.
- Give every end event a name: it becomes the result.
- Start from `examples/alcohol-purchase-eligibility.bpmn` (or **Download BPMN** on the site), which uses all of the above.

| BPMN | rules.json |
|---|---|
| Exclusive gateway `Q1_1` named `Q1.1 Question text? (Ch. 25 Sec. 13 Companies Act)` | Decision node `Q1_1` with `question` and `citation` |
| `[age >= 20 years]` in a gateway's name | A number question: variable `age` (unit `years`), Yes when the condition holds (`>=`, `>`, `<=`, `<`, `=`, `!=`) |
| `[visibly_intoxicated]` in a gateway's name | Names its yes/no variable |
| Gateways with the same variable or the same question text | One shared variable: asked once, later gateways reuse the answer |
| Arrows named `Yes…` / `No…` | `true` / `false` targets (`Yes`, `Yes – note`, `Yes, note`, `Yes: note`); a note goes into a new question's supportive text |
| Arrow note containing "defect" that leads on to another question | A defect warning, listed on the result |
| End event | Outcome node; its name becomes the `description` (an unnamed one takes the text of the arrow or task leading into it) |
| Text annotation with `Title:`, `Law text: <url>`, `Legal source:`, `Intro:`, `Who it is for:`, `Disclaimer:` lines | The rule set's title, law link and intro texts |
| Start event | `start` |
| Task or intermediate event with one outgoing arrow | Passed through |
| Rules saved in `<extensionElements>` (written by **Download BPMN**) | Everything the diagram doesn't show |

Questions without a `[variable >= number]` condition come in as yes/no; a multiple-choice question needs its `type` and `values` set in the Build tab afterwards. If a gateway breaks these rules, nothing is loaded and the problems are listed.

### Updating to a new BPMN

The command line updates rather than replaces: for every node ID that still exists, it takes the left column from the BPMN and keeps the right column from the current `rules.json`.

| From the BPMN (change it there) | Kept from rules.json (edit in the Build tab) |
|---|---|
| Questions, operator and value | Supportive texts (stödtext) |
| Citations | Short outcome labels |
| Yes/No targets, start node | Variables (data dictionary) |
| Defect warnings | Glossary |
| Outcome descriptions | Title, intro, audience, disclaimer |

1. Replace `rules.bpmn` with the new file (keep the name).
2. Run `npm run import:bpmn -- rules.bpmn`. This overwrites `rules.json` and prints a report: new, removed and changed nodes, and questions still without a supportive text. (Use `--out <file>.json` to write a different file, e.g. for a different law.)
3. Review the changes with `git diff rules.json`.
4. Run `npm run build:docs` and `npm test`.
5. Commit `rules.json`, `rules.bpmn` and the `docs/` files together.

A bad import can be undone with `git checkout rules.json`; the import never changes the BPMN. `npm test` re-imports the BPMN named in `meta.bpmnFile` and checks that it still gives the same tree as `rules.json`.

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
js/bpmn.js          BPMN import and export (browser and command line)
js/app.js           UI
vendor/             prebuilt json-rules-engine bundle
scripts/            build tooling (not loaded by the site)
test/               npm test
docs/               report deliverables (data dictionary, glossary, test suite)
examples/           example rule sets for the Example dropdown, listed in examples.json
```

- `rules.json` — **the** rules file: the law the site runs, including the data dictionary. The only source of truth; **New**, **Upload JSON** and **Upload BPMN** in the Developer view only change the rules in the browser tab until you download them.
- `index.html` — markup and the page itself; styles are in `css/styles.css`.
- `icons/` — the site icon: `favicon.svg` (modern browsers), `favicon.ico` (16/32/48 px, older browsers) and `apple-touch-icon.png` (180 px, phone home screens). Blue rounded square with a white § and a gold line; the § is an outline of the Gelasio Bold font (SIL Open Font License).
- `js/logic.js` — condition evaluation, rules and input validation (data dictionary), `decide()`, path traversal, test-suite generation and running. No DOM; runs in Node.
- `js/app.js` — UI, built on `js/logic.js`.
- `test/test-logic.js` — `npm test`. Requires `npm install`. Checks that `rules.json` and its data dictionary validate, that the checks catch broken rules files, that every generated row gives its expected outcome and path (negative rows: `ERROR`), that `docs/test-suite-full.csv` passes in the runner, that the `docs/` files are up to date, that importing the BPMN named in `meta.bpmnFile` gives the same tree as `rules.json`, that **Download BPMN** files upload again as the same rules, and that every example loads.
- `scripts/runner.js` — the command-line runner (`npm run decide`, `npm run test:suite`).
- `js/bpmn.js` — the BPMN importer, used by **Upload BPMN** and by `scripts/bpmn-to-rules.js` (`npm run import:bpmn`), and the exporter behind **Download BPMN**.
- `scripts/build-docs.js` — regenerates the `docs/` report files from `rules.json` (`npm run build:docs`).
- `scripts/engine-bundle-src.js`, `scripts/build-vendor.js` — build the browser engine bundle (`npm run build:engine`).
- `vendor/json-rules-engine.bundle.js` — committed, prebuilt. Not hand-edited.
- `rules.bpmn` — the Law students' decision tree in BPMN; `rules.json` is imported from it (node IDs match).
- `examples/alcohol-purchase-eligibility.bpmn` — a small example tree for learning the format: number questions (age), a question asked once and reused, and the law link and intro texts in a text annotation. Pick it in the **Example** dropdown to try it; `npm test` checks that it imports.
- `examples/examples.json` — the list behind the **Example** dropdown: `[{ "id", "name", "file" }]`, with paths from the project root (`rules.json` is the default). To add an example, put its BPMN or JSON file in `examples/` and add one line here; `npm test` fails if a file in `examples/` isn't listed, or if a listed one doesn't load.
- `docs/data-dictionary.csv`/`.json`, `docs/glossary.csv`, `docs/test-suite-full.csv` — generated from `rules.json` for the report by `npm run build:docs`. `npm test` fails if they are out of date.

## Condition evaluation

Every condition runs through the real `json-rules-engine` — no reimplementation, no CDN.

- Node: `require('json-rules-engine')`.
- Browser: `vendor/json-rules-engine.bundle.js` (loads before `js/logic.js`, sets `window.JsonRulesEngine`).

There is no fallback: if neither is available, `evaluateCondition` throws, the badge reads "not loaded" and Play shows the error (see [Run](#run)). Every decision node is one engine run, so a result that reached an outcome was decided by the engine.

## Views

The header switch picks the view; `#developer` in the URL opens the Developer view directly. `?example=<id>` opens an example from `examples/examples.json` instead of `rules.json`, in either view (e.g. `?example=alcohol` as a link for students).

- **User** (default) — only the questionnaire, for people checking the rule.
- **Developer** — adds the toolbar (New, Upload JSON, Upload BPMN, Download JSON, Download BPMN, Download CSV) and the Build, Test suite and Test results tabs, with the **Example** dropdown and the engine badge at the right of the tab bar. Switching examples asks first if there are changes that haven't been downloaded.

## Tabs

- **Play** — the questionnaire.
  - Starts with an intro: what the tool checks, who it's for, and a disclaimer if one is set.
  - One question per screen, with "Question N of up to M", its legal source (linked to the law text) and any glossary terms it uses. A question whose answer is already known (e.g. "18 or older?" after the age) isn't asked again.
  - Each answer is checked against the data dictionary before the next question.
  - The result shows the outcome; your answers with the rule and legal source of each (**Change** goes back); **Checked by json-rules-engine**, the rule the engine ran at each question (e.g. `Q1  age ≥ 20 → false`); **Print / save as PDF**; and **See this result in the test suite**.
- **Build** — edit the rules: law details, data dictionary, glossary, nodes and start node.
  - A flowchart shows the whole tree; click a box to jump to its node, or **↓** to save it as an SVG. It uses Mermaid from cdn.jsdelivr.net, so it needs an internet connection.
  - Validates on every edit (data dictionary, missing targets and outcomes, cycles, unreachable nodes). Deleting a node or variable never re-points what used it: those dropdowns show **⚠ missing** until you choose another.
  - Edits stay in the browser tab. **Download JSON** saves them as `rules.json` in the repo's layout; **Download BPMN** saves them as a BPMN diagram.
- **Test suite** — the generated test cases as a table (the same as **Download CSV**): one row per path, one boundary row per number limit, one invalid-input row per variable. Columns: `test_id, description`, one per variable, `expected_outcome, expected_path(node_ids), edge_class`.
- **Test results** — every test case run through the engine, as readable cards: a pass/fail summary, filters, and cases grouped by outcome. Opening a card lists its questions, answers, result and whether the engine agreed.

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
- `meta.bpmnFile`: the BPMN this file was imported from (set by the import, checked by `npm test`).
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
- No `TODO` placeholders left. Text starting with `TODO` is hidden from users; anything else (e.g. "TBD") is shown.
- Every outcome has a clear `label` and a `description` explaining what the result means.
- One language for all user-facing text.
- Yes/no questions use `equal` / `true`, so "Yes" follows the `true` branch (as in the flowchart).
- Two questions share a variable only when they ask about the same thing (e.g. two age limits); the user is then asked once.
- Node IDs stay stable (flowchart, test CSV, decision path).
- To update: edit the file directly, or Developer → Build → **Download JSON** and replace it; then run `npm run build:docs`, `npm test` and reload.

## Limitations

- One condition per node — model AND/OR as separate nodes.
- Boundary test generation assumes a fact's range isn't narrowed further later on the same path.
- The BPMN import reads yes/no and number conditions; multiple-choice questions need their type and values set by hand after importing.
