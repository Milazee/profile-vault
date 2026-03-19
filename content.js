// Profile Vault — content.js
// Injected into all pages via manifest. Scans and fills form fields.

(function () {
  // Avoid re-injection conflicts
  if (window.__profileVaultLoaded) return;
  window.__profileVaultLoaded = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'scanFields') {
      const fields = scanFields();
      sendResponse({ fields });
      return;
    }

    if (message.action === 'fillFields') {
      fillFields(message.fills || []).then(filled => sendResponse({ filled }));
      return true; // async response
    }
  });

  // ─── Scan form fields ────────────────────────────────────────────────────────

  function scanFields() {
    // Remove old profile vault markers
    document.querySelectorAll('[data-pv-idx]').forEach(el => el.removeAttribute('data-pv-idx'));

    const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'file', 'image', 'checkbox']);

    const fields = [];
    let idx = 0;

    // Cast a wide net: native fields + custom ARIA components Ashby uses
    const elements = document.querySelectorAll(
      'input, select, textarea, ' +
      '[role="radio"], [role="combobox"], [role="checkbox"], ' +
      'button[aria-pressed]'
    );

    // Ashby Boolean fields: plain <button> elements labeled "Yes" / "No"
    // with no aria-pressed. Collect them separately to avoid duplicate processing.
    const yesNoButtons = Array.from(document.querySelectorAll('button')).filter(btn => {
      if (btn.disabled || !isVisible(btn)) return false;
      if (btn.hasAttribute('aria-pressed') || btn.getAttribute('role') === 'radio') return false;
      const text = btn.textContent.trim().toLowerCase();
      return text === 'yes' || text === 'no';
    });

    for (const el of elements) {
      if (el.disabled) continue;

      const tagName  = el.tagName.toLowerCase();
      const type     = (el.getAttribute('type') || '').toLowerCase();
      const roleAttr = el.getAttribute('role') || '';

      // ── role="combobox" — Ashby's custom select (EEO, ValueSelect fields) ──
      if (roleAttr === 'combobox') {
        if (!isVisible(el)) continue;
        const label   = getLabel(el) || el.getAttribute('aria-label') || '';
        const context = getNearbyContext(el);
        el.setAttribute('data-pv-idx', idx);
        fields.push({ idx, type: 'combobox', label, name: el.getAttribute('name') || '',
          placeholder: el.getAttribute('placeholder') || '',
          autocomplete: '', context });
        idx++;
        continue;
      }

      // ── button[aria-pressed] — Ashby Boolean Yes/No segmented controls ──
      if (tagName === 'button' && el.hasAttribute('aria-pressed')) {
        if (!isVisible(el)) continue;
        const btnLabel = el.getAttribute('aria-label') || el.textContent?.trim() || '';
        const radioValue = el.getAttribute('value') || el.getAttribute('data-value') || btnLabel;
        el.setAttribute('data-pv-idx', idx);
        fields.push({ idx, type: 'radio', label: btnLabel, name: '',
          placeholder: '', autocomplete: '', radioValue,
          context: getNearbyContext(el) });
        idx++;
        continue;
      }

      // ── role="checkbox" — ARIA checkboxes (Ashby pronoun/community checkboxes) ──
      if (roleAttr === 'checkbox') {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const cbLabel = getLabel(el) || el.getAttribute('aria-label') || el.textContent?.trim() || '';
        const cbCtx   = getNearbyContext(el);
        const cbCombined = [cbLabel, el.getAttribute('name') || '', cbCtx].join(' ').toLowerCase();
        if (/\b(agree|accept|consent|terms|privacy|policy|condition|certif|acknowledg|authoriz|confirm|opt.?in)\b/.test(cbCombined)) continue;
        if (!cbLabel.trim()) continue;
        el.setAttribute('data-pv-idx', idx);
        const cbValue = el.getAttribute('value') || cbLabel;
        fields.push({ idx, type: 'checkbox', label: cbLabel || cbValue,
          name: el.getAttribute('name') || '', placeholder: '', autocomplete: '',
          radioValue: cbLabel || cbValue, context: cbCtx });
        idx++;
        continue;
      }

      // ── role="radio" — Radix UI radio buttons ──
      if (roleAttr === 'radio') {
        if (!isVisible(el)) continue;
        const radioLabel = el.getAttribute('aria-label') || el.textContent?.trim() || '';
        const radioValue = el.getAttribute('value') || el.getAttribute('data-value') || radioLabel;
        const group = el.closest('[role="radiogroup"]');
        const groupLabel = group
          ? (group.getAttribute('aria-label') ||
             document.getElementById(group.getAttribute('aria-labelledby') || '')?.textContent?.trim() || '')
          : '';
        el.setAttribute('data-pv-idx', idx);
        fields.push({ idx, type: 'radio', label: radioLabel, name: groupLabel,
          placeholder: '', autocomplete: '', radioValue,
          context: getNearbyContext(el) });
        idx++;
        continue;
      }

      // ── Standard input[type="radio"]: relaxed visibility (often CSS-hidden) ──
      if (tagName === 'input' && type === 'radio') {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        el.setAttribute('data-pv-idx', idx);
        const radioLabel = getLabel(el) || el.getAttribute('aria-label') || el.getAttribute('value') || '';
        const radioValue = el.getAttribute('value') || el.value || '';
        fields.push({ idx, type: 'radio', label: radioLabel,
          name: el.getAttribute('name') || '',
          placeholder: '', autocomplete: '', radioValue,
          context: getNearbyContext(el) });
        idx++;
        continue;
      }

      // ── input[type="checkbox"]: relaxed visibility (custom UIs often CSS-hide native checkboxes) ──
      if (tagName === 'input' && type === 'checkbox') {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const cbLabel = getLabel(el) || el.getAttribute('aria-label') || '';
        const cbCtx   = getNearbyContext(el);
        const cbCombined = [cbLabel, el.getAttribute('name') || '', cbCtx].join(' ').toLowerCase();
        // Skip consent / agreement / terms checkboxes — never auto-accept these
        if (/\b(agree|accept|consent|terms|privacy|policy|condition|certif|acknowledg|authoriz|confirm|opt.?in)\b/.test(cbCombined)) continue;
        // Skip unlabeled checkboxes
        if (!cbLabel.trim()) continue;
        el.setAttribute('data-pv-idx', idx);
        const cbValue = el.getAttribute('value') || el.value || cbLabel;
        fields.push({ idx, type: 'checkbox', label: cbLabel || cbValue,
          name: el.getAttribute('name') || '', placeholder: '', autocomplete: '',
          radioValue: cbLabel || cbValue, context: cbCtx });
        idx++;
        continue;
      }

      // ── input[type="file"]: relaxed visibility — custom upload UIs always CSS-hide the native input ──
      if (tagName === 'input' && type === 'file') {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const accept = el.getAttribute('accept') || '';
        const name   = el.getAttribute('name') || '';
        const aria   = el.getAttribute('aria-label') || '';
        const label  = getLabel(el);
        const ctx    = getNearbyContext(el);
        const combined = [label, name, aria, accept, ctx].join(' ').toLowerCase();
        const isResumeField = /resume|curriculum.?vitae|\bcv\b/.test(combined)
          || /\.pdf|\.doc|application\/pdf|application\/(msword|vnd\.openxmlformats)/.test(accept)
          || /\b(pdf|docx?)\b/.test(combined);  // "Accepted formats: PDF, DOC, DOCX"
        if (!isResumeField) continue;
        el.setAttribute('data-pv-idx', idx);
        const label2 = label || aria || name || 'Resume';
        fields.push({ idx, type: 'file', label: label2, name, placeholder: '', autocomplete: '', context: ctx });
        idx++;
        continue;
      }

      // ── All other elements: standard visibility + readonly check ──
      if (!isVisible(el)) continue;
      if (el.readOnly) continue;

      if (tagName === 'input' && SKIP_TYPES.has(type)) {
        continue;
      }

      el.setAttribute('data-pv-idx', idx);

      const label = getLabel(el);
      const placeholder = el.getAttribute('placeholder') || '';
      const name = el.getAttribute('name') || '';
      const autocomplete = el.getAttribute('autocomplete') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const effectiveLabel = label || ariaLabel || placeholder || name;

      fields.push({
        idx,
        type: tagName === 'select' ? 'select' : (type || tagName),
        label: effectiveLabel,
        name,
        placeholder,
        autocomplete,
        context: getNearbyContext(el)
      });

      idx++;
    }

    // Process Ashby-style Yes/No buttons (no aria-pressed, no role="radio")
    for (const btn of yesNoButtons) {
      if (btn.hasAttribute('data-pv-idx')) continue; // already indexed above
      const text     = btn.textContent.trim();
      const btnValue = btn.getAttribute('value') || btn.getAttribute('data-value') || text;
      btn.setAttribute('data-pv-idx', idx);
      fields.push({ idx, type: 'radio', label: text, name: '',
        placeholder: '', autocomplete: '', radioValue: btnValue,
        context: getNearbyContext(btn) });
      idx++;
    }

    // Debug: log all detected fields so you can inspect in DevTools
    console.debug('[ProfileVault] scanFields found:', fields.map(f =>
      `[${f.idx}] ${f.type}${f.radioValue ? `(${f.radioValue})` : ''} label="${f.label}" name="${f.name}" ctx="${f.context}"`
    ));

    return fields;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function getLabel(el) {
    // 1. Explicit <label for="id">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }

    // 2. Wrapping <label>
    const parent = el.closest('label');
    if (parent) {
      const clone = parent.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach(n => n.remove());
      return clone.textContent.trim();
    }

    // 3. aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/);
      const texts = ids.map(id => document.getElementById(id)?.textContent.trim()).filter(Boolean);
      if (texts.length) return texts.join(' ');
    }

    // 4. Previous sibling text
    const prev = el.previousElementSibling;
    if (prev && ['LABEL', 'SPAN', 'P', 'DIV'].includes(prev.tagName)) {
      const t = prev.textContent.trim();
      if (t.length < 80) return t;
    }

    return '';
  }

  function getNearbyContext(el) {
    let node = el.parentElement;
    for (let i = 0; i < 6 && node; i++) {
      // Explicit heading or legend
      const heading = node.querySelector('h1, h2, h3, h4, legend');
      if (heading) return heading.textContent.trim().slice(0, 100);

      // role="group" or role="radiogroup" with aria-label or aria-labelledby
      const role = node.getAttribute('role');
      if (role === 'group' || role === 'radiogroup') {
        const ariaLabel = node.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel.trim().slice(0, 100);
        const labelledBy = node.getAttribute('aria-labelledby');
        if (labelledBy) {
          const labelEl = document.getElementById(labelledBy);
          if (labelEl) return labelEl.textContent.trim().slice(0, 100);
        }
      }

      // Previous sibling that looks like a question label (e.g. Ashby Yes/No button groups)
      const prev = node.previousElementSibling;
      if (prev && !prev.querySelector('input, select, textarea, button')) {
        const t = prev.textContent.trim();
        if (t.length >= 10 && t.length <= 300) return t.slice(0, 150);
      }

      // Node's own text content minus any nested form elements / buttons
      // (catches question text that shares a parent with the field)
      const clone = node.cloneNode(true);
      clone.querySelectorAll('input, select, textarea, button').forEach(n => n.remove());
      const nodeText = clone.textContent.trim();
      if (nodeText.length >= 10 && nodeText.length <= 300) return nodeText.slice(0, 150);

      node = node.parentElement;
    }
    return '';
  }

  // ─── Fill form fields ─────────────────────────────────────────────────────────

  async function fillFields(fills) {
    let count = 0;

    console.debug('[ProfileVault] fillFields instructions:', fills);

    for (const { idx, value } of fills) {
      const el = document.querySelector(`[data-pv-idx="${idx}"]`);
      if (!el || !value) continue;

      const tagName  = el.tagName.toLowerCase();
      const roleAttr = el.getAttribute('role') || '';

      console.debug(`[ProfileVault] filling idx=${idx} tag=${tagName} role=${roleAttr} value="${value}"`);

      try {
        if (tagName === 'select') {
          fillSelect(el, value);
        } else if (tagName === 'textarea') {
          fillTextArea(el, value);
        } else if (el.type === 'file' && value === '__RESUME__') {
          await fillResumeFile(el);
        } else if (roleAttr === 'combobox') {
          await fillCombobox(el, value);
        } else if (el.type === 'checkbox') {
          // Use click() only — native setter + click double-toggles.
          if (value === 'checked' && !el.checked) {
            el.click();
          }
        } else if (roleAttr === 'checkbox') {
          // ARIA checkbox (e.g. Ashby pronoun/community divs with role="checkbox")
          if (value === 'checked' && el.getAttribute('aria-checked') !== 'true') {
            el.click();
          }
        } else if (el.type === 'radio' || roleAttr === 'radio' || tagName === 'button') {
          // button covers: aria-pressed, role="radio", and plain Yes/No buttons
          fillRadio(el);
        } else {
          fillInput(el, value);
        }
        count++;
        highlight(el);
      } catch (err) {
        console.debug(`[ProfileVault] fill error idx=${idx}:`, err);
      }

      // Small delay between fills lets React process state updates (blur-triggered
      // re-renders) before the next fill — prevents earlier fields being reset.
      await new Promise(r => setTimeout(r, 50));
    }

    return count;
  }

  function fillRadio(el) {
    const roleAttr = el.getAttribute('role') || '';
    const tagName  = el.tagName.toLowerCase();

    // Any button element (aria-pressed, role="radio", or plain Yes/No button) — just click
    if (tagName === 'button') {
      el.click();
      return;
    }

    // Native input[type="radio"] — set checked, then click label
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, true);
    } else {
      el.checked = true;
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input',  { bubbles: true }));

    const label = el.id
      ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      : el.closest('label');
    if (label) {
      label.click();
    } else {
      el.click();
    }
  }

  async function fillCombobox(el, value) {
    // Open the dropdown
    el.click();

    // Some comboboxes (e.g. Ashby "Start typing…") move focus to a *separate* input
    // elsewhere in the DOM rather than having a child input. Wait briefly for the DOM
    // to settle after click, then try multiple strategies to find the input to type into.
    await new Promise(resolve => setTimeout(resolve, 80));

    let inputTarget = el.tagName.toLowerCase() === 'input'
      ? el
      : el.querySelector('input');

    // Strategy 2: check the currently focused element
    if (!inputTarget) {
      const active = document.activeElement;
      if (active && active.tagName.toLowerCase() === 'input') inputTarget = active;
    }

    if (inputTarget) {
      // Explicitly focus so the component registers typing
      inputTarget.focus();

      // Simulate typing character-by-character so React's synthetic event system
      // treats each keystroke as real user input (triggers API-backed search).
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      for (let i = 0; i < value.length; i++) {
        const char = value[i];
        const partial = value.slice(0, i + 1);
        inputTarget.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
        if (nativeSetter) nativeSetter.call(inputTarget, partial); else inputTarget.value = partial;
        inputTarget.dispatchEvent(new InputEvent('input', {
          bubbles: true, cancelable: true, inputType: 'insertText', data: char
        }));
        inputTarget.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
        await new Promise(r => setTimeout(r, 30));
      }
      inputTarget.dispatchEvent(new Event('change', { bubbles: true }));
      console.debug(`[ProfileVault] combobox typed "${value}" into`, inputTarget);
    } else {
      // Non-input combobox: dispatch ArrowDown to open
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    }

    // Wait for listbox to render / filter to apply.
    // API-backed search comboboxes (e.g. location) need more time than static dropdowns.
    await new Promise(resolve => setTimeout(resolve, 700));

    // Find the listbox — may be in a portal outside the current container.
    // Retry once after an extra 500ms for slow API-backed searches.
    let listbox = document.querySelector('[role="listbox"]');
    if (!listbox) {
      await new Promise(resolve => setTimeout(resolve, 500));
      listbox = document.querySelector('[role="listbox"]');
    }
    if (!listbox) {
      console.debug('[ProfileVault] combobox: no listbox found after open');
      el.blur();
      return;
    }

    const options = Array.from(listbox.querySelectorAll('[role="option"]'));
    const lower   = value.toLowerCase();

    const match = options.find(o => o.textContent.trim() === value)
      || options.find(o => o.textContent.trim().toLowerCase() === lower)
      || options.find(o => o.textContent.trim().toLowerCase().includes(lower)
                        || lower.includes(o.textContent.trim().toLowerCase()));

    console.debug(`[ProfileVault] combobox value="${value}" options=[${options.map(o => o.textContent.trim()).join(', ')}] match="${match?.textContent.trim()}"`);

    if (match) {
      match.click();
    } else {
      // Close without selecting
      el.click();
    }
  }

  async function fillResumeFile(el) {
    const { resumeFile } = await chrome.storage.local.get('resumeFile');
    if (!resumeFile?.raw) return;

    const binary = atob(resumeFile.raw);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const mimeType = resumeFile.type || 'application/octet-stream';
    const file = new File([bytes], resumeFile.name, { type: mimeType });
    const dt   = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input',  { bubbles: true }));
  }

  function fillInput(el, value, { skipBlur = false } = {}) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // blur() commits the value into React Hook Form / Formik state.
    // Without it fields appear filled visually but are empty on submit.
    if (!skipBlur) el.blur();
  }

  function fillTextArea(el, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  function fillSelect(el, value) {
    const options = Array.from(el.options);
    const lower = value.toLowerCase();

    let match = options.find(o => o.value === value || o.text === value)
      || options.find(o => o.value.toLowerCase() === lower || o.text.toLowerCase() === lower)
      || options.find(o => o.text.toLowerCase().includes(lower) || lower.includes(o.text.toLowerCase()));

    if (match) {
      el.value = match.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function highlight(el) {
    const prev = el.style.outline;
    const prevTransition = el.style.transition;
    el.style.transition = 'outline 0.1s';
    el.style.outline = '2px solid #7c3aed';
    setTimeout(() => {
      el.style.outline = prev;
      el.style.transition = prevTransition;
    }, 1500);
  }
})();
