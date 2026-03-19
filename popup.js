// Profile Vault — popup.js

const FIELD_ICONS = {
  email: '✉', phone: '📞', location: '📍',
  linkedin: '🔗', school: '🎓', degree: '📜',
  company: '🏢'
};

let selectedFile = null;

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  const { apiKey, profile } = await chrome.storage.local.get(['apiKey', 'profile']);

  if (!apiKey) {
    document.getElementById('api-warning').style.display = 'block';
  }

  const hasProfile = profile && (profile.name || profile.email || profile.title);
  if (hasProfile) {
    showProfile(profile);
  } else {
    document.getElementById('upload-section').style.display = 'flex';
  }
}

// ─── File handling ────────────────────────────────────────────────────────────

document.getElementById('resume-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) selectFile(file);
});

// Drag-and-drop
const dropZone = document.getElementById('file-drop');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) selectFile(file);
});

function selectFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf', 'txt', 'docx'].includes(ext)) {
    setStatus('Unsupported file type. Use PDF, DOCX, or TXT.', 'error');
    return;
  }
  selectedFile = file;
  document.getElementById('file-name-label').textContent = file.name;
  document.getElementById('file-selected').style.display = 'flex';
  document.getElementById('parse-btn').disabled = false;
  setStatus('', '');
}

document.getElementById('clear-file').addEventListener('click', () => {
  selectedFile = null;
  document.getElementById('resume-file').value = '';
  document.getElementById('file-selected').style.display = 'none';
  document.getElementById('parse-btn').disabled = true;
});

// ─── Parse resume ─────────────────────────────────────────────────────────────

document.getElementById('parse-btn').addEventListener('click', async () => {
  if (!selectedFile) return;

  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    setStatus('Add your Anthropic API key in Options first.', 'error');
    return;
  }

  setStatus('Reading file…', 'loading');
  document.getElementById('parse-btn').disabled = true;

  try {
    const fileData = await readFile(selectedFile);

    // Store raw file for viewing in Options
    const rawAb = await selectedFile.arrayBuffer();
    const raw = arrayBufferToBase64(rawAb);
    if (raw.length < 7_000_000) {
      await chrome.storage.local.set({ resumeFile: {
        name: selectedFile.name, size: selectedFile.size,
        type: selectedFile.type, lastModified: selectedFile.lastModified,
        storedAt: Date.now(), raw
      }});
    }

    setStatus('Parsing resume with Claude…', 'loading');

    const profile = await chrome.runtime.sendMessage({
      action: 'parseResume',
      fileData: fileData.data,
      fileType: fileData.type,
      fileName: selectedFile.name
    });

    if (profile.error) {
      setStatus(profile.error, 'error');
      document.getElementById('parse-btn').disabled = false;
      return;
    }

    await chrome.storage.local.set({ profile });
    showProfile(profile);
    setStatus('Profile saved!', 'success');
    setTimeout(() => setStatus('', ''), 3000);
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
    document.getElementById('parse-btn').disabled = false;
  }
});

async function readFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext === 'txt') {
    const text = await file.text();
    return { type: 'text', data: text };
  }

  if (ext === 'pdf') {
    const arrayBuffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);
    return { type: 'pdf', data: base64 };
  }

  if (ext === 'docx') {
    const arrayBuffer = await file.arrayBuffer();
    const text = await extractDocxText(arrayBuffer);
    return { type: 'text', data: text };
  }

  throw new Error('Unsupported file type');
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Minimal DOCX text extractor using browser DecompressionStream
async function extractDocxText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  // Find End of Central Directory record
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Invalid DOCX file (not a ZIP)');

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdSize   = view.getUint32(eocdOffset + 12, true);

  // Parse central directory to find word/document.xml
  let pos = cdOffset;
  while (pos < cdOffset + cdSize) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;

    const compression      = view.getUint16(pos + 10, true);
    const compressedSize   = view.getUint32(pos + 20, true);
    const fileNameLength   = view.getUint16(pos + 28, true);
    const extraLength      = view.getUint16(pos + 30, true);
    const commentLength    = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const fileName = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + fileNameLength));

    if (fileName === 'word/document.xml') {
      // Read local file header to find data start
      const localFNLen    = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataOffset    = localHeaderOffset + 30 + localFNLen + localExtraLen;
      const compressed    = bytes.slice(dataOffset, dataOffset + compressedSize);

      let xmlBytes;
      if (compression === 0) {
        xmlBytes = compressed;
      } else if (compression === 8) {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        writer.write(compressed);
        writer.close();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        xmlBytes = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { xmlBytes.set(c, off); off += c.length; }
      } else {
        throw new Error('Unsupported DOCX compression method: ' + compression);
      }

      const xml = new TextDecoder('utf-8').decode(xmlBytes);
      const matches = xml.match(/<w:t[^>]*>([^<]+)<\/w:t>/g) || [];
      return matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ');
    }

    pos += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error('Could not read document content from DOCX');
}

// ─── Profile display ──────────────────────────────────────────────────────────

function showProfile(profile) {
  document.getElementById('upload-section').style.display = 'none';
  document.getElementById('profile-section').style.display = 'flex';

  const card = document.getElementById('profile-card');
  const details = [];

  if (profile.email)    details.push({ icon: FIELD_ICONS.email,    val: profile.email });
  if (profile.phone)    details.push({ icon: FIELD_ICONS.phone,    val: profile.phone });
  if (profile.location) details.push({ icon: FIELD_ICONS.location, val: profile.location });
  if (profile.company)  details.push({ icon: FIELD_ICONS.company,  val: profile.company });
  if (profile.linkedin) details.push({ icon: FIELD_ICONS.linkedin, val: profile.linkedin });
  if (profile.school)   details.push({ icon: FIELD_ICONS.school,   val: profile.school });

  const skills = Array.isArray(profile.skills) ? profile.skills : [];
  const shownSkills = skills.slice(0, 5);
  const extra = skills.length - shownSkills.length;

  card.innerHTML = `
    <div class="profile-name">${esc(profile.name || 'No name found')}</div>
    <div class="profile-title">${esc(profile.title || '')}</div>
    <div class="profile-details">
      ${details.map(d => `
        <div class="profile-detail">
          <span class="icon">${d.icon}</span>
          <span title="${esc(d.val)}">${esc(d.val)}</span>
        </div>`).join('')}
    </div>
    ${shownSkills.length ? `
    <div class="skills-preview">
      ${shownSkills.map(s => `<span class="skill-tag">${esc(s)}</span>`).join('')}
      ${extra > 0 ? `<span class="more-skills">+${extra} more</span>` : ''}
    </div>` : ''}
  `;
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Fill This Page ───────────────────────────────────────────────────────────

document.getElementById('fill-btn').addEventListener('click', async () => {
  const { apiKey, profile } = await chrome.storage.local.get(['apiKey', 'profile']);

  if (!apiKey) { setStatus('Add your API key in Options first.', 'error'); return; }
  if (!profile) { setStatus('No profile found. Parse a resume first.', 'error'); return; }

  setStatus('Scanning page for form fields…', 'loading');
  document.getElementById('fill-btn').disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({ action: 'fillPage' });

    if (result.error) {
      setStatus(result.error, 'error');
    } else {
      setStatus(`Filled ${result.filled} field${result.filled !== 1 ? 's' : ''}!`, 'success');
      setTimeout(() => setStatus('', ''), 4000);
    }
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
  } finally {
    document.getElementById('fill-btn').disabled = false;
  }
});

// ─── Replace resume ───────────────────────────────────────────────────────────

document.getElementById('replace-btn').addEventListener('click', () => {
  document.getElementById('profile-section').style.display = 'none';
  document.getElementById('upload-section').style.display = 'flex';
  selectedFile = null;
  document.getElementById('resume-file').value = '';
  document.getElementById('file-selected').style.display = 'none';
  document.getElementById('parse-btn').disabled = true;
  setStatus('', '');
});

// ─── Options buttons ──────────────────────────────────────────────────────────

document.getElementById('options-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('go-options')?.addEventListener('click', () => chrome.runtime.openOptionsPage());

// ─── Status helper ────────────────────────────────────────────────────────────

function setStatus(msg, type) {
  const el = document.getElementById('status');
  if (!msg) {
    el.style.display = 'none';
    el.className = '';
    return;
  }
  el.className = type || '';
  el.style.display = 'flex';
  el.innerHTML = type === 'loading'
    ? `<div class="spinner"></div><span>${msg}</span>`
    : `<span>${msg}</span>`;
}

init();
