# Rules as Code Prototype

ISAD20/JPA005 JSON-track app. Encodes a law as `rules.json`, runs it as a questionnaire.

## Setup

`vendor/json-rules-engine.bundle.js` is prebuilt and committed — `index.html` works with no setup. Rebuild only after changing the `json-rules-engine` version:

```
npm install
npm run build:engine
```

## Run

Open `index.html`. If `file://` is blocked: `python3 -m http.server`, then `http://localhost:8000/`.

## Files

- `index.html` — markup, CSS, and the page itself.
- `logic.js` — condition evaluation, validation, path traversal, test-suite generation. No DOM; runs in Node.
- `app.js` — UI, built on `logic.js`.
- `sample-data/*.json` — demo rules files. `alcohol-rules.json` is also embedded in `app.js`; the Swedish-law ones are illustrative only, not for submission.
- `test-logic.js` — `node test-logic.js` / `npm test`. Requires `npm install`.
- `engine-bundle-src.js`, `build-vendor.js` — build the browser engine bundle (`npm run build:engine`).
- `vendor/json-rules-engine.bundle.js` — committed, prebuilt. Not hand-edited.

## Condition evaluation

Every condition runs through the real `json-rules-engine` — no reimplementation, no CDN.

- Node: `require('json-rules-engine')`.
- Browser: `vendor/json-rules-engine.bundle.js` (loads before `logic.js`, sets `window.JsonRulesEngine`).

If neither is available, `evaluateCondition` throws — badge reads "not loaded", Play tab shows the error. Run Setup.

## Tabs

- **Play** — questionnaire, one question per screen. Ends with outcome, decision path, supportive text.
- **Build** — edit `rules.json`: data dictionary, nodes, start node. Validates on edit (missing refs, missing outcomes, cycles, unreachable nodes). Download JSON.
- **Test suite** — one row per path, one boundary row per numeric threshold, one negative row per variable. Download CSV. Columns: `test_id, description, inputs, expected_outcome, expected_path(node_ids), edge_class`. Draft — review before submitting.

## rules.json schema

```jsonc
{
  "meta": { "title": "...", "description": "...", "legalSource": "..." },
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
- Outcome node: leaf. `label` is shown and used as `expected_outcome`.
- Operators: `equal, notEqual, lessThan, lessThanInclusive, greaterThan, greaterThanInclusive, in, notIn`.
- Attribute types: `number, boolean, enum, string`. `min`/`max` for numbers, `values` for enums.

## Limitations

- One condition per node — model AND/OR as separate nodes.
- Boundary test generation assumes a fact's range isn't narrowed further later on the same path.
- No `.bpmn` import — BPMN-to-JSON is manual.
