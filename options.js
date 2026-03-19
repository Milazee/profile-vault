// Profile Vault — options.js

// ─── Resume upload (options page) ─────────────────────────────────────────────

let optionsSelectedFile = null;

document.getElementById('options-resume-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  optionsSelectedFile = file;
  document.getElementById('options-file-name').textContent = file.name;
  document.getElementById('options-parse-btn').disabled = false;
  setParseStatus('', '');
});

document.getElementById('options-parse-btn').addEventListener('click', async () => {
  if (!optionsSelectedFile) return;

  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    setParseStatus('Save your API key first, then try again.', 'error');
    return;
  }

  setParseStatus('Reading file…', 'loading');
  document.getElementById('options-parse-btn').disabled = true;

  try {
    const fileData = await readFile(optionsSelectedFile);
    // Store raw file for later viewing
    await storeResumeFile(optionsSelectedFile);

    setParseStatus('Parsing with Claude — this takes a few seconds…', 'loading');

    const profile = await chrome.runtime.sendMessage({
      action: 'parseResume',
      fileData: fileData.data,
      fileType: fileData.type,
      fileName: optionsSelectedFile.name
    });

    if (profile.error) {
      setParseStatus(profile.error, 'error');
      document.getElementById('options-parse-btn').disabled = false;
      return;
    }

    populateFields(profile);
    displayStoredResume(await getStoredResume());
    setParseStatus('Profile filled! Fields are saving automatically.', 'success');
  } catch (err) {
    setParseStatus('Error: ' + err.message, 'error');
  } finally {
    document.getElementById('options-parse-btn').disabled = false;
  }
});

// ─── Resume file storage & display ───────────────────────────────────────────

async function storeResumeFile(file) {
  const ab = await file.arrayBuffer();
  const raw = arrayBufferToBase64(ab);
  const meta = {
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    storedAt: Date.now(),
    raw                         // base64 of original file bytes
  };
  // Silently skip if file is too large for storage (>5MB raw)
  if (raw.length < 7_000_000) {
    await chrome.storage.local.set({ resumeFile: meta });
  }
}

async function getStoredResume() {
  const { resumeFile } = await chrome.storage.local.get('resumeFile');
  return resumeFile || null;
}

function displayStoredResume(resumeFile) {
  const el = document.getElementById('stored-resume');
  if (!resumeFile) { el.style.display = 'none'; return; }

  const ext  = resumeFile.name.split('.').pop().toLowerCase();
  const icon = ext === 'pdf' ? '📕' : ext === 'docx' ? '📘' : '📄';
  const size = resumeFile.size < 1024 * 1024
    ? `${Math.round(resumeFile.size / 1024)} KB`
    : `${(resumeFile.size / (1024 * 1024)).toFixed(1)} MB`;
  const date = new Date(resumeFile.storedAt).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric'
  });

  document.getElementById('stored-resume-icon').textContent = icon;
  document.getElementById('stored-resume-name').textContent = resumeFile.name;
  document.getElementById('stored-resume-meta').textContent = `${size} · Uploaded ${date}`;
  el.style.display = 'flex';
}

document.getElementById('open-resume-btn').addEventListener('click', async () => {
  const resumeFile = await getStoredResume();
  if (!resumeFile?.raw) return;

  const binary = atob(resumeFile.raw);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const mimeType = resumeFile.type || 'application/octet-stream';
  const blob = new Blob([bytes], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  window.open(url, '_blank');
  // Revoke after a short delay to allow the tab to load
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
});

function setParseStatus(msg, type) {
  const el = document.getElementById('parse-status');
  el.textContent = msg;
  el.className = type;
}

async function readFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'txt') return { type: 'text', data: await file.text() };
  if (ext === 'pdf') {
    const ab = await file.arrayBuffer();
    return { type: 'pdf', data: arrayBufferToBase64(ab) };
  }
  if (ext === 'docx') {
    const ab = await file.arrayBuffer();
    return { type: 'text', data: await extractDocxText(ab) };
  }
  throw new Error('Unsupported file type. Use PDF, DOCX, or TXT.');
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function extractDocxText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Invalid DOCX file');
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdSize   = view.getUint32(eocdOffset + 12, true);
  let pos = cdOffset;
  while (pos < cdOffset + cdSize) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const compression    = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const fnLen          = view.getUint16(pos + 28, true);
    const extraLen       = view.getUint16(pos + 30, true);
    const commentLen     = view.getUint16(pos + 32, true);
    const localOffset    = view.getUint32(pos + 42, true);
    const fileName       = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + fnLen));
    if (fileName === 'word/document.xml') {
      const localFNLen    = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataOffset    = localOffset + 30 + localFNLen + localExtraLen;
      const compressed    = bytes.slice(dataOffset, dataOffset + compressedSize);
      let xmlBytes;
      if (compression === 0) {
        xmlBytes = compressed;
      } else {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        writer.write(compressed); writer.close();
        const chunks = [];
        while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        xmlBytes = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { xmlBytes.set(c, off); off += c.length; }
      }
      const xml = new TextDecoder('utf-8').decode(xmlBytes);
      return (xml.match(/<w:t[^>]*>([^<]+)<\/w:t>/g) || []).map(m => m.replace(/<[^>]+>/g, '')).join(' ');
    }
    pos += 46 + fnLen + extraLen + commentLen;
  }
  throw new Error('Could not read DOCX content');
}

function populateFields(profile) {
  const nameParts  = (profile.name      || '').trim().split(/\s+/);
  const legalParts = (profile.legalName || profile.name || '').trim().split(/\s+/);

  setValue('f-first-name',       profile.firstName      || nameParts[0]             || '');
  setValue('f-last-name',        profile.lastName       || nameParts.slice(1).join(' ') || '');
  setValue('f-preferred-name',   profile.preferredName  || '');
  setValue('f-pronouns',         profile.pronouns       || '');
  setValue('f-legal-first-name', profile.legalFirstName || legalParts[0]            || '');
  setValue('f-legal-last-name',  profile.legalLastName  || legalParts.slice(1).join(' ') || '');
  setValue('f-email',    profile.email);
  setValue('f-phone',    profile.phone);
  setValue('f-address',  profile.address);
  setValue('f-city',     profile.city);
  setValue('f-state',    profile.state);
  setValue('f-zip',      profile.zip);
  setValue('f-country',  profile.country);
  setValue('f-linkedin', profile.linkedin);

  if (profile.pay) {
    setValue('f-pay-type',     profile.pay.type);
    setValue('f-pay-currency', profile.pay.currency);
    setValue('f-pay-min',      profile.pay.min);
    setValue('f-pay-target',   profile.pay.target);
    setValue('f-pay-max',      profile.pay.max);
    setValue('f-pay-open-to',  profile.pay.openTo);
  }
  setValue('f-summary',  profile.summary);
  setValue('f-skills',   Array.isArray(profile.skills) ? profile.skills.join(', ') : (profile.skills || ''));

  if (profile.eeo) {
    setValue('eeo-work-auth',          profile.eeo.workAuth);
    setValue('eeo-sponsorship',        profile.eeo.sponsorship);
    setValue('eeo-gender',             profile.eeo.gender);
    setValue('eeo-hispanic',           profile.eeo.hispanic);
    setValue('eeo-race',               profile.eeo.race);
    setValue('eeo-sexual-orientation', profile.eeo.sexualOrientation);
    // Restore community checkboxes
    const communities = Array.isArray(profile.eeo.communities) ? profile.eeo.communities : [];
    document.querySelectorAll('#eeo-communities input[type="checkbox"]').forEach(cb => {
      cb.checked = communities.includes(cb.value);
    });
  }

  const certList = document.getElementById('certification-list');
  certList.innerHTML = '';
  (profile.certifications || []).forEach((entry, i) => certList.appendChild(createCertificationEntry(entry, i)));

  const eduList = document.getElementById('education-list');
  eduList.innerHTML = '';
  (profile.education || []).forEach((entry, i) => eduList.appendChild(createEducationEntry(entry, i)));

  const expList = document.getElementById('experience-list');
  expList.innerHTML = '';
  (profile.experience || []).forEach((entry, i) => expList.appendChild(createExperienceEntry(entry, i)));
}

const MONTHS = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function monthOptions(selected) {
  return MONTHS.map((m, i) =>
    i === 0
      ? `<option value="">Month</option>`
      : `<option value="${i}" ${String(selected) === String(i) ? 'selected' : ''}>${m}</option>`
  ).join('');
}

function yearOptions(selected) {
  const current = new Date().getFullYear();
  let opts = `<option value="">Year</option>`;
  for (let y = current; y >= 1970; y--) {
    opts += `<option value="${y}" ${String(selected) === String(y) ? 'selected' : ''}>${y}</option>`;
  }
  return opts;
}

// ─── Education entry ──────────────────────────────────────────────────────────

function createEducationEntry(data = {}, index) {
  const div = document.createElement('div');
  div.className = 'entry-card';
  div.dataset.type = 'education';

  div.innerHTML = `
    <div class="entry-header">
      <span class="entry-label">Education ${index + 1}</span>
      <button class="remove-btn" type="button">Remove</button>
    </div>
    <div class="grid-2">
      <div class="field-group">
        <label>School / University</label>
        <input type="text" name="school" placeholder="MIT" value="${esc(data.school || '')}">
      </div>
      <div class="field-group">
        <label>Degree &amp; Field of Study</label>
        <input type="text" name="degree" placeholder="B.S. Computer Science" value="${esc(data.degree || '')}">
      </div>
    </div>
    <div style="margin-top:13px">
      <label style="display:block;margin-bottom:8px;font-size:11.5px;font-weight:500;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Dates Attended</label>
      <div class="date-range">
        <div class="field-group">
          <label>Start Month</label>
          <select name="startMonth">${monthOptions(data.startMonth)}</select>
        </div>
        <div class="field-group">
          <label>Start Year</label>
          <select name="startYear">${yearOptions(data.startYear)}</select>
        </div>
        <div class="date-sep">→</div>
        <div class="field-group">
          <label>End Month</label>
          <select name="endMonth">${monthOptions(data.endMonth)}</select>
        </div>
        <div class="field-group">
          <label>End Year</label>
          <select name="endYear">${yearOptions(data.endYear)}</select>
        </div>
      </div>
    </div>
  `;

  div.querySelector('.remove-btn').addEventListener('click', () => {
    div.remove();
    renumberEntries('education-list', 'Education');
    scheduleAutosave();
  });

  return div;
}

// ─── Experience entry ─────────────────────────────────────────────────────────

function createExperienceEntry(data = {}, index) {
  const div = document.createElement('div');
  div.className = 'entry-card';
  div.dataset.type = 'experience';

  div.innerHTML = `
    <div class="entry-header">
      <span class="entry-label">Experience ${index + 1}</span>
      <button class="remove-btn" type="button">Remove</button>
    </div>
    <div class="grid-2">
      <div class="field-group">
        <label>Job Title</label>
        <input type="text" name="title" placeholder="Senior Engineer" value="${esc(data.title || '')}">
      </div>
      <div class="field-group">
        <label>Company</label>
        <input type="text" name="company" placeholder="Acme Corp" value="${esc(data.company || '')}">
      </div>
      <div class="field-group full">
        <label>Location</label>
        <input type="text" name="location" placeholder="San Francisco, CA" value="${esc(data.location || '')}">
      </div>
      <div class="field-group full">
        <label>Description / Key Achievements</label>
        <textarea name="description" placeholder="• Led a team of 5 engineers to…&#10;• Increased performance by 30%">${esc(descriptionToText(data.description))}</textarea>
      </div>
    </div>
    <div style="margin-top:13px">
      <label style="display:block;margin-bottom:8px;font-size:11.5px;font-weight:500;color:#64748b;text-transform:uppercase;letter-spacing:.04em">Employment Dates</label>
      <div class="date-range">
        <div class="field-group">
          <label>Start Month</label>
          <select name="startMonth">${monthOptions(data.startMonth)}</select>
        </div>
        <div class="field-group">
          <label>Start Year</label>
          <select name="startYear">${yearOptions(data.startYear)}</select>
        </div>
        <div class="date-sep">→</div>
        <div class="field-group">
          <label>End Month</label>
          <select name="endMonth">${monthOptions(data.endMonth)}</select>
        </div>
        <div class="field-group">
          <label>End Year <span style="color:#334155;text-transform:none;font-weight:400">(blank = present)</span></label>
          <select name="endYear">${yearOptions(data.endYear)}</select>
        </div>
      </div>
    </div>
  `;

  div.querySelector('.remove-btn').addEventListener('click', () => {
    div.remove();
    renumberEntries('experience-list', 'Experience');
    scheduleAutosave();
  });

  return div;
}

// ─── Certification entry ──────────────────────────────────────────────────────

function createCertificationEntry(data = {}, index) {
  const div = document.createElement('div');
  div.className = 'entry-card';
  div.dataset.type = 'certification';

  div.innerHTML = `
    <div class="entry-header">
      <span class="entry-label">Certification ${index + 1}</span>
      <button class="remove-btn" type="button">Remove</button>
    </div>
    <div class="grid-2">
      <div class="field-group full">
        <label>Certification Name</label>
        <input type="text" name="certName" placeholder="AWS Certified Solutions Architect" value="${esc(data.certName || '')}">
      </div>
      <div class="field-group">
        <label>Certifying Body</label>
        <input type="text" name="issuingOrg" placeholder="Amazon Web Services" value="${esc(data.issuingOrg || '')}">
      </div>
      <div class="field-group">
        <label>Credential ID <span style="color:#334155;font-weight:400;text-transform:none">(optional)</span></label>
        <input type="text" name="credentialId" placeholder="ABC-123456" value="${esc(data.credentialId || '')}">
      </div>
      <div class="field-group">
        <label>Year Obtained</label>
        <select name="issueYear">${yearOptions(data.issueYear)}</select>
      </div>
      <div class="field-group">
        <label>Expiration Year <span style="color:#334155;font-weight:400;text-transform:none">(blank = no expiry)</span></label>
        <select name="expiryYear">${yearOptionsForward(data.expiryYear)}</select>
      </div>
    </div>
  `;

  div.querySelector('.remove-btn').addEventListener('click', () => {
    div.remove();
    renumberEntries('certification-list', 'Certification');
    scheduleAutosave();
  });

  return div;
}

// Year options going forward (for expiry dates)
function yearOptionsForward(selected) {
  const current = new Date().getFullYear();
  let opts = `<option value="">No expiry</option>`;
  for (let y = current; y <= current + 20; y++) {
    opts += `<option value="${y}" ${String(selected) === String(y) ? 'selected' : ''}>${y}</option>`;
  }
  return opts;
}

function renumberEntries(listId, label) {
  document.querySelectorAll(`#${listId} .entry-label`).forEach((el, i) => {
    el.textContent = `${label} ${i + 1}`;
  });
}

// ─── Autosave ─────────────────────────────────────────────────────────────────

let isLoading = false;
let saveTimer = null;

function scheduleAutosave() {
  if (isLoading) return;
  clearTimeout(saveTimer);
  showToast('saving');
  saveTimer = setTimeout(saveAll, 800);
}

// Delegate to the whole page — catches static fields and dynamically added
// education/experience inputs. Programmatic setValue() does not fire these events.
document.querySelector('.page').addEventListener('input', e => {
  if (e.target.type === 'file') return;
  scheduleAutosave();
});
document.querySelector('.page').addEventListener('change', e => {
  if (e.target.type === 'file') return;
  scheduleAutosave();
});

function showToast(state) {
  const toast = document.getElementById('save-toast');
  const text  = document.getElementById('save-toast-text');
  clearTimeout(toast._hideTimer);
  toast.className = `save-toast visible ${state}`;
  text.textContent = state === 'saving' ? '⏳  Saving…' : '✓  Saved';
  if (state === 'saved') {
    toast._hideTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, 2500);
  }
}

// ─── Load ─────────────────────────────────────────────────────────────────────

async function loadData() {
  isLoading = true;
  const { apiKey, profile, resumeFile } = await chrome.storage.local.get(['apiKey', 'profile', 'resumeFile']);
  if (apiKey) document.getElementById('api-key').value = apiKey;
  if (profile) populateFields(profile);
  updateApiStatus(!!apiKey);
  displayStoredResume(resumeFile || null);
  isLoading = false;
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val || '';
}

// ─── Add buttons ──────────────────────────────────────────────────────────────

document.getElementById('add-certification').addEventListener('click', () => {
  const list = document.getElementById('certification-list');
  list.appendChild(createCertificationEntry({}, list.children.length));
  scheduleAutosave();
});

document.getElementById('add-education').addEventListener('click', () => {
  const list = document.getElementById('education-list');
  list.appendChild(createEducationEntry({}, list.children.length));
  scheduleAutosave();
});

document.getElementById('add-experience').addEventListener('click', () => {
  const list = document.getElementById('experience-list');
  list.appendChild(createExperienceEntry({}, list.children.length));
  scheduleAutosave();
});

// ─── Save ─────────────────────────────────────────────────────────────────────

async function saveAll() {
  const apiKey     = document.getElementById('api-key').value.trim();
  const firstName  = document.getElementById('f-first-name').value.trim();
  const lastName   = document.getElementById('f-last-name').value.trim();
  const legalFirst = document.getElementById('f-legal-first-name').value.trim();
  const legalLast  = document.getElementById('f-legal-last-name').value.trim();

  const profile = {
    firstName,
    lastName,
    preferredName:  document.getElementById('f-preferred-name').value.trim(),
    pronouns:       document.getElementById('f-pronouns').value.trim(),
    name:           [firstName, lastName].filter(Boolean).join(' '),
    legalFirstName: legalFirst,
    legalLastName:  legalLast,
    legalName:      [legalFirst, legalLast].filter(Boolean).join(' '),
    email:    document.getElementById('f-email').value.trim(),
    phone:    document.getElementById('f-phone').value.trim(),
    address:  document.getElementById('f-address').value.trim(),
    city:     document.getElementById('f-city').value.trim(),
    state:    document.getElementById('f-state').value.trim(),
    zip:      document.getElementById('f-zip').value.trim(),
    country:  document.getElementById('f-country').value.trim(),
    linkedin: document.getElementById('f-linkedin').value.trim(),
    pay: {
      type:     document.getElementById('f-pay-type').value,
      currency: document.getElementById('f-pay-currency').value,
      min:      document.getElementById('f-pay-min').value.trim(),
      target:   document.getElementById('f-pay-target').value.trim(),
      max:      document.getElementById('f-pay-max').value.trim(),
      openTo:   document.getElementById('f-pay-open-to').value,
    },
    summary:    document.getElementById('f-summary').value.trim(),
    skills:          document.getElementById('f-skills').value.split(',').map(s => s.trim()).filter(Boolean),
    certifications:  readEntries('certification-list'),
    education:       readEntries('education-list'),
    experience:      readEntries('experience-list'),
    eeo: {
      workAuth:          document.getElementById('eeo-work-auth').value,
      sponsorship:       document.getElementById('eeo-sponsorship').value,
      gender:            document.getElementById('eeo-gender').value,
      hispanic:          document.getElementById('eeo-hispanic').value,
      race:              document.getElementById('eeo-race').value,
      sexualOrientation: document.getElementById('eeo-sexual-orientation').value,
      communities:       Array.from(document.querySelectorAll('#eeo-communities input[type="checkbox"]:checked')).map(cb => cb.value),
    },
  };

  if (profile.experience.length > 0) {
    profile.title   = profile.experience[0].title;
    profile.company = profile.experience[0].company;
  }

  const hasContent = Object.values(profile).some(v =>
    Array.isArray(v) ? v.length > 0 : (v || '').length > 0
  );

  const toStore = {};
  if (apiKey) toStore.apiKey = apiKey;
  if (hasContent) toStore.profile = profile;

  try {
    await chrome.storage.local.set(toStore);
    updateApiStatus(!!apiKey);
    showToast('saved');
  } catch (err) {
    showToast('saved');
    console.error('Save error:', err);
  }
}

function readEntries(listId) {
  const cards = document.querySelectorAll(`#${listId} .entry-card`);
  return Array.from(cards).map(card => {
    const get = name => card.querySelector(`[name="${name}"]`)?.value?.trim() || '';
    if (listId === 'education-list') {
      return { school: get('school'), degree: get('degree'), startMonth: get('startMonth'), startYear: get('startYear'), endMonth: get('endMonth'), endYear: get('endYear') };
    } else if (listId === 'certification-list') {
      return { certName: get('certName'), issuingOrg: get('issuingOrg'), credentialId: get('credentialId'), issueYear: get('issueYear'), expiryYear: get('expiryYear') };
    } else {
      return { title: get('title'), company: get('company'), location: get('location'), description: textToDescriptionArray(get('description')), startMonth: get('startMonth'), startYear: get('startYear'), endMonth: get('endMonth'), endYear: get('endYear') };
    }
  }).filter(e => Object.values(e).some(v => v.length > 0));
}

// ─── Clear ────────────────────────────────────────────────────────────────────

document.getElementById('clear-btn').addEventListener('click', async () => {
  if (!confirm('Delete all Profile Vault data? This cannot be undone.')) return;
  await chrome.storage.local.clear();
  location.reload();
});

// ─── API key section toggle ───────────────────────────────────────────────────

document.getElementById('api-toggle').addEventListener('click', () => {
  const body    = document.getElementById('api-body');
  const chevron = document.getElementById('api-chevron');
  const isOpen  = body.classList.toggle('open');
  chevron.classList.toggle('open', isOpen);
});

document.getElementById('toggle-key').addEventListener('click', () => {
  const input = document.getElementById('api-key');
  const btn   = document.getElementById('toggle-key');
  input.type  = input.type === 'password' ? 'text' : 'password';
  btn.textContent = input.type === 'password' ? 'Show' : 'Hide';
});

function updateApiStatus(hasKey) {
  const status = document.getElementById('api-status');
  status.innerHTML = hasKey
    ? '🔑 API Key <span class="api-configured">✓ configured</span>'
    : '🔑 API Key <span style="color:#f97316;font-size:11px">⚠ not set</span>';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Convert a description value (string or array) to bullet-point textarea text
function descriptionToText(desc) {
  if (!desc) return '';
  if (Array.isArray(desc)) {
    return desc.filter(Boolean).map(b => `• ${b.replace(/^[•\-]\s*/, '')}`).join('\n');
  }
  return String(desc);
}

// Convert bullet-point textarea text back to array for storage
function textToDescriptionArray(text) {
  if (!text || !text.trim()) return [];
  return text.split('\n')
    .map(line => line.replace(/^[•\-]\s*/, '').trim())
    .filter(Boolean);
}

loadData();
