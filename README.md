# Rules as Code Prototype

ISAD20/JPA005 JSON-track app. Encodes a law as `rules.json`, runs it as a questionnaire.

The current `rules.json` covers control balance sheets and the duty to liquidate (25 kap. 13–20 §§ aktiebolagslagen).

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

## Files

- `rules.json` — **the** rules file: the law the site runs. The only source of truth; there is no upload.
- `index.html` — markup, CSS, and the page itself.
- `logic.js` — condition evaluation, validation, path traversal, test-suite generation. No DOM; runs in Node.
- `app.js` — UI, built on `logic.js`.
- `test-logic.js` — `node test-logic.js` / `npm test`. Requires `npm install`. Checks that `rules.json` validates, every path ends at an outcome, and every generated test row matches the engine.
- `engine-bundle-src.js`, `build-vendor.js` — build the browser engine bundle (`npm run build:engine`).
- `vendor/json-rules-engine.bundle.js` — committed, prebuilt. Not hand-edited.

## Condition evaluation

Every condition runs through the real `json-rules-engine` — no reimplementation, no CDN.

- Node: `require('json-rules-engine')`.
- Browser: `vendor/json-rules-engine.bundle.js` (loads before `logic.js`, sets `window.JsonRulesEngine`).

If neither is available, `evaluateCondition` throws — badge reads "not loaded", Play tab shows the error. Run Setup.

## Views

The header switch picks the view; `#author` in the URL opens the Author view directly.

- **Check a rule** (default) — only the questionnaire, for people checking the rule.
- **Author** — adds the toolbar (Download JSON, engine badge) and the Build and Test suite tabs, plus the node-ID decision path on the result.

## Tabs

- **Play** — starts with an intro (what the tool checks, who it's for, a "not legal advice" note), then one question per screen. Shows "Question N of up to M" (M = longest possible path from here) and each question's legal source, linked to the law text, plus a collapsible explanation of any glossary term the question uses. Placeholder text starting with `TODO` (e.g. `TODO (stödtext)`) is hidden. Ends with the outcome, a list of your answers with their sources (**Change** jumps back to any of them; answers given before stay highlighted), and **Print / save as PDF**, which prints just the result.
- **Build** — edit `rules.json`: law details, data dictionary, nodes, start node. A flowchart shows the whole tree; click a box to jump to that node's editor. The flowchart uses Mermaid, loaded from cdn.jsdelivr.net the first time the Build tab opens, so it needs an internet connection. Validates on edit (missing refs, missing outcomes, cycles, unreachable nodes). Edits stay in the browser — **Download JSON** saves them as `rules.json`; replace the file in the repo to make them permanent.
- **Test suite** — one row per path, one boundary row per numeric threshold, one negative row per variable. **Download CSV** in the toolbar. Columns: `test_id, description, inputs, expected_outcome, expected_path(node_ids), edge_class`. Draft — review before submitting.

## rules.json schema

```jsonc
{
  "meta": {
    "title": "...", "description": "...", "legalSource": "...", "lawUrl": "https://www.riksdagen.se/...",
    "intro": "What this tool checks.", "audience": "Who it is for.", "disclaimer": "Not legal advice."
  },
  "glossary": [ { "term": "control balance sheet", "definition": "..." } ],
  "attributes": [
    { "id": "age", "label": "Age", "type": "number", "min": 0, "max": 130, "source": "..." },
    { "id": "gift_type", "label": "Gift type", "type": "enum", "values": ["Christmas", "Anniversary", "Other"], "source": "..." },
    { "id": "is_money", "label": "Is it a monetary gift?", "type": "boolean", "source": "..." }
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
- `meta.lawUrl`: the law text on riksdagen.se. A citation like `25 kap. 13 § ABL` links to `lawUrl#K25P13` (`25 kap. ABL` → `#K25`; ranges and lists use their first paragraph). Nodes without a citation show `meta.legalSource`.
- Outcome node: leaf. `label` is shown and used as `expected_outcome`.
- Operators: `equal, notEqual, lessThan, lessThanInclusive, greaterThan, greaterThanInclusive, in, notIn`.
- Attribute types: `number, boolean, enum, string`. `min`/`max` for numbers, `values` for enums.

## Final rules.json checklist

- Keep it at the project root as `rules.json`, and keep `meta.lawUrl`.
- `npm test` passes with no errors and no warnings.
- Citations name the paragraph (`25 kap. 13 §`), not just the chapter (`25 kap. ABL`), so they deep-link.
- Intro, audience and disclaimer texts reviewed, and every glossary term has a definition.
- No `TODO (stödtext)` left. Only text starting with `TODO` is hidden; anything else (e.g. "TBD") is shown to users.
- Every outcome has a clear `label` and a `description` explaining what the result means.
- One language for all user-facing text.
- Yes/no questions use `equal` / `true`, so "Yes" follows the `true` branch (as in the flowchart).
- No variable is used by two questions, or users are asked the same thing twice.
- Node IDs stay stable (flowchart, test CSV, decision path).
- To update: edit the file directly, or Author → Build → **Download JSON** and replace it; then run `npm test` and reload.

## Limitations

- One condition per node — model AND/OR as separate nodes.
- Boundary test generation assumes a fact's range isn't narrowed further later on the same path.
- No `.bpmn` import — BPMN-to-JSON is manual.
