/*
 * app.js — the UI of the Rule-as-Code prototype. Depends on logic.js
 * (window.RaC) and, for Upload BPMN, bpmn.js (window.RaCBpmn).
 *
 * Sections, in order:
 *  - loading rules.json, global state, DOM helpers
 *  - views (Check / Author), theme toggle, tabs, toolbar file controls
 *    (New, Upload JSON, Upload BPMN, Download JSON / CSV)
 *  - Play tab: the questionnaire, intro and printable result
 *  - Build tab: editors for meta, variables and nodes, validation, JSON preview
 *  - Build tab flowchart (Mermaid) with pan and zoom
 *  - Test suite tab (the CSV as a table)
 *  - Test results tab (each case run through the engine, as readable cards;
 *    the Play result links to its own case here)
 *  - startup
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Loading rules.json
  // ---------------------------------------------------------------------
  // The rules live in one place: rules.json at the project root, fetched on
  // startup. fetch() of a sibling file is blocked under file://, so the
  // folder must be served (GitHub Pages, `python3 -m http.server`).
  const RULES_URL = 'rules.json';

  // Starting point for the toolbar's "New" button. No title, so a BPMN
  // uploaded next names the rule set after its process.
  const EMPTY_RULES = {
    meta: { title: '', description: '' },
    attributes: [],
    start: '',
    nodes: {}
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  async function loadRules() {
    let res;
    try {
      res = await fetch(RULES_URL, { cache: 'no-cache' });
    } catch (e) {
      if (location.protocol === 'file:') {
        throw new Error('This page was opened as a file, so the browser blocks it from reading ' + RULES_URL +
          '. Serve the project folder instead: run "python3 -m http.server" in it and open http://localhost:8000/.');
      }
      throw new Error('Could not load ' + RULES_URL + ': ' + e.message);
    }
    if (!res.ok) {
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
  let rules = null; // set once rules.json has loaded; Build tab edits change it in place
  let playState = null; // questionnaire progress, see newPlayState()

  // ---------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------
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
  function download(filename, text, type) {
    const blob = new Blob([text], { type: (type || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------------------------------------------------------------------
  // Views: "Check a rule" (default — just the questionnaire) and "Author"
  // (adds the toolbar and the Build / Test suite / Test results tabs). The view lives in
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
    if (rules) renderPlay(); // Play's error notice depends on the view
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
      btn.addEventListener('click', () => showTab(btn.dataset.tab));
    });
  }

  // Switches to a tab and renders it. `options` is passed on to the Test
  // results tab (e.g. which case to highlight).
  function showTab(tab, options) {
    $all('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $all('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
    if (tab === 'play') renderPlay();
    if (tab === 'build') renderBuild();
    if (tab === 'tests') renderTests();
    if (tab === 'results') renderResults(options);
  }

  // ---------------------------------------------------------------------
  // File load / save (shared across tabs)
  // ---------------------------------------------------------------------
  // New / Upload JSON / Upload BPMN replace the rules in this browser tab
  // only; the site itself always starts from rules.json. Download JSON saves
  // under that same name and layout, ready to replace the file in the repo.
  function initFileControls() {
    $('#new-rules').addEventListener('click', () => {
      if (!confirm('Start a new, empty rules file? Unsaved changes will be lost.')) return;
      rules = clone(EMPTY_RULES);
      afterRulesChanged();
    });
    onFileChosen('#upload-json', (file, text) => {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        alert('Could not parse "' + file.name + '" as JSON:\n' + err.message);
        return;
      }
      // Valid JSON but not a rules object (e.g. a list or a number) would
      // leave the app half-loaded, so keep the current rules instead.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        alert('"' + file.name + '" is not a rules file: it must contain one JSON object with "meta", "attributes", "start" and "nodes".');
        return;
      }
      rules = parsed;
      afterRulesChanged();
      alert('Loaded "' + file.name + '". Check the Build tab for validation results.');
    });
    // The BPMN is converted with js/bpmn.js, the same code as npm run
    // import:bpmn. Texts the BPMN doesn't hold (supportive texts, short
    // labels, intro, variables) are taken from the rules loaded now.
    onFileChosen('#upload-bpmn', (file, text) => {
      const { rules: imported, errors, report } = RaCBpmn.bpmnToRules(text, rules);
      if (errors.length) {
        alert('Could not convert "' + file.name + '" — nothing was changed:\n\n' + errors.map((e) => '• ' + e).join('\n'));
        return;
      }
      imported.meta.bpmnFile = 'rules.bpmn'; // the repo keeps the BPMN under this name
      rules = imported;
      afterRulesChanged();
      alert('Imported "' + file.name + '": ' + RaCBpmn.importReport(rules, report, RaC.validateRules(rules)) +
        '\n\nTo make it permanent: Download JSON and replace rules.json in the repo, save the BPMN as rules.bpmn' +
        (file.name === 'rules.bpmn' ? '' : ' (it is "' + file.name + '" now)') + ', then run "npm run build:docs" and "npm test".');
    });
    $('#download-json').addEventListener('click', () => {
      download(RULES_URL, RaC.formatRules(rules), 'application/json');
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

  // Reads the file picked in a hidden <input type="file"> as text.
  function onFileChosen(selector, handle) {
    $(selector).addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => handle(file, reader.result);
      reader.onerror = () => alert('Could not read "' + file.name + '": ' + (reader.error ? reader.error.message : 'unknown error'));
      reader.readAsText(file);
      e.target.value = ''; // so choosing the same file again still triggers
    });
  }

  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'rules'; }

  // The page header and tab title come from rules.json, so another rules
  // file gets its own name: meta.shortTitle (or meta.title) and
  // meta.subtitle (or meta.legalSource).
  function applyHeader() {
    const meta = (rules && rules.meta) || {};
    const title = meta.shortTitle || meta.title || 'Rules as Code';
    $('header h1').textContent = title;
    $('.header-eyebrow').textContent = ['Prototype', meta.subtitle || meta.legalSource].filter(Boolean).join(' · ');
    document.title = title + ' – Prototype';
  }

  function afterRulesChanged() {
    applyHeader();
    playState = null;
    renderPlay();
    renderBuild();
    renderTests();
    // Running every test takes a moment, so only when the tab is open.
    if ($('#tab-results').classList.contains('active')) renderResults();
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
    const terms = glossaryFor([node.question, supportive].join(' '), 'question');
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
      // Check the answer against the data dictionary (shared with the runner).
      if ((value === undefined || value === '') && attribute.default !== undefined) value = attribute.default;
      const err = RaC.validateValue(attribute, value);
      if (err) { errorLine.textContent = err; return; }
      inputWrap.querySelectorAll('button, input').forEach((n) => { n.disabled = true; });
      try {
        const branch = await RaC.evaluateCondition(node, Object.assign({}, playState.facts, { [node.fact]: value }));
        playState.facts[node.fact] = value;
        playState.history.push({ nodeId: playState.currentId, factId: node.fact, value, answer, question: node.question || node.fact, supportiveText: node.supportiveText, citation: node.citation,
          warning: node.warnings && node.warnings[String(branch)] });
        delete playState.previousAnswers[playState.currentId];
        playState.currentId = branch ? node.true : node.false;
        renderPlay();
      } catch (e) {
        errorLine.textContent = e.message;
        inputWrap.querySelectorAll('button, input').forEach((n) => { n.disabled = false; });
      }
    }

    // One input per variable type. validateRules() above guarantees that
    // node.fact is a declared attribute.
    if (node.inputMode === 'yesno') {
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

  // ---------------------------------------------------------------------
  // Play helpers: state, navigation, intro, result, legal sources
  // ---------------------------------------------------------------------

  // history: one entry per answered question, in order.
  // previousAnswers: answers dropped by Back/Change, shown as highlights.
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

  // Glossary terms (rules.json "glossary": [{ term, swedish, definition,
  // source }]) that appear in the given text, as a collapsible list with the
  // Swedish term and the legal source. Terms whose definition is still empty
  // or a TODO placeholder are left out. `where` names the place in the
  // summary line: "question" or "result".
  function glossaryFor(text, where) {
    const found = (rules.glossary || []).filter((g) =>
      g && g.term && userText(g.definition) && RaC.glossaryTermRegExp(g.term).test(String(text || '')));
    if (!found.length) return null;
    const list = el('dl', { class: 'glossary-list' });
    found.forEach((g) => {
      list.appendChild(el('dt', {}, [g.term].concat(g.swedish ? [el('span', { class: 'glossary-sv', text: ' (' + g.swedish + ')' })] : [])));
      list.appendChild(el('dd', {}, [userText(g.definition)].concat(g.source ? [el('span', { class: 'glossary-source', text: 'Source: ' + g.source })] : [])));
    });
    return el('details', { class: 'glossary' }, [
      el('summary', { text: found.length === 1 ? 'What does "' + found[0].term + '" mean?' : 'Terms used in this ' + (where || 'question') }),
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
    // Terms in the outcome itself (e.g. "compulsory liquidation"). Not
    // printed: a collapsed list would only print its summary line.
    const outcomeTerms = glossaryFor([node.label, description].join(' '), 'result');
    if (outcomeTerms) { outcomeTerms.classList.add('no-print'); card.appendChild(outcomeTerms); }

    // Defects noted on the way (rules.json "warnings" on the branch taken):
    // the tree went on, but a step was missed or done wrongly.
    const defects = playState.history.filter((h) => userText(h.warning));
    if (defects.length) {
      card.appendChild(el('div', { class: 'notice notice-warn result-warnings' }, [
        el('strong', { text: defects.length === 1 ? 'Defect noted on the way' : 'Defects noted on the way' }),
        el('ul', {}, defects.map((h) => el('li', {}, [
          el('span', { text: h.question + ' ' }),
          el('strong', { text: h.answer + '. ' }),
          document.createTextNode(userText(h.warning))
        ])))
      ]));
    }

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
    // The node IDs match the decision tree, rules.json and the test suite.
    card.appendChild(el('div', {}, [
      el('h4', { text: 'Decision path (node IDs)' }),
      el('div', { class: 'path-trace', text: outcomePath.join('  →  ') })
    ]));
    // Every path through the tree is one case in the test suite; this opens
    // the Test results tab at the case with the same path.
    card.appendChild(el('button', {
      class: 'btn btn-secondary result-test-link no-print',
      text: 'See this result in the test suite →',
      onclick: () => openResultsAtPath(outcomePath, Object.assign({}, playState.facts))
    }));

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

  // Citations link to that paragraph of the law text on riksdagen.se, whose
  // SFS pages anchor each paragraph as #K<kap>P<§> (e.g. #K25P13, #K1P12b)
  // and each chapter as #K<kap>. Both Swedish ("25 kap. 13 § ABL") and
  // English ("Ch. 25 Sec. 13 Companies Act") citations work; ranges and lists
  // link to their first paragraph. Without meta.lawUrl, the citation is
  // shown as plain text.
  function citationUrl(citation) {
    const base = rules.meta && rules.meta.lawUrl;
    if (!base) return null;
    const text = citation || '';
    const m = /(\d+)\s*kap\.?(?:\s*(\d+)(?:\s*([a-z])\b)?)?/i.exec(text) ||
      /\b(?:Ch\.?|Chapter)\s*(\d+)(?:,?\s*(?:Sec\.?|Section|§)\s*(\d+)(?:\s*([a-z])\b)?)?/i.exec(text);
    if (!m) return base;
    return base.split('#')[0] + '#K' + m[1] + (m[2] ? 'P' + m[2] + (m[3] || '').toLowerCase() : '');
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

  // ---------------------------------------------------------------------
  // BUILD tab — attributes editor, node editor, validation
  // ---------------------------------------------------------------------
  function renderBuild() {
    renderBpmnNote();
    renderAttributesEditor();
    renderGlossaryEditor();
    renderNodesEditor(); // also renders the start-node selector
    renderMetaEditor();
    renderJsonPreview(); // also renders the validation
  }

  // Top of the Build tab: for rules imported from a BPMN, which parts come
  // from the BPMN and which are only edited here.
  function renderBpmnNote() {
    const root = $('#bpmn-note');
    root.innerHTML = '';
    const file = rules.meta && rules.meta.bpmnFile;
    if (!file) return;
    root.appendChild(el('div', { class: 'notice notice-info' }, [
      el('strong', { text: 'Imported from ' + file + '. ' }),
      'Fields marked “from BPMN” (questions with operator and value, citations, Yes/No targets, outcome descriptions and the start node) come from the BPMN: change them there, or the next import overwrites them. ' +
      'Everything else — supportive texts, outcome labels, variables, the glossary and the intro texts — is only edited here. Download JSON saves it.'
    ]));
  }

  function renderMetaEditor() {
    const root = $('#meta-editor');
    root.innerHTML = '';
    rules.meta = rules.meta || {};
    // [key, label, input type]. The title fields also update the page header.
    // lawUrl is the law text's base URL; citations deep-link into it (see citationUrl).
    [
      ['title', 'Title'],
      ['shortTitle', 'Short title (page header)'],
      ['subtitle', 'Subtitle (line above the header)'],
      ['description', 'Description'],
      ['legalSource', 'Legal source'],
      ['intro', 'Intro: what this tool checks'],
      ['audience', 'Intro: who it is for'],
      ['disclaimer', 'Disclaimer (intro and result)'],
      ['lawUrl', 'Law text URL (riksdagen.se)', 'url'],
    ].forEach(([key, label, type]) => {
      root.appendChild(el('label', { text: label }));
      root.appendChild(input(rules.meta[key] || '', (v) => { rules.meta[key] = v; applyHeader(); renderJsonPreview(); }, type, 'wide'));
    });
  }

  function renderAttributesEditor() {
    const root = $('#attributes-editor');
    root.innerHTML = '';
    rules.attributes = rules.attributes || [];

    const table = el('table', { class: 'editor-table' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { text: 'id' }), el('th', { text: 'label' }), el('th', { text: 'type' }),
      el('th', { text: 'min' }), el('th', { text: 'max' }), el('th', { text: 'unit' }), el('th', { text: 'values (enum, comma-sep)' }),
      el('th', { text: 'default' }), el('th', { text: 'example' }), el('th', { text: 'legal source' }), el('th', { text: '' })
    ])]));
    const tbody = el('tbody');
    table.appendChild(tbody);

    rules.attributes.forEach((attr, i) => {
      const row = el('tr');
      row.appendChild(td(input(attr.id, (v) => {
        // Renaming a variable also renames it in every node that uses it.
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
      row.appendChild(td(select(RaC.ATTRIBUTE_TYPES, attr.type, (v) => { attr.type = v; renderAttributesEditor(); renderJsonPreview(); })));
      row.appendChild(td(attr.type === 'number' ? input(attr.min ?? '', (v) => { attr.min = v === '' ? undefined : Number(v); renderJsonPreview(); }, 'number') : el('span', { text: '—' })));
      row.appendChild(td(attr.type === 'number' ? input(attr.max ?? '', (v) => { attr.max = v === '' ? undefined : Number(v); renderJsonPreview(); }, 'number') : el('span', { text: '—' })));
      row.appendChild(td(attr.type === 'number' ? input(attr.unit || '', (v) => { setOptional(attr, 'unit', v); renderJsonPreview(); }) : el('span', { text: '—' })));
      row.appendChild(td(attr.type === 'enum' ? input((attr.values || []).join(', '), (v) => { attr.values = v.split(',').map((s) => s.trim()).filter(Boolean); renderNodesEditor(); renderJsonPreview(); }) : el('span', { text: '—' })));
      // Default (null policy) and example are typed like the variable itself.
      row.appendChild(td(input(attr.default ?? '', (v) => { setOptional(attr, 'default', RaC.textToValue(attr, v)); renderJsonPreview(); })));
      row.appendChild(td(input(attr.example ?? '', (v) => { setOptional(attr, 'example', RaC.textToValue(attr, v)); renderJsonPreview(); })));
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

  // The glossary (rules.glossary): one row per term with its Swedish term,
  // definition and legal source, written by the Law team.
  function renderGlossaryEditor() {
    const root = $('#glossary-editor');
    root.innerHTML = '';
    const entries = rules.glossary || [];
    if (entries.length) {
      const table = el('table', { class: 'editor-table glossary-editor' });
      table.appendChild(el('thead', {}, [el('tr', {}, ['term', 'swedish', 'definition', 'legal source', ''].map((h) => el('th', { text: h })))]));
      const tbody = el('tbody');
      entries.forEach((g, i) => {
        tbody.appendChild(el('tr', {}, [
          td(textArea(g.term || '', (v) => { g.term = v; renderJsonPreview(); }, 2)),
          td(textArea(g.swedish || '', (v) => { g.swedish = v; renderJsonPreview(); }, 2)),
          td(textArea(g.definition || '', (v) => { g.definition = v; renderJsonPreview(); })),
          td(textArea(g.source || '', (v) => { g.source = v; renderJsonPreview(); })),
          td(el('button', { class: 'btn btn-danger-outline', text: '✕', 'aria-label': 'Delete term ' + (g.term || (i + 1)),
            onclick: () => { entries.splice(i, 1); renderGlossaryEditor(); renderJsonPreview(); } })),
        ]));
      });
      table.appendChild(tbody);
      root.appendChild(table);
    }
    root.appendChild(el('button', {
      class: 'btn btn-secondary', text: '+ Add term', onclick: () => {
        rules.glossary = entries.concat([{ term: '', swedish: '', definition: '', source: '' }]);
        renderGlossaryEditor(); renderJsonPreview();
        const rows = $all('#glossary-editor tbody tr');
        rows[rows.length - 1].querySelector('textarea').focus();
      }
    }));
  }

  // Sets an optional field, or removes it when the value is empty.
  function setOptional(obj, key, value) {
    if (value === undefined || value === '') delete obj[key]; else obj[key] = value;
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

    // The node list changed, so the start-node options may have too.
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

    // Fixed 4-column grid, filled in this fixed order, so the layout is the
    // same for every node card instead of reflowing around content width:
    //   row 1: Question (full width)
    //   row 2: Variable | Operator | Value | Ask as Yes/No
    //   row 3: If TRUE, go to | If FALSE, go to (half width each)
    //   row 4: Defect warning if TRUE | if FALSE (half width each)
    //   row 5: Supportive text (full width)
    //   row 6: Legal citation (full width)
    const grid = el('div', { class: 'node-grid' });
    grid.appendChild(field('Question', input(node.question || '', (v) => { node.question = v; renderJsonPreview(); }, null, 'wide'), true));
    grid.appendChild(field('Variable', select(attrOptions, node.fact, (v) => { node.fact = v; refresh(); }, missingText(node.fact))));
    grid.appendChild(field('Operator', select(RaC.OPERATORS, node.operator, (v) => { node.operator = v; refresh(); }), true));
    grid.appendChild(field('Value', valueControl(node), true));
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
    warningFields(node).forEach((f) => grid.appendChild(f));
    grid.appendChild(field('Supportive text', input(node.supportiveText || '', (v) => { node.supportiveText = v; renderJsonPreview(); }, null, 'wide')));
    grid.appendChild(field('Legal citation', input(node.citation || '', (v) => { node.citation = v; renderJsonPreview(); }, null, 'wide'), true));
    card.appendChild(grid);
    return card;
  }

  // The "If TRUE / If FALSE, go to" dropdowns. An empty or deleted target
  // stays as it is and shows as "choose" / "missing", so validation reports it.
  function branchFields(id, node, nodeIds) {
    const targets = nodeIds.filter((n) => n !== id);

    function targetPreview(targetId) {
      const t = rules.nodes[targetId];
      if (!t) return targetId ? 'node "' + targetId + '" no longer exists — choose another' : 'not set — choose a node';
      const label = t.type === 'outcome' ? t.label : t.question;
      return targetId + (label ? ' — ' + label : '');
    }

    function branchField(labelText, key) {
      const wrap = el('label', { class: 'field branch-target' });
      wrap.appendChild(labelWithBadge(labelText, true));
      const s = select(targets, node[key], (v) => { node[key] = v; renderJsonPreview(); }, missingText(node[key]));
      wrap.appendChild(s);
      const hint = el('div', { class: 'branch-hint', text: '↳ ' + targetPreview(node[key]) });
      s.addEventListener('change', () => { hint.textContent = '↳ ' + targetPreview(node[key]); });
      wrap.appendChild(hint);
      return wrap;
    }

    return [branchField('If TRUE, go to', 'true'), branchField('If FALSE, go to', 'false')];
  }

  // "Defect warning if TRUE / FALSE": shown on the result when that branch
  // was taken. Empty fields are removed, so the JSON only has real warnings.
  function warningFields(node) {
    return ['true', 'false'].map((key) => {
      const wrap = el('label', { class: 'field branch-target' });
      wrap.appendChild(labelWithBadge('Defect warning if ' + key.toUpperCase() + ' (shown on the result)', true));
      wrap.appendChild(input((node.warnings && node.warnings[key]) || '', (v) => {
        node.warnings = Object.assign({}, node.warnings, { [key]: v });
        if (!v.trim()) delete node.warnings[key];
        if (!Object.keys(node.warnings).length) delete node.warnings;
        renderJsonPreview();
      }));
      return wrap;
    });
  }

  // Picks the right editor for a decision node's comparison value: a
  // True/False dropdown for boolean facts, a dropdown of the declared
  // values for enum facts, and a plain text box otherwise (including
  // in/notIn, which take a comma-separated list no dropdown fits).
  function valueControl(node) {
    const attr = (rules.attributes || []).find((a) => a.id === node.fact);
    const isListOp = node.operator === 'in' || node.operator === 'notIn';

    // A value that doesn't fit the variable is left as it is and shown as
    // invalid, so the data dictionary check reports it.
    if (attr && attr.type === 'boolean' && !isListOp) {
      const ok = node.value === true || node.value === false;
      return select(['true', 'false'], ok ? String(node.value) : null, (v) => { node.value = v === 'true'; renderJsonPreview(); },
        ok ? null : 'invalid: ' + JSON.stringify(node.value));
    }

    if (attr && attr.type === 'enum' && Array.isArray(attr.values) && attr.values.length && !isListOp) {
      const ok = attr.values.includes(node.value);
      return select(attr.values.map(String), ok ? String(node.value) : null, (v) => { node.value = v; renderJsonPreview(); },
        ok ? null : 'invalid: ' + JSON.stringify(node.value));
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
    grid.appendChild(field('Description', input(node.description || '', (v) => { node.description = v; renderJsonPreview(); }, null, 'wide'), true));
    card.appendChild(grid);
    return card;
  }

  // Small form-control helpers for the Build tab editors.
  // coerce: text box input -> boolean / number / string.
  function coerce(v) {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
    return v;
  }
  // `fromBpmn` marks a field the BPMN import fills (see bpmnBadge).
  function field(labelText, control, fromBpmn) {
    // A "wide" control (class set by input(...,'wide')) needs the *field*
    // itself — the actual grid item — to span the full grid width, not just
    // the control inside it, otherwise the grid never sees it as full-width.
    const isWide = control.classList && control.classList.contains('wide');
    return el('label', { class: 'field' + (isWide ? ' wide' : '') }, [labelWithBadge(labelText, fromBpmn), control]);
  }

  // When the rules were imported from a BPMN (meta.bpmnFile), the fields the
  // import fills get a "from BPMN" mark: edits to them belong in the BPMN,
  // because the next import overwrites them.
  function bpmnBadge() {
    const file = rules.meta && rules.meta.bpmnFile;
    if (!file) return null;
    return el('span', { class: 'bpmn-badge', title: 'Comes from ' + file + '. Change it there, or the next BPMN import overwrites it.', text: 'from BPMN' });
  }
  function labelWithBadge(text, fromBpmn) {
    const badge = fromBpmn ? bpmnBadge() : null;
    return el('span', {}, [text].concat(badge ? [badge] : []));
  }
  function textArea(value, onChange, rows) {
    const t = el('textarea', { class: 'text-input', rows: String(rows || 3) });
    t.value = value;
    t.addEventListener('input', () => onChange(t.value));
    return t;
  }
  function input(value, onChange, type, extraClass) {
    const i = el('input', { type: type || 'text', class: 'text-input' + (extraClass ? ' ' + extraClass : ''), value: value === undefined ? '' : value });
    i.addEventListener('input', () => onChange(i.value));
    return i;
  }
  // A dropdown bound to `value`. If the value isn't one of the options, a
  // disabled first entry shows `missingText` (e.g. "missing: Q9"), so the
  // dropdown never pretends a different option is chosen.
  function select(options, value, onChange, missingText) {
    const s = el('select', { class: 'text-input' });
    if (!options.includes(value) && missingText) {
      const opt = el('option', { value: '', text: missingText });
      opt.disabled = true;
      opt.selected = true;
      s.appendChild(opt);
    }
    options.forEach((o) => {
      const opt = el('option', { value: o, text: o });
      if (o === value) opt.selected = true;
      s.appendChild(opt);
    });
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function td(child) { return el('td', {}, [child]); }
  function missingText(value) { return value ? '⚠ missing: ' + value : '— choose —'; }

  function renderStartSelector() {
    const root = $('#start-editor');
    root.innerHTML = '';
    const nodeIds = Object.keys(rules.nodes || {});
    // A new file has no start yet, so its first node becomes the start. A
    // start that points to a deleted node is kept and shown as missing.
    if (!rules.start && nodeIds.length) { rules.start = nodeIds[0]; renderJsonPreview(); }
    root.appendChild(el('label', {}, ['Start node: '].concat(bpmnBadge() ? [bpmnBadge()] : [])));
    root.appendChild(select(nodeIds, rules.start, (v) => { rules.start = v; renderJsonPreview(); }, missingText(rules.start)));
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

  // Called after every edit: refresh the raw JSON, the validation and the flowchart.
  function renderJsonPreview() {
    $('#json-preview').textContent = JSON.stringify(rules, null, 2);
    renderValidation();
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

  // Mermaid source for the tree: one box per node, one labelled arrow per branch.
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
      // Saves the diagram as an SVG file, e.g. for the report's appendix.
      el('button', { type: 'button', 'aria-label': 'Download flowchart as SVG', title: 'Download SVG', text: '\u2193', onclick: () => {
        const svgEl = $('svg', viewport);
        if (svgEl) download(slug((rules.meta && rules.meta.title) || 'rules') + '-decision-tree.svg', new XMLSerializer().serializeToString(svgEl), 'image/svg+xml');
      } }),
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

    root.appendChild(el('div', { class: 'notice notice-info' }, [
      'Draft — review before treating as final test design. This is the same table as Download CSV. For one readable card per case with its result, open ',
      el('button', { class: 'btn-link inline-link', text: 'Test results', onclick: () => showTab('results') }),
      '.'
    ]));

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
    // The table scrolls inside its own box (header and test ID stay put),
    // so the page itself never scrolls sideways.
    root.appendChild(el('div', { class: 'table-scroll' }, [table]));
  }

  // ---------------------------------------------------------------------
  // TEST RESULTS tab — every generated test case run through the engine,
  // shown as one readable card per case: the questions on its path with
  // their answers, the outcome, and whether the engine agreed.
  // ---------------------------------------------------------------------
  const TYPE_LABELS = { normal: 'Path', boundary: 'Boundary', negative: 'Invalid input' };
  const resultsFilter = { query: '', outcome: '', type: '', status: '' };
  let resultsRun = 0; // id of the newest run; a slower older run is dropped
  let resultsReturnView = null; // 'check' / 'author' when opened from a Play result

  // Opened from the Play result: show the Author view's Test results tab at
  // the case with the same path and answers, remembering where to go back to.
  function openResultsAtPath(path, facts) {
    resultsReturnView = isAuthorView() ? 'author' : 'check';
    if (!isAuthorView()) {
      history.replaceState(null, '', '#author');
      applyView();
    }
    showTab('results', { path, facts });
  }

  function backToResult() {
    const view = resultsReturnView;
    resultsReturnView = null;
    if (view === 'check') {
      history.replaceState(null, '', location.pathname + location.search);
      applyView(); // the Check view always shows Play, with the result kept
    } else {
      showTab('play');
    }
    window.scrollTo(0, 0);
  }

  async function renderResults(options) {
    options = options || {};
    const root = $('#results-root');
    const run = ++resultsRun;
    root.innerHTML = '';
    if (RaC.validateRules(rules).errors.length) {
      root.appendChild(el('div', { class: 'notice notice-error', text: 'Fix validation errors in the Build tab before running the tests.' }));
      return;
    }
    root.appendChild(el('p', { class: 'supportive', text: 'Running every test case through the rules engine…' }));

    let results;
    try {
      results = [];
      for (const row of RaC.generateTestSuite(rules)) {
        results.push(await RaC.runTestRow(rules, row));
        if (run !== resultsRun) return;
      }
    } catch (e) {
      if (run !== resultsRun) return;
      root.innerHTML = '';
      root.appendChild(el('div', { class: 'notice notice-error', text: 'Could not run the tests: ' + e.message }));
      return;
    }
    if (run !== resultsRun) return;
    root.innerHTML = '';

    // The case that matches the user's own answers. Several cases can share
    // a path (a question whose Yes and No both lead on, with a defect noted
    // on one), so the answers must match too; the plain "Path" case is
    // preferred over a boundary case on the same route.
    let yours = null;
    if (options.path) {
      const key = options.path.join('>');
      const facts = options.facts || {};
      const sameAnswers = (r) => Object.keys(facts).every((f) => r.inputs[f] === facts[f]);
      const same = results.filter((r) => r.expected.path.join('>') === key);
      yours = same.find((r) => r.edge_class === 'normal' && sameAnswers(r)) || same.find(sameAnswers) || null;
      Object.assign(resultsFilter, { query: '', outcome: '', type: '', status: '' });
    }
    if (options.path) root.appendChild(yoursBanner(yours));

    const failed = results.filter((r) => !r.pass).length;
    root.appendChild(el('div', { class: 'results-summary' }, [
      el('span', { class: 'results-total', text: results.length + ' test cases' }),
      el('span', { class: 'status-pill pass', text: (results.length - failed) + ' passed' }),
      el('span', { class: 'status-pill ' + (failed ? 'fail' : 'neutral'), text: failed + ' failed' })
    ]));
    root.appendChild(el('p', { class: 'supportive results-help', text:
      'Each case is one set of answers run through the rules engine. A Path case answers the questions along one route through the tree; an Invalid input case gives one answer the data dictionary must reject. Open a case to see its questions, answers and result.' }));

    const list = el('div', { class: 'results-list' });
    const count = el('span', { class: 'results-count' });
    root.appendChild(resultsFilterBar(results, () => renderResultsList(list, count, results, yours)));
    root.appendChild(list);
    renderResultsList(list, count, results, yours);

    if (yours) {
      const item = list.querySelector('[data-test-id="' + yours.test_id + '"]');
      if (item) {
        item.open = true;
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        item.classList.remove('flash');
        void item.offsetWidth; // restart the animation
        item.classList.add('flash');
      }
    }
  }

  function yoursBanner(yours) {
    const back = el('button', { class: 'btn btn-sm', text: '← Back to your result', onclick: backToResult });
    if (!yours) {
      return el('div', { class: 'notice notice-warn results-yours' }, [
        el('span', { text: 'No test case has the same path and answers as yours. The test suite may be out of date with the rules. ' }), back
      ]);
    }
    return el('div', { class: 'notice ' + (yours.pass ? 'notice-ok' : 'notice-error') + ' results-yours' }, [
      el('span', {}, [
        'Your answers are test case ',
        el('strong', { text: yours.test_id }),
        yours.pass ? ', which passes: the engine gives the expected result.' : ', which fails: ' + yours.reason + '.'
      ]),
      back
    ]);
  }

  function resultsFilterBar(results, onChange) {
    const outcomes = [];
    results.forEach((r) => { if (!outcomes.includes(r.expected.outcome)) outcomes.push(r.expected.outcome); });
    const select = (key, label, options) => {
      const s = el('select', { class: 'text-input', 'aria-label': label });
      options.forEach(([value, text]) => {
        const o = el('option', { value, text });
        if (value === resultsFilter[key]) o.selected = true;
        s.appendChild(o);
      });
      s.addEventListener('change', () => { resultsFilter[key] = s.value; onChange(); });
      return s;
    };
    const search = el('input', { type: 'search', class: 'text-input', placeholder: 'Search: test ID, outcome or question text', 'aria-label': 'Search test cases' });
    search.value = resultsFilter.query;
    search.addEventListener('input', () => { resultsFilter.query = search.value; onChange(); });
    const byOutcome = (o) => results.filter((r) => r.expected.outcome === o).length;
    return el('div', { class: 'results-filters' }, [
      search,
      select('outcome', 'Filter by outcome', [['', 'All outcomes']].concat(outcomes.map((o) => [o, (o === 'ERROR' ? 'Error (invalid input)' : o) + ' (' + byOutcome(o) + ')']))),
      select('type', 'Filter by type', [['', 'All types'], ['normal', 'Path'], ['boundary', 'Boundary'], ['negative', 'Invalid input']]
        .filter(([v]) => !v || results.some((r) => r.edge_class === v))),
      select('status', 'Filter by result', [['', 'Passed and failed'], ['pass', 'Passed only'], ['fail', 'Failed only']])
    ]);
  }

  // Text a case can be found by: ID, outcome, description and the questions on its path.
  function resultSearchText(r) {
    const questions = r.expected.path.map((id) => (rules.nodes[id] && rules.nodes[id].question) || '');
    return [r.test_id, r.expected.outcome, r.description, r.expected.path.join(' ')].concat(questions).join(' ').toLowerCase();
  }

  function renderResultsList(list, count, results, yours) {
    const q = resultsFilter.query.trim().toLowerCase();
    const shown = results.filter((r) =>
      (!resultsFilter.outcome || r.expected.outcome === resultsFilter.outcome) &&
      (!resultsFilter.type || r.edge_class === resultsFilter.type) &&
      (!resultsFilter.status || (resultsFilter.status === 'pass') === r.pass) &&
      (!q || resultSearchText(r).includes(q)));
    list.innerHTML = '';
    count.textContent = 'Showing ' + shown.length + ' of ' + results.length;
    list.appendChild(count);
    if (!shown.length) {
      list.appendChild(el('p', { class: 'supportive', text: 'No test cases match these filters.' }));
      return;
    }
    // Grouped by expected outcome, in the order the suite lists them.
    const groups = [];
    shown.forEach((r) => {
      let g = groups.find((x) => x.outcome === r.expected.outcome);
      if (!g) groups.push(g = { outcome: r.expected.outcome, cases: [] });
      g.cases.push(r);
    });
    groups.forEach((g) => {
      const failed = g.cases.filter((r) => !r.pass).length;
      list.appendChild(el('h3', { class: 'results-group' }, [
        el('span', { text: g.outcome === 'ERROR' ? 'Error: invalid input rejected' : g.outcome }),
        el('span', { class: 'results-group-count', text: g.cases.length + (g.cases.length === 1 ? ' case' : ' cases') + (failed ? ' · ' + failed + ' failed' : ' · all passed') })
      ]));
      g.cases.forEach((r) => list.appendChild(testCaseItem(r, r === yours)));
    });
  }

  function answerText(attribute, value) {
    if (value === undefined || value === null || value === '') return 'No answer';
    if (attribute && attribute.type === 'boolean' && typeof value === 'boolean') return value ? 'Yes' : 'No';
    return String(value);
  }

  // The questions on a case's path, in order, with the case's answer to
  // each. Defects come from the engine's own run of the case: the branch
  // taken can't be read off the path, since Yes and No may lead to the
  // same next question.
  function caseSteps(r) {
    const warnings = {};
    (r.actual.warnings || []).forEach((w) => { warnings[w.nodeId] = userText(w.warning); });
    return r.expected.path.slice(0, -1).map((id) => {
      const node = rules.nodes[id] || {};
      const attribute = (rules.attributes || []).find((a) => a.id === node.fact);
      return {
        id,
        question: node.question || (attribute && attribute.label) || node.fact || id,
        answer: answerText(attribute, r.inputs[node.fact]),
        warning: warnings[id] || ''
      };
    });
  }

  // "[invalid] <label> wrong type" (from generateTestSuite) → "Wrong type: <label>".
  function invalidTitle(description) {
    const d = String(description || '').replace(/^\[invalid\]\s*/, '');
    const m = /^(.*)\s(missing|wrong type|out of range|invalid enum value)$/.exec(d);
    if (!m) return d;
    const kind = m[2] === 'missing' ? 'No answer' : m[2].charAt(0).toUpperCase() + m[2].slice(1);
    return kind + ': ' + m[1];
  }

  // One collapsible card. The body is built the first time it opens, so
  // the list of several hundred cases stays quick.
  function testCaseItem(r, isYours) {
    const negative = r.edge_class === 'negative';
    const steps = negative ? [] : caseSteps(r);
    const defects = steps.filter((s) => s.warning).length;
    const title = negative ? invalidTitle(r.description) : steps.length + (steps.length === 1 ? ' question' : ' questions') + ' → ' + r.expected.outcome;
    // The answers on the path tell cases with the same route apart.
    const route = steps.map((s) => s.id + ' ' + s.answer).concat([r.expected.path[r.expected.path.length - 1]]).join('  ›  ');
    const summary = el('summary', {}, [
      el('span', { class: 'tc-id', text: r.test_id }),
      el('span', { class: 'status-pill ' + (r.pass ? 'pass' : 'fail'), text: r.pass ? 'Passed' : 'Failed' }),
      el('span', { class: 'tc-type', text: TYPE_LABELS[r.edge_class] || r.edge_class }),
      isYours ? el('span', { class: 'tc-yours', text: 'Your answers' }) : null,
      defects ? el('span', { class: 'tc-defect', text: defects === 1 ? '1 defect noted' : defects + ' defects noted' }) : null,
      el('span', { class: 'tc-title', text: title }),
      negative ? null : el('span', { class: 'tc-path', text: route })
    ].filter(Boolean));
    const item = el('details', { class: 'test-case' + (isYours ? ' is-yours' : ''), 'data-test-id': r.test_id }, [summary]);
    let built = false;
    item.addEventListener('toggle', () => {
      if (item.open && !built) { built = true; item.appendChild(testCaseBody(r)); }
    });
    return item;
  }

  function testCaseBody(r) {
    const attributesById = {};
    (rules.attributes || []).forEach((a) => { attributesById[a.id] = a; });
    const body = el('div', { class: 'tc-body' });

    if (r.edge_class === 'negative') {
      // The one variable this case breaks: missing, or a value the data
      // dictionary doesn't allow.
      const bad = (rules.attributes || []).find((a) => r.description.indexOf(a.label) !== -1 && !(a.id in r.inputs)) ||
        (rules.attributes || []).find((a) => a.id in r.inputs && RaC.validateValue(a, r.inputs[a.id]));
      const errors = r.actual.errors || [];
      const facts = el('dl', { class: 'tc-inputs tc-facts' });
      const add = (term, value) => { facts.appendChild(el('dt', { text: term })); facts.appendChild(el('dd', {}, [value])); };
      if (bad) {
        add('Invalid answer to', bad.label);
        add('Value given', bad.id in r.inputs ? JSON.stringify(r.inputs[bad.id]) + ' (' + (bad.type === 'boolean' ? 'must be yes or no' : 'not allowed') + ')' : 'none (left empty)');
      }
      add('Expected', 'Error: the input is rejected before the rules run');
      add('Engine said', errors.length ? errors.map((e) => e.error).join(' ') : r.actual.outcome);
      body.appendChild(facts);
      body.appendChild(el('div', { class: 'tc-check ' + (r.pass ? 'pass' : 'fail') }, [r.pass
        ? 'Passed: the engine rejected the input, as expected.'
        : 'Failed: ' + r.reason + '.']));
      body.appendChild(inputsDisclosure(r, attributesById));
      return body;
    }

    // The questions in the order they are asked, with this case's answers.
    const steps = el('ol', { class: 'tc-steps' });
    caseSteps(r).forEach((s) => {
      steps.appendChild(el('li', {}, [
        el('span', { class: 'tc-step-id', text: s.id }),
        el('span', { class: 'tc-step-q', text: s.question }),
        el('span', { class: 'tc-answer', text: s.answer }),
        s.warning ? el('span', { class: 'tc-warning', text: /^defect/i.test(s.warning) ? s.warning : 'Defect noted: ' + s.warning }) : null
      ].filter(Boolean)));
    });
    body.appendChild(steps);

    const path = r.expected.path;
    const outcomeId = path[path.length - 1];
    const outcome = rules.nodes[outcomeId] || {};
    body.appendChild(el('div', { class: 'tc-outcome' }, [
      el('span', { class: 'tc-outcome-label', text: 'Result' }),
      el('strong', { text: outcome.label || outcomeId }),
      userText(outcome.description) ? el('p', { text: userText(outcome.description) }) : null
    ].filter(Boolean)));
    body.appendChild(el('div', { class: 'tc-check ' + (r.pass ? 'pass' : 'fail') }, [r.pass
      ? 'Passed: the engine reached this result by this path, as expected.'
      : 'Failed: ' + r.reason + '.']));
    body.appendChild(inputsDisclosure(r, attributesById));
    return body;
  }

  // Every input of the case, as in the CSV row. Variables the path never
  // asks about still have a value there, but it doesn't change the result.
  function inputsDisclosure(r, attributesById) {
    const asked = new Set(r.expected.path.map((id) => rules.nodes[id] && rules.nodes[id].fact).filter(Boolean));
    const dl = el('dl', { class: 'tc-inputs' });
    (rules.attributes || []).forEach((a) => {
      dl.appendChild(el('dt', { text: a.id }));
      dl.appendChild(el('dd', {}, [
        el('span', { text: answerText(a, r.inputs[a.id]) }),
        r.edge_class !== 'negative' && !asked.has(a.id) ? el('span', { class: 'tc-unused', text: ' (not asked on this path)' }) : null
      ].filter(Boolean)));
    });
    return el('details', { class: 'tc-inputs-wrap' }, [el('summary', { text: 'All inputs in this test case (as in the CSV)' }), dl]);
  }

  // ---------------------------------------------------------------------
  // Startup: wire up the page, load rules.json, then render all three tabs.
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
    applyHeader();
    initTabs();
    initFileControls();
    renderPlay();
    renderBuild();
    renderTests();
  });

  // Toolbar badge showing whether json-rules-engine loaded.
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
