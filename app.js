/* app.js — UI wiring for the Rule-as-Code prototype. Depends on logic.js (window.RaC). */
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Embedded demo data (also saved as sample-data/alcohol-rules.json so it
  // works even when this file is opened directly with file:// and fetch()
  // of a sibling file would be blocked).
  // ---------------------------------------------------------------------
  const DEMO_RULES = {
    meta: {
      title: 'Alcohol Purchase Eligibility (demo)',
      description: 'Demo data.',
      legalSource: 'Demo'
    },
    attributes: [
      { id: 'age', label: 'Age', type: 'number', min: 0, max: 130, source: 'Demo' },
      { id: 'visibly_intoxicated', label: 'Visibly intoxicated?', type: 'boolean', source: 'Demo' }
    ],
    start: 'Q1',
    nodes: {
      Q1: { type: 'decision', inputMode: 'yesno', question: '20 years old or older?', fact: 'age', operator: 'greaterThanInclusive', value: 20, supportiveText: 'At 20+, alcohol of any strength can be bought, subject to the intoxication check.', citation: 'Demo §1', true: 'Q2', false: 'Q3' },
      Q2: { type: 'decision', question: 'Visibly intoxicated?', fact: 'visibly_intoxicated', operator: 'equal', value: true, supportiveText: 'Sale is refused to anyone visibly intoxicated, regardless of age.', citation: 'Demo §2', true: 'OUT_CannotBuy', false: 'OUT_CanBuyAnywhere' },
      Q3: { type: 'decision', inputMode: 'yesno', question: '18 years old or older?', fact: 'age', operator: 'greaterThanInclusive', value: 18, supportiveText: '18-19 year olds may only buy folk alcohol (low alcohol content).', citation: 'Demo §3', true: 'Q4', false: 'OUT_CannotBuy' },
      Q4: { type: 'decision', question: 'Visibly intoxicated?', fact: 'visibly_intoxicated', operator: 'equal', value: true, supportiveText: 'Sale is refused to anyone visibly intoxicated, regardless of age.', citation: 'Demo §2', true: 'OUT_CannotBuy', false: 'OUT_FolkOnly' },
      OUT_CannotBuy: { type: 'outcome', label: 'Cannot buy alcohol', description: 'The person may not purchase alcohol under these facts.' },
      OUT_CanBuyAnywhere: { type: 'outcome', label: 'Can buy alcohol anywhere', description: 'The person may purchase alcohol of any strength.' },
      OUT_FolkOnly: { type: 'outcome', label: 'Can buy folk alcohol only', description: 'The person may purchase only folk (low-alcohol) beverages.' }
    }
  };

  const EMPTY_RULES = { meta: { title: 'Untitled rules', description: '' }, attributes: [], start: '', nodes: {} };

  // ---------------------------------------------------------------------
  // Global state
  // ---------------------------------------------------------------------
  let rules = clone(DEMO_RULES);
  let playState = null; // { currentId, facts, history: [{nodeId, factId, value}] }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach((c) => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return e;
  }
  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------
  function initTabs() {
    $all('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $all('.tab-btn').forEach((b) => b.classList.remove('active'));
        $all('.tab-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        $('#tab-' + btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'play') renderPlay();
        if (btn.dataset.tab === 'build') renderBuild();
        if (btn.dataset.tab === 'tests') renderTests();
      });
    });
  }

  // ---------------------------------------------------------------------
  // File load / save (shared across tabs)
  // ---------------------------------------------------------------------
  function initFileControls() {
    $('#new-rules').addEventListener('click', () => {
      if (!confirm('Start a new, empty rules file? Unsaved changes will be lost.')) return;
      rules = clone(EMPTY_RULES);
      afterRulesChanged();
    });
    $('#upload-json').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          rules = JSON.parse(reader.result);
          afterRulesChanged();
          alert('Loaded "' + file.name + '". Check the Build tab for validation results.');
        } catch (err) {
          alert('Could not parse that file as JSON:\n' + err.message);
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });
    $('#download-json').addEventListener('click', () => {
      download((rules.meta && rules.meta.title ? slug(rules.meta.title) : 'rules') + '.json', JSON.stringify(rules, null, 2));
    });
  }

  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'rules'; }

  function afterRulesChanged() {
    playState = null;
    renderPlay();
    renderBuild();
    renderTests();
  }

  // ---------------------------------------------------------------------
  // PLAY tab — the click-through questionnaire
  // ---------------------------------------------------------------------
  function renderPlay() {
    const root = $('#play-root');
    root.innerHTML = '';

    const { errors } = RaC.validateRules(rules);
    if (errors.length) {
      root.appendChild(el('div', { class: 'notice notice-error' }, [
        el('strong', { text: 'This rules file has validation errors — fix them in the Build tab before playing:' }),
        el('ul', {}, errors.map((e) => el('li', { text: e })))
      ]));
      return;
    }

    if (!playState) {
      playState = { currentId: rules.start, facts: {}, history: [] };
    }

    const node = rules.nodes[playState.currentId];
    const attributesById = {};
    (rules.attributes || []).forEach((a) => { attributesById[a.id] = a; });

    const card = el('div', { class: 'card' });
    root.appendChild(card);

    if (rules.meta && rules.meta.title) {
      root.insertBefore(el('h2', { class: 'law-title', text: rules.meta.title }), card);
    }

    if (node.type === 'outcome') {
      const outcomePath = playState.history.map((h) => h.nodeId).concat([playState.currentId]);
      card.appendChild(el('div', { class: 'outcome-badge', text: node.label || playState.currentId }));
      if (node.description) card.appendChild(el('p', { text: node.description }));
      card.appendChild(el('h4', { text: 'Decision path' }));
      card.appendChild(el('div', { class: 'path-trace', text: outcomePath.join('  →  ') }));

      const trail = playState.history.filter((h) => h.supportiveText);
      if (trail.length) {
        card.appendChild(el('h4', { text: 'Relevant rules applied' }));
        const ul = el('ul', { class: 'supportive-list' });
        trail.forEach((h) => ul.appendChild(el('li', {}, [
          el('strong', { text: (h.citation ? h.citation + ': ' : '') }),
          document.createTextNode(h.supportiveText)
        ])));
        card.appendChild(ul);
      }

      card.appendChild(el('button', {
        class: 'btn btn-primary', text: 'Start over', onclick: () => { playState = null; renderPlay(); }
      }));
      return;
    }

    // progress
    card.appendChild(el('div', { class: 'progress-note', text: 'Question ' + (playState.history.length + 1) }));
    card.appendChild(el('h3', { class: 'question', text: node.question || node.fact }));
    if (node.supportiveText) card.appendChild(el('p', { class: 'supportive', text: node.supportiveText }));

    const attribute = attributesById[node.fact];
    const inputWrap = el('div', { class: 'answer-controls' });
    card.appendChild(inputWrap);
    const errorLine = el('div', { class: 'field-error' });
    card.appendChild(errorLine);

    async function commit(value) {
      // validate against the data dictionary before proceeding
      const err = validateFactValue(attribute, value);
      if (err) { errorLine.textContent = err; return; }
      inputWrap.querySelectorAll('button, input').forEach((n) => { n.disabled = true; });
      try {
        const branch = await RaC.evaluateCondition(node, Object.assign({}, playState.facts, { [node.fact]: value }));
        playState.facts[node.fact] = value;
        playState.history.push({ nodeId: playState.currentId, factId: node.fact, value, supportiveText: node.supportiveText, citation: node.citation });
        playState.currentId = branch ? node.true : node.false;
        renderPlay();
      } catch (e) {
        errorLine.textContent = e.message;
        inputWrap.querySelectorAll('button, input').forEach((n) => { n.disabled = false; });
      }
    }

    if (!attribute) {
      inputWrap.appendChild(el('div', { class: 'notice notice-error', text: 'Fact "' + node.fact + '" is not declared in attributes — cannot render an input.' }));
    } else if (node.inputMode === 'yesno') {
      // Ask the node's own condition directly as Yes/No instead of collecting
      // a raw value (e.g. "20 or older?" instead of a numeric age field).
      inputWrap.appendChild(el('button', { class: 'btn btn-choice', text: 'Yes', onclick: () => commit(RaC.valueForBranch(node, true)) }));
      inputWrap.appendChild(el('button', { class: 'btn btn-choice', text: 'No', onclick: () => commit(RaC.valueForBranch(node, false)) }));
    } else if (attribute.type === 'boolean') {
      inputWrap.appendChild(el('button', { class: 'btn btn-choice', text: 'Yes', onclick: () => commit(true) }));
      inputWrap.appendChild(el('button', { class: 'btn btn-choice', text: 'No', onclick: () => commit(false) }));
    } else if (attribute.type === 'enum') {
      (attribute.values || []).forEach((v) => {
        inputWrap.appendChild(el('button', { class: 'btn btn-choice', text: String(v), onclick: () => commit(v) }));
      });
    } else if (attribute.type === 'number') {
      const input = el('input', { type: 'number', class: 'text-input', placeholder: attribute.label });
      if (typeof attribute.min === 'number') input.min = attribute.min;
      if (typeof attribute.max === 'number') input.max = attribute.max;
      const btn = el('button', { class: 'btn btn-primary', text: 'Next' });
      btn.addEventListener('click', () => commit(input.value === '' ? undefined : Number(input.value)));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
      inputWrap.appendChild(input);
      inputWrap.appendChild(btn);
      input.focus();
    } else {
      const input = el('input', { type: 'text', class: 'text-input', placeholder: attribute.label });
      const btn = el('button', { class: 'btn btn-primary', text: 'Next' });
      btn.addEventListener('click', () => commit(input.value));
      inputWrap.appendChild(input);
      inputWrap.appendChild(btn);
    }

    if (playState.history.length) {
      card.appendChild(el('button', {
        class: 'btn btn-link', text: '← Back', onclick: () => {
          const last = playState.history.pop();
          playState.currentId = last.nodeId;
          delete playState.facts[last.factId];
          renderPlay();
        }
      }));
    }
  }

  function validateFactValue(attribute, value) {
    if (!attribute) return null;
    if (value === undefined || value === null || value === '') return attribute.label + ' is required.';
    if (attribute.type === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) return attribute.label + ' must be a number.';
      if (typeof attribute.min === 'number' && value < attribute.min) return attribute.label + ' must be ≥ ' + attribute.min + '.';
      if (typeof attribute.max === 'number' && value > attribute.max) return attribute.label + ' must be ≤ ' + attribute.max + '.';
    }
    if (attribute.type === 'enum' && Array.isArray(attribute.values) && !attribute.values.includes(value)) {
      return attribute.label + ' must be one of: ' + attribute.values.join(', ');
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // BUILD tab — attributes editor, node editor, validation
  // ---------------------------------------------------------------------
  function renderBuild() {
    renderAttributesEditor();
    renderNodesEditor();
    renderStartSelector();
    renderMetaEditor();
    renderValidation();
    renderJsonPreview();
  }

  function renderMetaEditor() {
    const root = $('#meta-editor');
    root.innerHTML = '';
    rules.meta = rules.meta || {};
    const title = el('input', { type: 'text', class: 'text-input', placeholder: 'Law / provision title', value: rules.meta.title || '' });
    title.addEventListener('input', () => { rules.meta.title = title.value; renderJsonPreview(); });
    const desc = el('input', { type: 'text', class: 'text-input wide', placeholder: 'One-line description', value: rules.meta.description || '' });
    desc.addEventListener('input', () => { rules.meta.description = desc.value; renderJsonPreview(); });
    root.appendChild(el('label', { text: 'Title' }));
    root.appendChild(title);
    root.appendChild(el('label', { text: 'Description' }));
    root.appendChild(desc);
  }

  function renderAttributesEditor() {
    const root = $('#attributes-editor');
    root.innerHTML = '';
    rules.attributes = rules.attributes || [];

    const table = el('table', { class: 'editor-table' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'id' }), el('th', { text: 'label' }), el('th', { text: 'type' }),
      el('th', { text: 'min' }), el('th', { text: 'max' }), el('th', { text: 'values (enum, comma-sep)' }),
      el('th', { text: 'legal source' }), el('th', { text: '' })
    ])]));
    const tbody = el('tbody');
    table.appendChild(tbody);

    rules.attributes.forEach((attr, i) => {
      const row = el('tr');
      row.appendChild(td(input(attr.id, (v) => {
        // Renaming an attribute's id here used to leave every node.fact
        // that already pointed at the old id dangling — e.g. wire Q1 to
        // "age", then rename the attribute to "ageCheck" for clarity, and
        // Q1 silently keeps citing "age", an id that no longer exists.
        // Carry the rename through to any node still referencing it.
        const oldId = attr.id;
        attr.id = v;
        if (oldId && oldId !== v) {
          Object.values(rules.nodes || {}).forEach((node) => {
            if (node.type === 'decision' && node.fact === oldId) node.fact = v;
          });
        }
        renderNodesEditor(); renderJsonPreview();
      })));
      row.appendChild(td(input(attr.label, (v) => { attr.label = v; renderJsonPreview(); })));
      row.appendChild(td(select(['number', 'boolean', 'enum', 'string'], attr.type, (v) => { attr.type = v; renderAttributesEditor(); renderJsonPreview(); })));
      row.appendChild(td(attr.type === 'number' ? input(attr.min ?? '', (v) => { attr.min = v === '' ? undefined : Number(v); renderJsonPreview(); }, 'number') : el('span', { text: '—' })));
      row.appendChild(td(attr.type === 'number' ? input(attr.max ?? '', (v) => { attr.max = v === '' ? undefined : Number(v); renderJsonPreview(); }, 'number') : el('span', { text: '—' })));
      row.appendChild(td(attr.type === 'enum' ? input((attr.values || []).join(', '), (v) => { attr.values = v.split(',').map((s) => s.trim()).filter(Boolean); renderNodesEditor(); renderJsonPreview(); }) : el('span', { text: '—' })));
      row.appendChild(td(input(attr.source || '', (v) => { attr.source = v; renderJsonPreview(); })));
      row.appendChild(td(el('button', { class: 'btn btn-danger-outline', text: '✕', onclick: () => { rules.attributes.splice(i, 1); renderBuild(); } })));
      tbody.appendChild(row);
    });

    root.appendChild(table);
    root.appendChild(el('button', {
      class: 'btn btn-secondary', text: '+ Add variable', onclick: () => {
        rules.attributes.push({ id: 'var' + (rules.attributes.length + 1), label: '', type: 'string' });
        renderBuild();
      }
    }));
  }

  function renderNodesEditor() {
    const root = $('#nodes-editor');
    root.innerHTML = '';
    rules.nodes = rules.nodes || {};
    const attrOptions = (rules.attributes || []).map((a) => a.id);
    const nodeIds = Object.keys(rules.nodes);
    // Decision nodes always list before outcome nodes, in each group's own
    // insertion order — otherwise a later decision node ends up buried below
    // earlier outcome nodes just because it was added after them. This only
    // affects display order; dropdown targets still offer every node.
    const displayIds = [...nodeIds].sort((a, b) => {
      const ta = rules.nodes[a].type, tb = rules.nodes[b].type;
      if (ta === tb) return 0;
      return ta === 'decision' ? -1 : 1;
    });

    const list = el('div', { class: 'node-list' });
    displayIds.forEach((id) => {
      const node = rules.nodes[id];
      list.appendChild(node.type === 'decision' ? decisionNodeCard(id, node, attrOptions, nodeIds) : outcomeNodeCard(id, node));
    });
    root.appendChild(list);

    const addRow = el('div', { class: 'add-node-row' });
    addRow.appendChild(el('button', {
      class: 'btn btn-secondary', text: '+ Add decision node', onclick: () => {
        const id = uniqueId('Q', rules.nodes);
        rules.nodes[id] = { type: 'decision', question: '', fact: attrOptions[0] || '', operator: 'equal', value: '', true: '', false: '' };
        renderNodesEditor(); renderJsonPreview();
      }
    }));
    addRow.appendChild(el('button', {
      class: 'btn btn-secondary', text: '+ Add outcome node', onclick: () => {
        const id = uniqueId('OUT_', rules.nodes);
        rules.nodes[id] = { type: 'outcome', label: '', description: '' };
        renderNodesEditor(); renderJsonPreview();
      }
    }));
    root.appendChild(addRow);

    // The Start-node selector was only refreshed on a full tab render, never
    // when a node was added or deleted here — so on a brand-new file, adding
    // your first node left the dropdown showing it (a bare <select> defaults
    // to highlighting an available option) while rules.start silently stayed
    // "" underneath, all the way through to export. Refresh it every time
    // the node list itself changes, not just on tab switch.
    renderStartSelector();
  }

  function uniqueId(prefix, nodes) {
    let n = 1;
    while (nodes[prefix + n]) n++;
    return prefix + n;
  }

  function decisionNodeCard(id, node, attrOptions, nodeIds) {
    const card = el('div', { class: 'node-card node-card-decision' });
    card.appendChild(el('div', { class: 'node-card-head' }, [
      el('span', { class: 'node-id-badge', text: id }),
      el('button', { class: 'btn btn-danger-outline btn-sm', text: 'Delete node', onclick: () => { delete rules.nodes[id]; renderNodesEditor(); renderJsonPreview(); } })
    ]));

    // Variable and Operator both affect what kind of Value control makes
    // sense (e.g. a boolean fact needs a True/False picker, not free text),
    // so changing either one re-renders the whole node list rather than
    // just updating in place.
    const refresh = () => { renderNodesEditor(); renderJsonPreview(); };

    // Same visual/data desync as the Start-node selector: a <select> shows
    // its first option as chosen whenever the bound value matches none of
    // them, with no 'change' event to catch it. That happens here whenever
    // node.fact points at an attribute id that no longer exists — most
    // commonly because the attribute was renamed after this node was wired
    // to it. The Variable dropdown would then quietly display the first
    // declared attribute as if it were selected while node.fact (and the
    // exported JSON) still held the old, dangling id. Snap them together.
    if (attrOptions.length && !attrOptions.includes(node.fact)) {
      node.fact = attrOptions[0];
      renderJsonPreview();
    }

    // Fixed 4-column grid, filled in this fixed order, so the layout is the
    // same for every node card instead of reflowing around content width:
    //   row 1: Question (full width)
    //   row 2: Variable | Operator | Value | Ask as Yes/No
    //   row 3: If TRUE, go to | If FALSE, go to (half width each)
    //   row 4: Supportive text (full width)
    //   row 5: Legal citation (full width)
    const grid = el('div', { class: 'node-grid' });
    grid.appendChild(field('Question', input(node.question || '', (v) => { node.question = v; renderJsonPreview(); }, null, 'wide')));
    grid.appendChild(field('Variable', select(attrOptions, node.fact, (v) => { node.fact = v; refresh(); })));
    grid.appendChild(field('Operator', select(RaC.OPERATORS, node.operator, (v) => { node.operator = v; refresh(); })));
    grid.appendChild(field('Value', valueControl(node)));
    const attr = (rules.attributes || []).find((a) => a.id === node.fact);
    const yesNoToggle = el('input', { type: 'checkbox' });
    yesNoToggle.checked = node.inputMode === 'yesno';
    yesNoToggle.disabled = !!(attr && attr.type === 'boolean');
    yesNoToggle.addEventListener('change', () => { if (yesNoToggle.checked) node.inputMode = 'yesno'; else delete node.inputMode; renderJsonPreview(); });
    grid.appendChild(field(
      attr && attr.type === 'boolean' ? 'Ask as Yes/No (automatic for boolean facts)' : 'Ask as Yes/No',
      yesNoToggle
    ));
    branchFields(id, node, nodeIds).forEach((f) => grid.appendChild(f));
    grid.appendChild(field('Supportive text', input(node.supportiveText || '', (v) => { node.supportiveText = v; renderJsonPreview(); }, null, 'wide')));
    grid.appendChild(field('Legal citation', input(node.citation || '', (v) => { node.citation = v; renderJsonPreview(); }, null, 'wide')));
    card.appendChild(grid);
    return card;
  }

  // A node's "go to" target is only meaningful once it points at a real
  // node. If it's empty (a freshly added node) or stale (its old target was
  // deleted), the <select> below still visually highlights whatever option
  // happens to be first — native <select> behavior when no option matches
  // the stored value — which looks fine but leaves the underlying rules.json
  // pointing nowhere, and validation correctly reports "outcome doesn't
  // exist". Snap it to a real target as soon as we render, so what's shown
  // always matches what's saved.
  function branchFields(id, node, nodeIds) {
    const targets = nodeIds.filter((n) => n !== id);
    if (!targets.includes(node.true)) {
      const next = targets[0] || '';
      if (node.true !== next) { node.true = next; renderJsonPreview(); }
    }
    if (!targets.includes(node.false)) {
      const next = targets[0] || '';
      if (node.false !== next) { node.false = next; renderJsonPreview(); }
    }

    function targetPreview(targetId) {
      const t = rules.nodes[targetId];
      if (!t) return 'not set — add a node first';
      const label = t.type === 'outcome' ? t.label : t.question;
      return targetId + (label ? ' — ' + label : '');
    }

    function branchField(labelText, key) {
      const wrap = el('label', { class: 'field branch-target' });
      wrap.appendChild(el('span', { text: labelText }));
      const s = select(targets, node[key], (v) => { node[key] = v; renderJsonPreview(); });
      wrap.appendChild(s);
      const hint = el('div', { class: 'branch-hint', text: '↳ ' + targetPreview(node[key]) });
      s.addEventListener('change', () => { hint.textContent = '↳ ' + targetPreview(node[key]); });
      wrap.appendChild(hint);
      return wrap;
    }

    return [branchField('If TRUE, go to', 'true'), branchField('If FALSE, go to', 'false')];
  }

  // Picks the right editor for a decision node's comparison value: a
  // True/False dropdown for boolean facts, a dropdown of the declared
  // values for enum facts, and a plain text box otherwise (including
  // in/notIn, which take a comma-separated list no dropdown fits).
  function valueControl(node) {
    const attr = (rules.attributes || []).find((a) => a.id === node.fact);
    const isListOp = node.operator === 'in' || node.operator === 'notIn';

    if (attr && attr.type === 'boolean' && !isListOp) {
      if (node.value !== true && node.value !== false) {
        node.value = true;
        renderJsonPreview();
      }
      return select(['true', 'false'], String(node.value), (v) => { node.value = v === 'true'; renderJsonPreview(); });
    }

    if (attr && attr.type === 'enum' && Array.isArray(attr.values) && attr.values.length && !isListOp) {
      if (!attr.values.includes(node.value)) {
        node.value = attr.values[0];
        renderJsonPreview();
      }
      return select(attr.values.map(String), String(node.value), (v) => { node.value = v; renderJsonPreview(); });
    }

    return input(Array.isArray(node.value) ? node.value.join(',') : (node.value ?? ''), (v) => {
      node.value = isListOp ? v.split(',').map((s) => coerce(s.trim())) : coerce(v);
      renderJsonPreview();
    });
  }

  function outcomeNodeCard(id, node) {
    const card = el('div', { class: 'node-card node-card-outcome' });
    card.appendChild(el('div', { class: 'node-card-head' }, [
      el('span', { class: 'node-id-badge outcome', text: id }),
      el('button', { class: 'btn btn-danger-outline btn-sm', text: 'Delete node', onclick: () => { delete rules.nodes[id]; renderNodesEditor(); renderJsonPreview(); } })
    ]));
    const grid = el('div', { class: 'node-grid' });
    grid.appendChild(field('Label', input(node.label || '', (v) => { node.label = v; renderJsonPreview(); }, null, 'wide')));
    grid.appendChild(field('Description', input(node.description || '', (v) => { node.description = v; renderJsonPreview(); }, null, 'wide')));
    card.appendChild(grid);
    return card;
  }

  function coerce(v) {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
    return v;
  }
  function field(labelText, control) {
    // A "wide" control (class set by input(...,'wide')) needs the *field*
    // itself — the actual grid item — to span the full grid width, not just
    // the control inside it, otherwise the grid never sees it as full-width.
    const isWide = control.classList && control.classList.contains('wide');
    return el('label', { class: 'field' + (isWide ? ' wide' : '') }, [el('span', { text: labelText }), control]);
  }
  function input(value, onChange, type, extraClass) {
    const i = el('input', { type: type || 'text', class: 'text-input' + (extraClass ? ' ' + extraClass : ''), value: value === undefined ? '' : value });
    i.addEventListener('input', () => onChange(i.value));
    return i;
  }
  function select(options, value, onChange) {
    const s = el('select', { class: 'text-input' });
    options.forEach((o) => {
      const opt = el('option', { value: o, text: o });
      if (o === value) opt.selected = true;
      s.appendChild(opt);
    });
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function td(child) { return el('td', {}, [child]); }

  function renderStartSelector() {
    const root = $('#start-editor');
    root.innerHTML = '';
    const nodeIds = Object.keys(rules.nodes || {});
    // A native <select> visually highlights the first option whenever the
    // bound value doesn't match any of them — it never fires a 'change'
    // event on its own, so rules.start (e.g. still '' on a brand-new file)
    // silently stays wrong even though the dropdown looks like it already
    // says "Q1". Snap the model to what's on screen, same as branchFields
    // does for true/false targets, so the two can't drift apart.
    if (!nodeIds.includes(rules.start)) {
      const next = nodeIds[0] || '';
      if (rules.start !== next) { rules.start = next; renderJsonPreview(); }
    }
    root.appendChild(el('label', { text: 'Start node: ' }));
    root.appendChild(select(nodeIds, rules.start, (v) => { rules.start = v; renderJsonPreview(); }));
  }

  function renderValidation() {
    const root = $('#validation-results');
    root.innerHTML = '';
    const { errors, warnings } = RaC.validateRules(rules);
    if (!errors.length && !warnings.length) {
      root.appendChild(el('div', { class: 'notice notice-ok', text: '✓ No structural problems found.' }));
      return;
    }
    if (errors.length) {
      root.appendChild(el('div', { class: 'notice notice-error' }, [
        el('strong', { text: errors.length + ' error(s) — must fix before running:' }),
        el('ul', {}, errors.map((e) => el('li', { text: e })))
      ]));
    }
    if (warnings.length) {
      root.appendChild(el('div', { class: 'notice notice-warn' }, [
        el('strong', { text: warnings.length + ' warning(s):' }),
        el('ul', {}, warnings.map((w) => el('li', { text: w })))
      ]));
    }
  }

  function renderJsonPreview() {
    $('#json-preview').textContent = JSON.stringify(rules, null, 2);
  }

  // ---------------------------------------------------------------------
  // TESTS tab — auto-generated coverage suite
  // ---------------------------------------------------------------------
  function renderTests() {
    const root = $('#tests-root');
    root.innerHTML = '';
    const { errors } = RaC.validateRules(rules);
    if (errors.length) {
      root.appendChild(el('div', { class: 'notice notice-error', text: 'Fix validation errors in the Build tab before generating tests.' }));
      return;
    }

    root.appendChild(el('div', { class: 'notice notice-info', text: 'Draft — review before treating as final test design.' }));

    const suite = RaC.generateTestSuite(rules);
    const table = el('table', { class: 'editor-table tests-table' });
    const attrCols = (rules.attributes || []).map((a) => a.id);
    table.appendChild(el('thead', {}, [el('tr', {}, ['test_id', 'description'].concat(attrCols).concat(['expected_outcome', 'expected_path', 'edge_class']).map((h) => el('th', { text: h })))]));
    const tbody = el('tbody');
    suite.forEach((row) => {
      const tr = el('tr', { class: 'edge-' + row.edge_class });
      tr.appendChild(el('td', { text: row.test_id }));
      tr.appendChild(el('td', { text: row.description }));
      attrCols.forEach((id) => tr.appendChild(el('td', { text: row.inputs[id] === undefined ? '' : String(row.inputs[id]) })));
      tr.appendChild(el('td', { text: row.expected_outcome }));
      tr.appendChild(el('td', { text: row.expected_path }));
      tr.appendChild(el('td', { text: row.edge_class }));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    root.appendChild(table);

    const dl = el('button', { class: 'btn btn-primary', text: 'Download CSV' });
    dl.addEventListener('click', () => {
      const csv = RaC.testSuiteToCSV(suite, rules.attributes || []);
      download((rules.meta && rules.meta.title ? slug(rules.meta.title) : 'rules') + '-test-suite.csv', csv);
    });
    root.appendChild(dl);
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initFileControls();
    renderPlay();
    renderBuild();
    renderTests();
    initEngineBadge();
  });

  function initEngineBadge() {
    const badge = $('#engine-status');
    if (!badge) return;
    badge.textContent = 'checking…';
    RaC.loadRealEngine().then(() => {
      badge.textContent = 'json-rules-engine';
    }).catch((e) => {
      badge.textContent = 'not loaded';
      badge.title = e.message;
      badge.style.color = 'var(--danger)';
      badge.style.borderColor = 'var(--danger)';
    });
  }
})();
