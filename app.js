/* app.js — UI wiring for the Rule-as-Code prototype. Depends on logic.js (window.RaC). */
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // The rules live in one place: rules.json at the project root, fetched on
  // startup. fetch() of a sibling file is blocked under file://, so when the
  // page is opened directly (not served) this falls back to rules.js — a
  // generated snapshot of the same data, loaded as a plain <script> tag,
  // which file:// does allow. Run `npm run build:rules` after editing
  // rules.json to regenerate that fallback; served contexts (GitHub Pages,
  // `python3 -m http.server`) always get the live rules.json itself.
  // ---------------------------------------------------------------------
  const RULES_URL = 'rules.json';

  const EMPTY_RULES = {
    meta: { title: 'Untitled rules', description: '' },
    attributes: [],
    start: '',
    nodes: {}
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function bundledFallback() {
    return (typeof window !== 'undefined' && window.RAC_RULES && typeof window.RAC_RULES === 'object')
      ? clone(window.RAC_RULES)
      : null;
  }

  async function loadRules() {
    let res;
    try {
      res = await fetch(RULES_URL, { cache: 'no-cache' });
    } catch (e) {
      const fallback = bundledFallback();
      if (fallback) return fallback;
      if (location.protocol === 'file:') {
        throw new Error('This page was opened as a file, so the browser blocks it from reading ' + RULES_URL +
          '. Serve the project folder instead: run "python3 -m http.server" in it and open http://localhost:8000/.');
      }
      throw new Error('Could not load ' + RULES_URL + ': ' + e.message);
    }
    if (!res.ok) {
      const fallback = bundledFallback();
      if (fallback) return fallback;
      throw new Error('Could not load ' + RULES_URL + ' (HTTP ' + res.status + ').');
    }
    try {
      return await res.json();
    } catch (e) {
      throw new Error(RULES_URL + ' is not valid JSON: ' + e.message);
    }
  }

  // ---------------------------------------------------------------------
  // Global state
  // ---------------------------------------------------------------------
  let rules = null; // set once rules.json has loaded
  let playState = null; // { currentId, facts, history: [{nodeId, factId, value, answer, question, supportiveText, citation}] }

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
  // Views: "Check a rule" (default — just the questionnaire) and "Author"
  // (adds the toolbar and the Build / Test suite tabs). The view lives in
  // the URL hash, so #author can be bookmarked or shared.
  // ---------------------------------------------------------------------
  function isAuthorView() { return document.body.classList.contains('view-author'); }

  function applyView() {
    const author = location.hash === '#author';
    document.body.classList.toggle('view-author', author);
    document.body.classList.toggle('view-check', !author);
    $all('.view-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === (author ? 'author' : 'check'))));
    if (!author) {
      // Only the questionnaire exists in the Check view.
      $all('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'play'));
      $all('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-play'));
    }
    if (rules) renderPlay(); // author-only parts of Play depend on the view
  }

  function initViewSwitch() {
    $all('.view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const hash = btn.dataset.view === 'author' ? '#author' : '';
        if (location.hash === hash) return;
        history.replaceState(null, '', hash || location.pathname + location.search);
        applyView();
      });
    });
    window.addEventListener('hashchange', applyView);
    applyView();
  }

  // ---------------------------------------------------------------------
  // Theme toggle (light / dark). A saved choice overrides the OS setting;
  // with no saved choice, the toggle just tracks prefers-color-scheme.
  // ---------------------------------------------------------------------
  function initThemeToggle() {
    const btn = $('#theme-toggle');
    if (!btn) return;
    const sunIcon = $('.icon-sun', btn);
    const moonIcon = $('.icon-moon', btn);
    const mql = window.matchMedia('(prefers-color-scheme: dark)');

    function getStored() {
      try { return localStorage.getItem('rac-theme'); } catch (e) { return null; }
    }
    function isDarkActive() {
      const stored = getStored();
      if (stored === 'dark') return true;
      if (stored === 'light') return false;
      return mql.matches;
    }
    function render() {
      const dark = isDarkActive();
      btn.setAttribute('aria-pressed', String(dark));
      const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
      btn.setAttribute('aria-label', label);
      btn.title = label;
      // Plain-property assignment (icon.hidden = …) sets the IDL property
      // but doesn't reliably reflect to the content attribute on inline
      // <svg> in every engine, so toggle the attribute explicitly.
      sunIcon.toggleAttribute('hidden', dark);
      moonIcon.toggleAttribute('hidden', !dark);
    }
    btn.addEventListener('click', () => {
      const next = isDarkActive() ? 'light' : 'dark';
      try { localStorage.setItem('rac-theme', next); } catch (e) { /* no persistence available */ }
      document.documentElement.setAttribute('data-theme', next);
      render();
    });
    // If the user hasn't overridden anything, keep following the OS live.
    mql.addEventListener('change', () => { if (!getStored()) render(); });
    render();
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
  // There's no upload: the site only ever runs rules.json. Edits made in the
  // Build tab are downloaded under that same name, ready to replace the file
  // in the repo.
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
      download(RULES_URL, JSON.stringify(rules, null, 2));
    });
    // Generated at click time, so it always reflects the current edits.
    $('#download-csv').addEventListener('click', () => {
      if (RaC.validateRules(rules).errors.length) {
        alert('Fix the validation errors in the Build tab before downloading the test suite.');
        return;
      }
      const csv = RaC.testSuiteToCSV(RaC.generateTestSuite(rules), rules.attributes || []);
      download((rules.meta && rules.meta.title ? slug(rules.meta.title) : 'rules') + '-test-suite.csv', csv);
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
      root.appendChild(isAuthorView()
        ? el('div', { class: 'notice notice-error' }, [
          el('strong', { text: 'This rules file has validation errors — fix them in the Build tab before playing:' }),
          el('ul', {}, errors.map((e) => el('li', { text: e })))
        ])
        : el('div', { class: 'notice notice-error', text: 'This rule can\'t be checked right now because its rules file has errors.' }));
      return;
    }

    if (!playState) playState = newPlayState(false);

    const node = rules.nodes[playState.currentId];
    const attributesById = {};
    (rules.attributes || []).forEach((a) => { attributesById[a.id] = a; });

    const card = el('div', { class: 'card' });
    root.appendChild(card);

    if (rules.meta && rules.meta.title) {
      root.insertBefore(el('h2', { class: 'law-title', text: rules.meta.title }), card);
    }

    if (!playState.started) {
      renderIntro(card);
      return;
    }

    if (node.type === 'outcome') {
      renderResult(card, node);
      return;
    }

    // "of up to": the longest possible run of questions from here, since
    // the actual count depends on the answers still to come.
    const asked = playState.history.length;
    card.appendChild(el('div', { class: 'progress-note', text: 'Question ' + (asked + 1) + ' of up to ' + (asked + remainingQuestions(playState.currentId)) }));
    card.appendChild(el('h3', { class: 'question', text: node.question || node.fact }));
    const supportive = userText(node.supportiveText);
    if (supportive) card.appendChild(el('p', { class: 'supportive', text: supportive }));
    const source = legalSourceLine(node.citation);
    if (source) card.appendChild(source);
    const terms = glossaryFor([node.question, supportive].join(' '));
    if (terms) card.appendChild(terms);

    const attribute = attributesById[node.fact];
    // After "Back" or "Change", the answer given before is highlighted so
    // unchanged questions can be re-confirmed quickly.
    const previous = playState.previousAnswers[playState.currentId];
    const inputWrap = el('div', { class: 'answer-controls' });
    card.appendChild(inputWrap);
    const errorLine = el('div', { class: 'field-error' });
    card.appendChild(errorLine);

    // `answer` is what the user saw and picked ("Yes", "No", "42") — kept
    // for the result summary, since a yes/no question may store a
    // synthesized threshold value as the fact.
    async function commit(value, answer) {
      // validate against the data dictionary before proceeding
      const err = validateFactValue(attribute, value);
      if (err) { errorLine.textContent = err; return; }
      inputWrap.querySelectorAll('button, input').forEach((n) => { n.disabled = true; });
      try {
        const branch = await RaC.evaluateCondition(node, Object.assign({}, playState.facts, { [node.fact]: value }));
        playState.facts[node.fact] = value;
        playState.history.push({ nodeId: playState.currentId, factId: node.fact, value, answer, question: node.question || node.fact, supportiveText: node.supportiveText, citation: node.citation });
        delete playState.previousAnswers[playState.currentId];
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
      inputWrap.appendChild(el('button', { class: 'btn btn-choice', text: 'Yes', onclick: () => commit(RaC.valueForBranch(node, true), 'Yes') }));
      inputWrap.appendChild(el('button', { class: 'btn btn-choice', text: 'No', onclick: () => commit(RaC.valueForBranch(node, false), 'No') }));
    } else if (attribute.type === 'boolean') {
      inputWrap.appendChild(el('button', { class: 'btn btn-choice', text: 'Yes', onclick: () => commit(true, 'Yes') }));
      inputWrap.appendChild(el('button', { class: 'btn btn-choice', text: 'No', onclick: () => commit(false, 'No') }));
    } else if (attribute.type === 'enum') {
      (attribute.values || []).forEach((v) => {
        inputWrap.appendChild(el('button', { class: 'btn btn-choice', text: String(v), onclick: () => commit(v, String(v)) }));
      });
    } else if (attribute.type === 'number') {
      const input = el('input', { type: 'number', class: 'text-input', placeholder: attribute.label });
      if (typeof attribute.min === 'number') input.min = attribute.min;
      if (typeof attribute.max === 'number') input.max = attribute.max;
      const btn = el('button', { class: 'btn btn-primary', text: 'Next' });
      btn.addEventListener('click', () => commit(input.value === '' ? undefined : Number(input.value), input.value));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
      inputWrap.appendChild(input);
      inputWrap.appendChild(btn);
      input.focus();
    } else {
      const input = el('input', { type: 'text', class: 'text-input', placeholder: attribute.label });
      const btn = el('button', { class: 'btn btn-primary', text: 'Next' });
      btn.addEventListener('click', () => commit(input.value, input.value));
      inputWrap.appendChild(input);
      inputWrap.appendChild(btn);
    }

    if (previous !== undefined) {
      inputWrap.querySelectorAll('.btn-choice').forEach((b) => {
        if (b.textContent === previous) {
          b.classList.add('is-previous');
          b.setAttribute('title', 'Your previous answer');
        }
      });
      const field = inputWrap.querySelector('input');
      if (field) field.value = previous;
      card.appendChild(el('div', { class: 'previous-note', text: 'Your previous answer is highlighted.' }));
    }

    if (playState.history.length) {
      card.appendChild(el('button', {
        class: 'btn btn-link', text: '← Back', onclick: () => goBackTo(playState.history.length - 1)
      }));
    }
  }

  function newPlayState(started) {
    return { started, currentId: rules.start, facts: {}, history: [], previousAnswers: {} };
  }

  // Return to the question at history[index], dropping it and every later
  // answer. The dropped answers are remembered as highlights, so if the
  // path stays the same the user only has to re-confirm them.
  function goBackTo(index) {
    const target = playState.history[index];
    playState.history.slice(index).forEach((h) => { playState.previousAnswers[h.nodeId] = h.answer; });
    playState.history = playState.history.slice(0, index);
    playState.facts = {};
    playState.history.forEach((h) => { playState.facts[h.factId] = h.value; });
    playState.currentId = target.nodeId;
    renderPlay();
  }

  // Shown before question 1: what the tool checks, who it's for, and that
  // it isn't legal advice. Texts come from rules.json meta (intro,
  // audience, disclaimer) so they can be edited with the rest of the rule.
  function renderIntro(card) {
    const meta = rules.meta || {};
    const intro = userText(meta.intro);
    const audience = userText(meta.audience);
    const disclaimer = userText(meta.disclaimer);
    if (intro) {
      card.appendChild(el('h4', { text: 'What this tool checks' }));
      card.appendChild(el('p', { class: 'intro-text', text: intro }));
    }
    if (audience) {
      card.appendChild(el('h4', { text: 'Who it is for' }));
      card.appendChild(el('p', { class: 'intro-text', text: audience }));
    }
    card.appendChild(el('p', { class: 'intro-text', text: 'You will answer up to ' + remainingQuestions(rules.start) + ' questions. Each one shows the part of the law it is based on.' }));
    const source = legalSourceLine(null);
    if (source) card.appendChild(source);
    if (disclaimer) card.appendChild(el('div', { class: 'notice notice-info intro-disclaimer', text: disclaimer }));
    card.appendChild(el('div', { class: 'result-actions' }, [
      el('button', { class: 'btn btn-primary', text: 'Start', onclick: () => { playState.started = true; renderPlay(); } })
    ]));
  }

  // Glossary terms (rules.json "glossary": [{ term, definition }]) that
  // appear in the given text, as a collapsible list. Terms whose definition
  // is still empty or a TODO placeholder are left out.
  function glossaryFor(text) {
    const lower = String(text || '').toLowerCase();
    const found = (rules.glossary || []).filter((g) => {
      if (!g.term || !userText(g.definition)) return false;
      const re = new RegExp('\\b' + g.term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return re.test(lower);
    });
    if (!found.length) return null;
    const list = el('dl', { class: 'glossary-list' });
    found.forEach((g) => {
      list.appendChild(el('dt', { text: g.term }));
      list.appendChild(el('dd', { text: userText(g.definition) }));
    });
    return el('details', { class: 'glossary' }, [
      el('summary', { text: found.length === 1 ? 'What does "' + found[0].term + '" mean?' : 'Terms used in this question' }),
      list
    ]);
  }

  // The result card doubles as the printable record: the print stylesheet
  // hides the site chrome and buttons and shows the .print-only header.
  function renderResult(card, node) {
    const meta = rules.meta || {};
    card.appendChild(el('div', { class: 'print-only print-head' }, [
      el('div', { class: 'print-title', text: meta.title || 'Result' }),
      el('div', { class: 'print-sub', text: [meta.legalSource, 'Printed ' + new Date().toLocaleDateString()].filter(Boolean).join(' · ') })
    ]));

    card.appendChild(el('div', { class: 'outcome-badge', text: node.label || playState.currentId }));
    const description = userText(node.description);
    if (description) card.appendChild(el('p', { text: description }));

    card.appendChild(el('h4', { text: 'Your answers' }));
    const answers = el('ol', { class: 'answers-list' });
    playState.history.forEach((h, i) => {
      const li = el('li', {}, [
        el('span', { class: 'answers-q', text: h.question }),
        el('strong', { class: 'answers-a', text: h.answer }),
        el('button', { class: 'btn btn-link answers-change no-print', text: 'Change', 'aria-label': 'Change answer to question ' + (i + 1), onclick: () => goBackTo(i) })
      ]);
      const source = legalSourceLine(h.citation);
      if (source) li.appendChild(source);
      answers.appendChild(li);
    });
    card.appendChild(answers);

    const trail = playState.history.filter((h) => userText(h.supportiveText));
    if (trail.length) {
      card.appendChild(el('h4', { text: 'Relevant rules applied' }));
      const ul = el('ul', { class: 'supportive-list' });
      trail.forEach((h) => ul.appendChild(el('li', {}, [
        el('strong', { text: (h.citation ? h.citation + ': ' : '') }),
        document.createTextNode(userText(h.supportiveText))
      ])));
      card.appendChild(ul);
    }

    const outcomePath = playState.history.map((h) => h.nodeId).concat([playState.currentId]);
    card.appendChild(el('div', { class: 'author-only' }, [
      el('h4', { text: 'Decision path' }),
      el('div', { class: 'path-trace', text: outcomePath.join('  →  ') })
    ]));

    const disclaimer = userText(meta.disclaimer);
    if (disclaimer) card.appendChild(el('p', { class: 'result-disclaimer', text: disclaimer }));

    card.appendChild(el('div', { class: 'result-actions no-print' }, [
      el('button', { class: 'btn btn-primary', text: 'Start over', onclick: () => { playState = newPlayState(true); renderPlay(); } }),
      el('button', { class: 'btn', text: 'Print / save as PDF', onclick: () => window.print() })
    ]));
  }

  // Longest run of decision nodes from `id` to any outcome (rules are
  // validated acyclic before play starts).
  function remainingQuestions(id) {
    const memo = {};
    (function walk(nid) {
      if (nid in memo) return memo[nid];
      const n = rules.nodes[nid];
      memo[nid] = !n || n.type !== 'decision' ? 0 : 1 + Math.max(walk(n.true), walk(n.false));
      return memo[nid];
    })(id);
    return memo[id];
  }

  // Authors leave "TODO (stödtext)" placeholders in texts still to be
  // written. Strip them so users only see real text — "TODO (stödtext). If
  // yes: …" keeps the "If yes: …" part.
  function userText(s) {
    if (!s) return '';
    return String(s).replace(/\bTODO\b(\s*\([^)]*\))?[.:]?\s*/g, '').trim();
  }

  // Citations like "25 kap. 13 § ABL" link to that paragraph of the law text
  // on riksdagen.se, whose SFS pages anchor each paragraph as #K<kap>P<§>
  // (and each chapter as #K<kap>). Ranges and lists ("13-14 §§", "17, 20 §§")
  // link to their first paragraph. Without meta.lawUrl, the citation is
  // shown as plain text.
  function citationUrl(citation) {
    const base = rules.meta && rules.meta.lawUrl;
    if (!base) return null;
    const m = /(\d+)\s*kap\.?(?:\s*(\d+))?/i.exec(citation || '');
    if (!m) return base;
    return base.split('#')[0] + '#K' + m[1] + (m[2] ? 'P' + m[2] : '');
  }

  // Falls back to the rule's overall legal source when a node has no
  // citation of its own, so every question shows one.
  function legalSourceLine(citation) {
    const text = citation || (rules.meta && rules.meta.legalSource);
    if (!text) return null;
    const url = citationUrl(text);
    return el('div', { class: 'legal-source' }, [
      el('span', { text: 'Legal source: ' }),
      url ? el('a', { href: url, target: '_blank', rel: 'noopener', text: text }) : el('span', { text: text })
    ]);
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
    const title = el('input', { type: 'text', class: 'text-input wide', placeholder: 'Law / provision title', value: rules.meta.title || '' });
    title.addEventListener('input', () => { rules.meta.title = title.value; renderJsonPreview(); });
    const desc = el('input', { type: 'text', class: 'text-input wide', placeholder: 'One-line description', value: rules.meta.description || '' });
    desc.addEventListener('input', () => { rules.meta.description = desc.value; renderJsonPreview(); });
    root.appendChild(el('label', { text: 'Title' }));
    root.appendChild(title);
    root.appendChild(el('label', { text: 'Description' }));
    root.appendChild(desc);
    root.appendChild(el('label', { text: 'Legal source' }));
    root.appendChild(input(rules.meta.legalSource || '', (v) => { rules.meta.legalSource = v; renderJsonPreview(); }, null, 'wide'));
    // Base URL of the law text; citations deep-link into it (see citationUrl).
    [['intro', 'Intro: what this tool checks'], ['audience', 'Intro: who it is for'], ['disclaimer', 'Disclaimer (intro and result)']].forEach(([key, label]) => {
      root.appendChild(el('label', { text: label }));
      root.appendChild(input(rules.meta[key] || '', (v) => { rules.meta[key] = v; renderJsonPreview(); }, null, 'wide'));
    });
    root.appendChild(el('label', { text: 'Law text URL (riksdagen.se)' }));
    root.appendChild(input(rules.meta.lawUrl || '', (v) => { rules.meta.lawUrl = v; renderJsonPreview(); }, 'url', 'wide'));
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
    const card = el('div', { class: 'node-card node-card-decision', 'data-node-id': id });
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
    const card = el('div', { class: 'node-card node-card-outcome', 'data-node-id': id });
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
    scheduleFlowchart();
  }

  // ---------------------------------------------------------------------
  // Flowchart of the whole tree (Build tab). Mermaid does the layout — the
  // tree has long edges that skip levels (e.g. G8 → G12), which a naive
  // layered layout would draw straight through other boxes. It's loaded
  // from the CDN only when the Build tab is first shown, so the Check view
  // never pays for it.
  // ---------------------------------------------------------------------
  const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  let mermaidPromise = null;
  let flowchartTimer = null;
  let flowchartRenderCount = 0;
  // Default zoomed-in further than 1:1 so the node text is readable right
  // away on a tree this size; Reset returns to this, not to a neutral 1x.
  const FLOWCHART_DEFAULT_SCALE = 1.6;
  const FLOWCHART_MIN_SCALE = 0.3;
  const FLOWCHART_MAX_SCALE = 6;
  let flowchartView = { scale: FLOWCHART_DEFAULT_SCALE, x: 0, y: 0 };

  function clampFlowchartScale(s) { return Math.min(FLOWCHART_MAX_SCALE, Math.max(FLOWCHART_MIN_SCALE, s)); }

  function applyFlowchartTransform() {
    const viewport = $('#flowchart .flowchart-viewport');
    if (!viewport) return;
    viewport.style.transform = 'translate(' + flowchartView.x + 'px, ' + flowchartView.y + 'px) scale(' + flowchartView.scale + ')';
  }

  function zoomFlowchart(factor) {
    flowchartView.scale = clampFlowchartScale(flowchartView.scale * factor);
    applyFlowchartTransform();
  }

  function resetFlowchartView() {
    flowchartView = { scale: FLOWCHART_DEFAULT_SCALE, x: 0, y: 0 };
    applyFlowchartTransform();
  }

  // One-time wiring for drag-to-pan, wheel-to-zoom, and the zoom buttons —
  // #flowchart itself is a fixed container (only its contents get replaced
  // on each renderFlowchart() call), so these listeners are attached once.
  function initFlowchartPanZoom() {
    const container = $('#flowchart');
    if (!container) return;

    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, startViewX = 0, startViewY = 0;

    container.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !$('.flowchart-viewport', container)) return;
      dragging = true;
      moved = false;
      startX = e.clientX; startY = e.clientY;
      startViewX = flowchartView.x; startViewY = flowchartView.y;
      container.classList.add('is-panning');
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      flowchartView.x = startViewX + dx;
      flowchartView.y = startViewY + dy;
      applyFlowchartTransform();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      container.classList.remove('is-panning');
      if (moved) {
        // Swallow the click that follows a drag, in the capturing phase, so
        // it never reaches a node's own click-to-jump listener.
        const swallow = (e) => { e.stopPropagation(); e.preventDefault(); container.removeEventListener('click', swallow, true); };
        container.addEventListener('click', swallow, true);
      }
    });
    container.addEventListener('wheel', (e) => {
      if (!$('.flowchart-viewport', container)) return;
      e.preventDefault();
      zoomFlowchart(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });
  }

  function loadMermaid() {
    if (!mermaidPromise) {
      mermaidPromise = import(MERMAID_URL).then((m) => m.default).catch((e) => { mermaidPromise = null; throw e; });
    }
    return mermaidPromise;
  }

  // Edits arrive per keystroke; redraw once typing pauses, and only while
  // the Build tab is visible (switching to it re-renders anyway).
  function scheduleFlowchart() {
    clearTimeout(flowchartTimer);
    if (!$('#tab-build').classList.contains('active')) return;
    flowchartTimer = setTimeout(renderFlowchart, 300);
  }

  function mermaidLabel(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    const short = t.length > 70 ? t.slice(0, 67) + '…' : t;
    return short.replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');
  }

  function flowchartSource(keyOf) {
    const lines = ['flowchart TD'];
    Object.entries(rules.nodes || {}).forEach(([id, node]) => {
      const k = keyOf[id];
      if (node.type === 'decision') {
        lines.push('  ' + k + '["' + mermaidLabel(id + ': ' + (node.question || node.fact || '')) + '"]:::decision');
      } else {
        lines.push('  ' + k + '(["' + mermaidLabel(id + ': ' + (node.label || '')) + '"]):::outcome');
      }
    });
    Object.entries(rules.nodes || {}).forEach(([id, node]) => {
      if (node.type !== 'decision') return;
      ['true', 'false'].forEach((branch) => {
        if (keyOf[node[branch]]) lines.push('  ' + keyOf[id] + ' -->|' + branch + '| ' + keyOf[node[branch]]);
      });
    });
    if (keyOf[rules.start]) lines.push('  class ' + keyOf[rules.start] + ' start');
    return lines.join('\n');
  }

  async function renderFlowchart() {
    const root = $('#flowchart');
    const ids = Object.keys(rules.nodes || {});
    if (!ids.length) { root.innerHTML = ''; root.appendChild(el('p', { class: 'supportive', text: 'No nodes yet.' })); return; }

    // Node ids are free-form strings; give Mermaid safe keys and map back.
    const keyOf = {}, idOf = {};
    ids.forEach((id, i) => { keyOf[id] = 'n' + i; idOf['n' + i] = id; });

    let mermaid;
    try {
      mermaid = await loadMermaid();
    } catch (e) {
      root.innerHTML = '';
      root.appendChild(el('div', { class: 'notice notice-warn', text: 'The flowchart needs the Mermaid library from cdn.jsdelivr.net, which could not be loaded. Check the internet connection.' }));
      return;
    }

    // Colors come from the page's own tokens so light and dark mode match.
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: {
        fontFamily: v('--font-body'), fontSize: '13px',
        primaryColor: v('--surface'), primaryBorderColor: v('--border'), primaryTextColor: v('--text'),
        lineColor: v('--muted'), edgeLabelBackground: v('--bg'), textColor: v('--text'),
      },
      flowchart: { curve: 'basis', nodeSpacing: 30, rankSpacing: 40 },
    });

    const source = flowchartSource(keyOf) + '\n' +
      '  classDef decision fill:' + v('--surface') + ',stroke:' + v('--accent') + ',stroke-width:1.5px,color:' + v('--text') + '\n' +
      '  classDef outcome fill:' + v('--accent-soft') + ',stroke:' + v('--accent-soft-border') + ',color:' + v('--text') + '\n' +
      '  classDef start stroke-width:3px';

    let svg;
    try {
      ({ svg } = await mermaid.render('flowchart-svg-' + (++flowchartRenderCount), source));
    } catch (e) {
      root.innerHTML = '';
      root.appendChild(el('div', { class: 'notice notice-warn', text: 'Could not draw the flowchart: ' + e.message }));
      return;
    }

    root.innerHTML = '';
    const viewport = el('div', { class: 'flowchart-viewport' });
    viewport.innerHTML = svg;
    root.appendChild(viewport);
    const controls = el('div', { class: 'flowchart-zoom-controls' }, [
      el('button', { type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in', text: '+', onclick: () => zoomFlowchart(1.25) }),
      el('button', { type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out', text: '\u2212', onclick: () => zoomFlowchart(1 / 1.25) }),
      el('button', { type: 'button', 'aria-label': 'Reset zoom and position', title: 'Reset view', text: '\u2922', onclick: () => resetFlowchartView() }),
    ]);
    root.appendChild(controls);
    applyFlowchartTransform();

    // Mermaid gives each node group an id like "…-flowchart-n3-0".
    $all('g.node', root).forEach((g) => {
      const m = /flowchart-(n\d+)-/.exec(g.id);
      const nodeId = m && idOf[m[1]];
      if (!nodeId) return;
      g.classList.add('fc-node-link');
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'link');
      g.setAttribute('aria-label', 'Edit node ' + nodeId);
      g.addEventListener('click', () => jumpToNodeCard(nodeId));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpToNodeCard(nodeId); } });
    });
  }

  function jumpToNodeCard(nodeId) {
    const card = $all('.node-card').find((c) => c.dataset.nodeId === nodeId);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('flash');
    void card.offsetWidth; // restart the animation on repeated clicks
    card.classList.add('flash');
    const first = card.querySelector('input, select');
    if (first) first.focus({ preventScroll: true });
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
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    initViewSwitch();
    initThemeToggle();
    initFlowchartPanZoom();
    initEngineBadge();
    try {
      rules = await loadRules();
    } catch (e) {
      $('#play-root').appendChild(el('div', { class: 'notice notice-error', text: e.message }));
      $('.tabs').hidden = true;
      $('#download-json').disabled = true;
      $('#download-csv').disabled = true;
      return;
    }
    initTabs();
    initFileControls();
    renderPlay();
    renderBuild();
    renderTests();
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
