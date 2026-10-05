// ==UserScript==
// @name         Orbit Turn Type Quick Fill
// @namespace    https://amazon.com
// @version      1.6
// @description  Floating panel: N/A Fill / HE Cannot Judge / Conclude Chat auto-fill for Orbit annotation forms
// @match        https://orbit-gamma.beta.harmony.a2z.com/*
// @match        https://orbit-beta.harmony.a2z.com/*
// @match        https://abc-mlops.beta.harmony.a2z.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const PANEL_ID  = 'otf-panel';
  const TOAST_ID  = 'otf-toast';
  let   _running  = false;  // re-entry guard: prevents parallel mode executions

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function norm(t) {
    return t.replace(/\s*\*\s*$/, '').trim()
      .toLowerCase().replace(/[-_—–]/g, ' ').replace(/\s+/g, ' '); // —=em-dash –=en-dash
  }

  // ── Radio helpers ─────────────────────────────────────────────────────────
  function radioLabelText(radio) {
    const lbl = radio.id
      ? document.querySelector(`label[for="${radio.id}"]`)
      : radio.closest('label');
    return (lbl ? lbl.textContent : radio.value || '').trim();
  }

  function clickRadio(groupLabel, optionText) {
    const gNorm = norm(groupLabel);
    const oNorm = norm(optionText);

    // Pass 1 – AWSUI aria-labelledby radiogroup
    for (const group of document.querySelectorAll('[role="radiogroup"][aria-labelledby]')) {
      const lbl = document.getElementById(group.getAttribute('aria-labelledby'));
      if (!lbl || norm(lbl.textContent) !== gNorm) continue;
      for (const radio of group.querySelectorAll('input[type="radio"]')) {
        if (norm(radioLabelText(radio)) === oNorm) { radio.click(); return true; }
      }
    }

    // Pass 2 – generic DOM walk
    for (const radio of document.querySelectorAll('input[type="radio"]')) {
      if (norm(radioLabelText(radio)) !== oNorm) continue;
      let el = radio.parentElement;
      for (let i = 0; i < 14; i++) {
        if (!el || el === document.body) break;
        for (const child of el.children) {
          const ownText = norm(Array.from(child.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => n.textContent).join(' ') || child.textContent);
          if (ownText === gNorm) { radio.click(); return true; }
        }
        const leg = el.querySelector(':scope > legend');
        if (leg && norm(leg.textContent) === gNorm) { radio.click(); return true; }
        el = el.parentElement;
      }
    }

    return false;
  }

  // ── Select/dropdown helpers ───────────────────────────────────────────────
  function findSelectTrigger(fieldLabel) {
    const fNorm = norm(fieldLabel);

    // Strategy 1: exact aria-labelledby match
    for (const el of document.querySelectorAll('[aria-labelledby]')) {
      const tag  = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (tag !== 'button' && tag !== 'select' && role !== 'combobox') continue;
      for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/)) {
        const lbl = document.getElementById(id);
        if (lbl && norm(lbl.textContent) === fNorm) return el;
      }
    }

    // Strategy 1b: partial/contains aria-labelledby match (handles icon text in label)
    for (const el of document.querySelectorAll('[aria-labelledby]')) {
      const tag  = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (tag !== 'button' && tag !== 'select' && role !== 'combobox') continue;
      for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/)) {
        const lbl = document.getElementById(id);
        if (lbl && norm(lbl.textContent).includes(fNorm)) return el;
      }
    }

    // Strategy 2: smallest label text match → walk up for trigger
    let best = null, bestLen = Infinity;
    for (const el of document.querySelectorAll('label, span, div, p, legend, h1, h2, h3, h4')) {
      const t = norm(el.textContent);
      if ((t === fNorm || t.includes(fNorm)) && el.textContent.length < bestLen) {
        bestLen = el.textContent.length; best = el;
      }
    }
    if (best) {
      let container = best.parentElement;
      for (let i = 0; i < 10; i++) {
        if (!container || container === document.body) break;
        const trigger = container.querySelector(
          'button[aria-haspopup], button[aria-expanded], [role="combobox"], select'
        );
        if (trigger && !trigger.closest('#' + PANEL_ID)) return trigger;
        container = container.parentElement;
      }
    }

    // Strategy 3: all triggers — check ancestor labels (up to 10 levels)
    for (const btn of document.querySelectorAll(
      'button[aria-haspopup], button[aria-expanded], [role="combobox"]'
    )) {
      if (btn.closest('#' + PANEL_ID)) continue;
      let anc = btn.parentElement;
      for (let i = 0; i < 10; i++) {
        if (!anc || anc === document.body) break;
        for (const lbl of anc.querySelectorAll('label, [class*="label"], span, div, p')) {
          const lt = norm(lbl.textContent);
          if (lt === fNorm || lt.includes(fNorm)) return btn;
        }
        anc = anc.parentElement;
      }
    }

    // Strategy 4: aria-label attribute directly on the button
    for (const btn of document.querySelectorAll(
      'button[aria-label], [role="combobox"][aria-label]'
    )) {
      if (btn.closest('#' + PANEL_ID)) continue;
      const al = norm(btn.getAttribute('aria-label') || '');
      if (al === fNorm || al.includes(fNorm)) return btn;
    }

    // Strategy 5: placeholder text on the button contains all label keywords.
    // Guard: requires at least one keyword to avoid vacuous-truth match on empty array.
    const labelWords = fNorm.split(' ').filter(w => w.length > 3);
    if (labelWords.length > 0) {
      for (const btn of document.querySelectorAll(
        'button[aria-haspopup], button[aria-expanded], [role="combobox"]'
      )) {
        if (btn.closest('#' + PANEL_ID)) continue;
        const btnText = norm(btn.textContent);
        if (labelWords.every(w => btnText.includes(w))) return btn;
      }
    }

    console.warn('[TurnFill] findSelectTrigger: no trigger found for "' + fieldLabel + '"');
    return null;
  }

  function openDropdown(trigger) {
    trigger.focus();
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
      trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    });
  }

  // waitForDropdownClose removed — clicking a new trigger closes the previous one
  async function waitForDropdownClose() { return; }

  // Keywords for fuzzy fallback — handles tools where the option says
  // "Cannot Judge" or "Human Evaluator" instead of the full phrase.
  const HE_KEYWORDS = ['cannot judge', 'human evaluator'];

  async function pollForOption(targetText, trigger, maxMs = 2000) {
    const tNorm = norm(targetText);
    const deadline = Date.now() + maxMs;

    while (Date.now() < deadline) {
      const controlsId = trigger && (trigger.getAttribute('aria-controls') ||
        trigger.closest('[aria-controls]')?.getAttribute('aria-controls'));
      const specific = controlsId ? document.getElementById(controlsId) : null;
      const bases = specific ? [specific, document] : [document];

      for (const base of bases) {
        const candidates = base.querySelectorAll(
          '[role="option"], [role="listbox"] li, [role="listbox"] [role="option"],' +
          '[role="menu"] [role="menuitem"], li[data-value], [class*="option"][tabindex]'
        );
        // Pass 1: exact normalised match
        for (const c of candidates) {
          if (norm(c.textContent) === tNorm) return c;
        }
        // Pass 2: one string contains the other
        for (const c of candidates) {
          const ct = norm(c.textContent);
          if (ct.includes(tNorm) || (tNorm.includes(ct) && ct.length > 4)) return c;
        }
        // Pass 3: fuzzy keyword match — catches "Cannot Judge", "Human Evaluator" alone
        if (HE_KEYWORDS.some(kw => tNorm.includes(kw))) {
          for (const c of candidates) {
            const ct = norm(c.textContent);
            if (HE_KEYWORDS.some(kw => ct.includes(kw))) return c;
          }
        }
      }
      await sleep(25);
    }

    // Use console.error so this stands out in red even in a long log
    const allOpts = document.querySelectorAll('[role="option"]');
    const available = Array.from(allOpts).map(o => o.textContent.trim());
    if (available.length) {
      console.error('[TurnFill] ❌ "' + targetText + '" not in dropdown. Actual options:', available.join(' | '));
    } else {
      console.error('[TurnFill] ❌ "' + targetText + '" — dropdown opened but NO options appeared (0 [role=option] found).');
    }
    return null;
  }

  // Core: open a pre-found trigger and select an option by text.
  async function selectOptionWithTrigger(trigger, optionText) {
    if (trigger.tagName === 'SELECT') {
      const tNorm = norm(optionText);
      for (const opt of trigger.options) {
        if (norm(opt.text) === tNorm) {
          trigger.value = opt.value;
          trigger.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }
    openDropdown(trigger);
    const opt = await pollForOption(optionText, trigger);
    if (opt) {
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
        opt.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      });
      await sleep(20);
      return true;
    }
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }

  // Public: find trigger by label then delegate to selectOptionWithTrigger.
  async function selectOption(fieldLabel, optionText) {
    await waitForDropdownClose();
    const trigger = findSelectTrigger(fieldLabel);
    if (!trigger) {
      console.warn('[TurnFill] No trigger found for:', fieldLabel);
      return false;
    }
    return selectOptionWithTrigger(trigger, optionText);
  }

  // Try radio first; if no radio found, fall back to select dropdown.
  async function setField(groupLabel, optionText) {
    const radioOk = clickRadio(groupLabel, optionText);
    if (radioOk) return true;
    return await selectOption(groupLabel, optionText);
  }

  // ── Mode implementations ──────────────────────────────────────────────────

  async function applyNA() {
    if (_running) return;
    _running = true;
    try {
      // Tool Invoked Accurate is intentionally left out — evaluated manually now.
      await selectOption('Turn Type Classification', 'N/A');
      clickRadio('Context Switch Accurate', 'N/A');
      clickRadio('Conversation Context Accurate', 'N/A');
      showToast('N/A applied ✓', '#2e7d32');
    } finally { _running = false; }
  }

  async function applyHECannotJudge() {
    if (_running) return;
    _running = true;
    try {
      const HE = 'Human Evaluator - Cannot Judge';

      // Radio fields — synchronous, instant
      clickRadio('Context Switch Accurate',       HE);
      clickRadio('Conversation Context Accurate', HE);
      clickRadio('Tool Invoked Accurate',          HE);
      clickRadio('Response Content Accurate',      HE);

      // Dropdown fields — sequential; trigger found once and passed directly
      // to avoid a second DOM scan inside selectOption.
      const dropdownFields = [
        'Turn Type Classification',
        'HVA Category',
        'Interaction Type',
        'Static Response Type',
        'Customer Service Routing',
        'Negative Customer Feedback Classification',
      ];

      for (const field of dropdownFields) {
        const trigger = findSelectTrigger(field);
        if (!trigger) continue;   // field not on this page
        await selectOptionWithTrigger(trigger, HE);
      }

      showToast('HE Cannot Judge applied ✓', '#c0392b');
    } finally { _running = false; }
  }

  async function applyConcludeChat() {
    if (_running) return;
    _running = true;
    try {
      // Radio fields → N/A, except Response Content Accurate → Accurate
      clickRadio('Context Switch Accurate',       'N/A');
      clickRadio('Conversation Context Accurate', 'N/A');
      clickRadio('Tool Invoked Accurate',          'N/A');
      clickRadio('Response Content Accurate',      'Accurate');

      // Dropdown fields → N/A, except Static Response Type → Concluding Message
      const naDropdownFields = [
        'Turn Type Classification',
        'HVA Category',
        'Interaction Type',
        'Customer Service Routing',
        'Negative Customer Feedback Classification',
      ];

      for (const field of naDropdownFields) {
        const trigger = findSelectTrigger(field);
        if (!trigger) continue;   // field not on this page
        await selectOptionWithTrigger(trigger, 'N/A');
      }

      const staticTrigger = findSelectTrigger('Static Response Type');
      if (staticTrigger) await selectOptionWithTrigger(staticTrigger, 'Concluding Message');

      showToast('Conclude Chat applied ✓', '#8e44ad');
    } finally { _running = false; }
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  function showToast(msg, bg) {
    let t = document.getElementById(TOAST_ID);
    if (!t) {
      t = document.createElement('div');
      t.id = TOAST_ID;
      Object.assign(t.style, {
        position: 'fixed', bottom: '24px', right: '24px',
        padding: '10px 16px', borderRadius: '10px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: '13px', fontWeight: '600', color: '#fff',
        zIndex: '2000000', pointerEvents: 'none',
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        transition: 'opacity 0.35s, transform 0.35s',
        display: 'flex', alignItems: 'center', gap: '8px',
      });
      document.body.appendChild(t);
    }
    t.style.background = bg;
    t.style.opacity = '1';
    t.style.transform = 'translateY(0)';
    t.textContent = msg;
    clearTimeout(t._hide);
    t._hide = setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateY(6px)';
    }, 2200);
  }

  // ── Floating panel ────────────────────────────────────────────────────────
  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    // Inject keyframe animations once
    if (!document.getElementById('otf-styles')) {
      const style = document.createElement('style');
      style.id = 'otf-styles';
      style.textContent = `
        #otf-panel { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
        #otf-panel .otf-btn {
          display: flex; align-items: center; gap: 10px;
          width: 100%; border: none; cursor: pointer; border-radius: 8px;
          padding: 9px 10px; transition: background 0.15s, transform 0.1s; text-align: left;
        }
        #otf-panel .otf-btn:hover  { background: #ede3d8 !important; }
        #otf-panel .otf-btn:active { transform: scale(0.97); }
        #otf-panel .otf-key {
          display: inline-flex; align-items: center; justify-content: center;
          width: 20px; height: 20px; border-radius: 5px; font-size: 11px;
          font-weight: 700; flex-shrink: 0; letter-spacing: 0;
        }
        #otf-panel .otf-label { font-size: 12.5px; font-weight: 600; color: #4a3220; flex: 1; }
        #otf-panel .otf-divider { height: 1px; background: #ddd0c0; margin: 4px 0; }
        @keyframes otf-fadein { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:translateY(0); } }
      `;
      document.head.appendChild(style);
    }

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed', top: '120px', right: '16px', zIndex: '1999999',
      background: '#fdf6ed',
      border: '1px solid #ddd0bc',
      borderRadius: '14px',
      padding: '0',
      width: '192px',
      boxShadow: '0 6px 24px rgba(120,80,30,0.13), 0 1px 4px rgba(120,80,30,0.08)',
      userSelect: 'none', overflow: 'hidden',
      animation: 'otf-fadein 0.2s ease',
    });

    // ── Header (drag handle) ──────────────────────────────────────────────
    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '11px 14px 10px',
      background: 'linear-gradient(135deg, #f5e6d3 0%, #eedec8 100%)',
      borderBottom: '1px solid #ddd0bc',
      cursor: 'grab', display: 'flex', alignItems: 'center', gap: '8px',
    });

    const headerIcon = document.createElement('span');
    headerIcon.textContent = '⚡';
    headerIcon.style.fontSize = '13px';
    header.appendChild(headerIcon);

    const headerText = document.createElement('span');
    headerText.textContent = 'Turn Fill';
    Object.assign(headerText.style, {
      fontSize: '11px', fontWeight: '700', color: '#7a5c3e',
      letterSpacing: '0.6px', textTransform: 'uppercase', flex: '1',
    });
    header.appendChild(headerText);

    // Minimize toggle
    let collapsed = false;
    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = '−';
    Object.assign(toggleBtn.style, {
      background: 'none', border: 'none', color: '#b09a82', cursor: 'pointer',
      fontSize: '16px', lineHeight: '1', padding: '0', width: '18px',
      textAlign: 'center', transition: 'color 0.15s',
    });
    toggleBtn.onmouseenter = () => toggleBtn.style.color = '#7a5c3e';
    toggleBtn.onmouseleave = () => toggleBtn.style.color = '#b09a82';
    header.appendChild(toggleBtn);
    panel.appendChild(header);

    // ── Button body ───────────────────────────────────────────────────────
    const body = document.createElement('div');
    Object.assign(body.style, { padding: '8px', display: 'flex', flexDirection: 'column', gap: '3px' });

    const BTN_DEFS = [
      { key: '1', label: 'N/A Fill',        fn: applyNA,            accent: '#2e7d32', bg: 'rgba(46,125,50,0.10)'   },
      { key: '2', label: 'HE Cannot Judge', fn: applyHECannotJudge, accent: '#c0392b', bg: 'rgba(192,57,43,0.10)'  },
      { key: '3', label: 'Conclude Chat',   fn: applyConcludeChat, accent: '#8e44ad', bg: 'rgba(142,68,173,0.10)' },
    ];

    for (const { key, label, fn, accent, bg } of BTN_DEFS) {
      const btn = document.createElement('button');
      btn.className = 'otf-btn';
      btn.style.background = 'transparent';

      const badge = document.createElement('span');
      badge.className = 'otf-key';
      badge.textContent = key;
      badge.style.background = bg;
      badge.style.color = accent;
      badge.style.border = `1px solid ${accent}44`;
      btn.appendChild(badge);

      const lbl = document.createElement('span');
      lbl.className = 'otf-label';
      lbl.textContent = label;
      btn.appendChild(lbl);

      btn.addEventListener('click', () => fn());
      body.appendChild(btn);
    }

    const divider = document.createElement('div');
    divider.className = 'otf-divider';
    divider.style.marginTop = '5px';
    body.appendChild(divider);

    const hint = document.createElement('div');
    hint.textContent = 'Keys  1 · 2 · 3';
    Object.assign(hint.style, {
      fontSize: '10px', color: '#b09a82', textAlign: 'center',
      padding: '2px 0 3px', letterSpacing: '0.3px',
    });
    body.appendChild(hint);
    panel.appendChild(body);

    // ── Minimize toggle behaviour ─────────────────────────────────────────
    toggleBtn.addEventListener('click', e => {
      e.stopPropagation();
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : '';
      toggleBtn.textContent = collapsed ? '+' : '−';
      panel.style.borderRadius = collapsed ? '10px' : '14px';
    });

    // ── Drag ─────────────────────────────────────────────────────────────
    let dragging = false, ox = 0, oy = 0;
    header.addEventListener('mousedown', e => {
      if (e.target === toggleBtn) return;
      dragging = true;
      ox = e.clientX - panel.getBoundingClientRect().left;
      oy = e.clientY - panel.getBoundingClientRect().top;
      header.style.cursor = 'grabbing';
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      panel.style.left  = (e.clientX - ox) + 'px';
      panel.style.top   = (e.clientY - oy) + 'px';
      panel.style.right = 'unset';
    });
    document.addEventListener('mouseup', () => { dragging = false; header.style.cursor = 'grab'; });

    document.body.appendChild(panel);
  }

  document.addEventListener('keydown', e => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.key === '1') applyNA();
    else if (e.key === '2') applyHECannotJudge();
    else if (e.key === '3') applyConcludeChat();
  });

  // Watch for the annotation panel to appear (SPA navigation), then stop.
  const mo = new MutationObserver(() => {
    if (document.querySelector('input[type="radio"]') || document.querySelector('[role="radiogroup"]')) {
      createPanel();
      if (document.getElementById(PANEL_ID)) mo.disconnect();
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  if (document.body) createPanel();

})();
