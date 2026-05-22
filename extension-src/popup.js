const $ = (id) => document.getElementById(id);

const candidateSelect = $('candidateSelect');
const qualitySelect = $('qualitySelect');
const refreshBtn = $('refreshBtn');
const scanBtn = $('scanBtn');
const clearBtn = $('clearBtn');
const downloadBtn = $('downloadBtn');
const filenameInput = $('filenameInput');
const statusEl = $('status');
const barFill = $('barFill');
const candidateHint = $('candidateHint');
const qualityHint = $('qualityHint');
const openSite = $('openSite');

let activeTabId = null;
let activeTabUrl = null;
let currentVariants = [];
let runningJobId = null;

const setStatus = (t, progress = null) => {
  statusEl.textContent = t ?? '';
  if (progress == null) {
    barFill.style.width = '0%';
    return;
  }
  const clamped = Math.max(0, Math.min(1, progress));
  barFill.style.width = `${Math.round(clamped * 100)}%`;
};

const safeName = (s) =>
  (s ?? '')
    .toString()
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '');

const defaultFilename = (tabUrl) => {
  try {
    const u = new URL(tabUrl);
    const host = safeName(u.hostname);
    const stamp = new Date()
      .toISOString()
      .replace(/[:-]/g, '')
      .replace(/\..+$/, '');
    return `${host}_${stamp}.mp4`;
  } catch {
    return `video_${Date.now()}.mp4`;
  }
};

const fetchText = async (u, referer) => {
  const headers = {};
  if (referer) headers['Referer'] = referer;
  const res = await fetch(u, { credentials: 'include', headers });
  if (!res.ok) throw new Error(`Failed to fetch playlist: ${res.status}`);
  return await res.text();
};

const parseMaster = (text, baseUrl) => {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

    const attrsRaw = line.slice(line.indexOf(':') + 1);
    const attrs = {};
    for (const part of attrsRaw.split(',')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      let v = part.slice(idx + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      attrs[k] = v;
    }

    const uri = (lines[i + 1] ?? '').trim();
    if (!uri || uri.startsWith('#')) continue;
    const url = new URL(uri, baseUrl).toString();

    const bandwidth = Number(attrs.BANDWIDTH ?? 0) || null;
    const res = attrs.RESOLUTION ?? '';
    const [w, h] = res.split('x').map((n) => Number(n));

    variants.push({
      url,
      bandwidth,
      width: Number.isFinite(w) ? w : null,
      height: Number.isFinite(h) ? h : null,
      codecs: attrs.CODECS ?? null,
    });
  }

  variants.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
  return variants;
};

const labelVariant = (v, i) => {
  const parts = [];
  if (v.height) parts.push(`${v.height}p`);
  if (v.bandwidth) parts.push(`${Math.round(v.bandwidth / 1000)}kbps`);
  if (!parts.length) parts.push(`Variant ${i + 1}`);
  return parts.join(' · ');
};

const setCandidates = (urls) => {
  candidateSelect.innerHTML = '';
  const list = [...urls];
  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No m3u8 found yet';
    candidateSelect.appendChild(opt);
    candidateSelect.disabled = true;
    candidateHint.textContent = 'Play the video first, then refresh or click “Scan page”.';
    return;
  }

  candidateSelect.disabled = false;
  candidateHint.textContent = `${list.length} candidate${list.length === 1 ? '' : 's'} captured for this tab.`;
  for (const u of list) {
    const opt = document.createElement('option');
    opt.value = u;
    opt.textContent = u.length > 72 ? `${u.slice(0, 34)}…${u.slice(-34)}` : u;
    candidateSelect.appendChild(opt);
  }
};

const setVariants = (variants) => {
  currentVariants = variants;
  qualitySelect.innerHTML = '';
  if (!variants.length) {
    qualitySelect.disabled = true;
    downloadBtn.disabled = true;
    qualityHint.textContent = 'Select a stream to load qualities.';
    return;
  }

  qualitySelect.disabled = false;
  downloadBtn.disabled = false;
  qualityHint.textContent = variants.length === 1 ? 'Single quality playlist.' : `${variants.length} qualities detected.`;
  variants.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = labelVariant(v, i);
    qualitySelect.appendChild(opt);
  });
};

const loadCandidates = async () => {
  if (activeTabId == null) return;
  const res = await chrome.runtime.sendMessage({ type: 'getCandidates', tabId: activeTabId });
  if (!res?.ok) throw new Error(res?.error ?? 'Unable to get candidates.');
  setCandidates(res.urls ?? []);
};

const loadVariantsForSelectedCandidate = async () => {
  setVariants([]);
  const u = candidateSelect.value;
  if (!u) return;

  setStatus('Loading qualities…');
  try {
    const text = await fetchText(u, activeTabUrl);
    const variants = text.includes('#EXT-X-STREAM-INF') ? parseMaster(text, u) : [{ url: u }];
    setVariants(variants);
    setStatus('');
  } catch (e) {
    setStatus(e?.message ?? String(e));
  }
};

const initTab = async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  activeTabId = tab?.id ?? null;
  activeTabUrl = tab?.url ?? null;
  if (activeTabUrl) {
    filenameInput.value = defaultFilename(activeTabUrl);
    openSite.textContent = new URL(activeTabUrl).hostname;
  }
  openSite.onclick = async (e) => {
    e.preventDefault();
    if (activeTabId == null) return;
    await chrome.tabs.update(activeTabId, { active: true });
  };
};

const startDownload = async () => {
  if (runningJobId) return;
  const idx = Number(qualitySelect.value);
  const variant = currentVariants[idx];
  if (!variant?.url) return;

  const filename = safeName(filenameInput.value) || defaultFilename(activeTabUrl);
  downloadBtn.disabled = true;
  scanBtn.disabled = true;
  clearBtn.disabled = true;
  refreshBtn.disabled = true;

  setStatus('Starting…', 0.01);
  const res = await chrome.runtime.sendMessage({
    type: 'startJob',
    m3u8Url: variant.url,
    filename,
    referer: activeTabUrl,
  });

  if (!res?.ok) throw new Error(res?.error ?? 'Unable to start job.');
  runningJobId = res.jobId;
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'jobEvent') return;
  if (runningJobId && msg.jobId !== runningJobId) return;

  if (msg.event === 'progress') {
    setStatus(msg.message ?? 'Working…', msg.progress ?? null);
    return;
  }

  if (msg.event === 'done') {
    setStatus('Saved to Downloads.', 1);
    runningJobId = null;
    downloadBtn.disabled = false;
    scanBtn.disabled = false;
    clearBtn.disabled = false;
    refreshBtn.disabled = false;
    return;
  }

  if (msg.event === 'error') {
    setStatus(msg.message ?? 'Failed.');
    runningJobId = null;
    downloadBtn.disabled = false;
    scanBtn.disabled = false;
    clearBtn.disabled = false;
    refreshBtn.disabled = false;
  }
});

refreshBtn.addEventListener('click', async () => {
  setStatus('');
  await loadCandidates();
  await loadVariantsForSelectedCandidate();
});

scanBtn.addEventListener('click', async () => {
  if (activeTabId == null) return;
  setStatus('Scanning page…');
  const res = await chrome.runtime.sendMessage({ type: 'scanTab', tabId: activeTabId });
  if (!res?.ok) {
    setStatus(res?.error ?? 'Scan failed.');
    return;
  }
  await loadCandidates();
  await loadVariantsForSelectedCandidate();
  setStatus(res.added ? `Added ${res.added} URL(s).` : 'No URLs found in page HTML.');
});

clearBtn.addEventListener('click', async () => {
  if (activeTabId == null) return;
  await chrome.runtime.sendMessage({ type: 'clearCandidates', tabId: activeTabId });
  setStatus('');
  setCandidates([]);
  setVariants([]);
});

candidateSelect.addEventListener('change', loadVariantsForSelectedCandidate);

downloadBtn.addEventListener('click', () => {
  startDownload().catch((e) => {
    setStatus(e?.message ?? String(e));
    downloadBtn.disabled = false;
    scanBtn.disabled = false;
    clearBtn.disabled = false;
    refreshBtn.disabled = false;
    runningJobId = null;
  });
});

await initTab();
await loadCandidates();
await loadVariantsForSelectedCandidate();
