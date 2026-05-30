import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

const ffmpeg = new FFmpeg();
let ffmpegLoaded = false;

const coreURL = chrome.runtime.getURL(__FFMPEG_CORE_URL__);
const wasmURL = chrome.runtime.getURL(__FFMPEG_WASM_URL__);
const workerFilename = __FFMPEG_WORKER_FILENAME__ || '';
const workerURL = workerFilename ? chrome.runtime.getURL(`vendor/${workerFilename}`) : undefined;

const sendEvent = (jobId, payload) => {
  chrome.runtime.sendMessage({
    type: 'jobEvent',
    jobId,
    ...payload,
  });
};

const ensureFfmpeg = async (jobId) => {
  if (ffmpegLoaded) return;
  sendEvent(jobId, { event: 'progress', message: 'Loading ffmpeg.wasm…', progress: 0.02 });
  await ffmpeg.load(workerURL ? { coreURL, wasmURL, workerURL } : { coreURL, wasmURL });
  ffmpegLoaded = true;
};

const fetchText = async (u, referer) => {
  if (referer) {
    await chrome.runtime.sendMessage({ type: 'setRefererRule', targetUrl: u, referer });
  }
  try {
    const res = await fetch(u, { credentials: 'include' });
    if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
    return await res.text();
  } finally {
    if (referer) {
      await chrome.runtime.sendMessage({ type: 'clearRefererRule', targetUrl: u });
    }
  }
};

const parseMediaPlaylist = (text, baseUrl) => {
  const lines = text.split(/\r?\n/);
  const items = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    items.push(new URL(line, baseUrl).toString());
  }
  return items;
};

const rewriteKeyLine = async (line, baseUrl, keyIndex, referer) => {
  const m = line.match(/URI="([^"]+)"/);
  if (!m) return { line, wroteKey: false };
  const keyUrl = new URL(m[1], baseUrl).toString();
  const keyName = `key_${String(keyIndex).padStart(3, '0')}.bin`;
  if (referer) {
    await chrome.runtime.sendMessage({ type: 'setRefererRule', targetUrl: keyUrl, referer });
  }
  try {
    const res = await fetch(keyUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`Failed to fetch key: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    await ffmpeg.writeFile(keyName, buf);
  } finally {
    if (referer) {
      await chrome.runtime.sendMessage({ type: 'clearRefererRule', targetUrl: keyUrl });
    }
  }
  const rewritten = line.replace(/URI="([^"]+)"/, `URI="${keyName}"`);
  return { line: rewritten, wroteKey: true };
};

const rewriteMapLine = async (line, baseUrl, mapIndex, referer) => {
  const m = line.match(/URI="([^"]+)"/);
  if (!m) return { line, wroteMap: false };
  const mapUrl = new URL(m[1], baseUrl).toString();
  const mapName = `map_${String(mapIndex).padStart(3, '0')}.mp4`;
  if (referer) {
    await chrome.runtime.sendMessage({ type: 'setRefererRule', targetUrl: mapUrl, referer });
  }
  try {
    const res = await fetch(mapUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`Failed to fetch map segment: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    await ffmpeg.writeFile(mapName, buf);
  } finally {
    if (referer) {
      await chrome.runtime.sendMessage({ type: 'clearRefererRule', targetUrl: mapUrl });
    }
  }
  const rewritten = line.replace(/URI="([^"]+)"/, `URI="${mapName}"`);
  return { line: rewritten, wroteMap: true };
};

const buildLocalPlaylist = async (playlistUrl, referer, jobId) => {
  const original = await fetchText(playlistUrl, referer);
  if (original.includes('#EXT-X-STREAM-INF')) {
    throw new Error('Master playlist passed to converter. Pick a quality variant instead.');
  }

  const lines = original.split(/\r?\n/);
  const outLines = [];
  let segIndex = 0;
  let keyIndex = 0;
  let mapIndex = 0;
  let lastEndByte = 0;
  let currentByteRange = null;

  const mediaUrls = parseMediaPlaylist(original, playlistUrl);
  const totalSegs = mediaUrls.length || 1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      outLines.push('');
      continue;
    }

    if (line.startsWith('#EXT-X-KEY')) {
      const r = await rewriteKeyLine(raw, playlistUrl, keyIndex, referer);
      if (r.wroteKey) keyIndex += 1;
      outLines.push(r.line);
      continue;
    }

    if (line.startsWith('#EXT-X-MAP')) {
      const r = await rewriteMapLine(raw, playlistUrl, mapIndex, referer);
      if (r.wroteMap) mapIndex += 1;
      outLines.push(r.line);
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE')) {
      const val = line.slice(line.indexOf(':') + 1).trim();
      const parts = val.split('@');
      const length = Number(parts[0]);
      const offset = parts[1] ? Number(parts[1]) : lastEndByte;
      currentByteRange = { offset, length };
      lastEndByte = offset + length;
      // Omit #EXT-X-BYTERANGE from local manifest as segments are saved as separate whole files
      continue;
    }

    if (line.startsWith('#')) {
      outLines.push(raw);
      continue;
    }

    const abs = new URL(line, playlistUrl).toString();
    const ext = (() => {
      try {
        const u = new URL(abs);
        const p = u.pathname.split('/').pop() || '';
        const dot = p.lastIndexOf('.');
        const e = dot >= 0 ? p.slice(dot + 1) : '';
        return e && e.length <= 6 ? e : 'ts';
      } catch {
        return 'ts';
      }
    })();
    const local = `seg_${String(segIndex).padStart(6, '0')}.${ext}`;

    sendEvent(jobId, {
      event: 'progress',
      message: `Downloading segments… (${segIndex + 1}/${totalSegs})`,
      progress: 0.06 + 0.64 * (segIndex / totalSegs),
    });

    if (referer) {
      await chrome.runtime.sendMessage({ type: 'setRefererRule', targetUrl: abs, referer });
    }
    try {
      const headers = {};
      if (currentByteRange) {
        headers['Range'] = `bytes=${currentByteRange.offset}-${currentByteRange.offset + currentByteRange.length - 1}`;
        currentByteRange = null;
      }
      const res = await fetch(abs, { credentials: 'include', headers });
      if (!res.ok) throw new Error(`Failed segment ${segIndex + 1}: ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      await ffmpeg.writeFile(local, buf);
    } finally {
      if (referer) {
        await chrome.runtime.sendMessage({ type: 'clearRefererRule', targetUrl: abs });
      }
    }
    outLines.push(local);
    segIndex += 1;
  }

  await ffmpeg.writeFile('local.m3u8', new TextEncoder().encode(outLines.join('\n')));
  return { segCount: segIndex };
};

const runFfmpeg = async (jobId, filename) => {
  const outName = filename.toLowerCase().endsWith('.mp4') ? filename : `${filename}.mp4`;
  sendEvent(jobId, { event: 'progress', message: 'Muxing MP4…', progress: 0.74 });
  await ffmpeg.exec(['-i', 'local.m3u8', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', 'out.mp4']);
  sendEvent(jobId, { event: 'progress', message: 'Preparing download…', progress: 0.92 });
  const data = await ffmpeg.readFile('out.mp4');
  const blob = new Blob([data.buffer], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  const res = await chrome.runtime.sendMessage({ type: 'bgDownload', url: blobUrl, filename: outName });
  if (!res?.ok) throw new Error(res?.error ?? 'Download failed.');
  setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60_000);
};

const cleanup = async () => {
  const entries = await ffmpeg.listDir('.');
  await Promise.all(
    entries
      .filter((e) => e.isFile)
      .map((e) => ffmpeg.deleteFile(e.name).catch(() => {})),
  );
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type !== 'offscreenRunJob') return;
    const { jobId, m3u8Url, filename, referer } = msg;
    sendResponse({ ok: true });

    try {
      await ensureFfmpeg(jobId);
      await cleanup();

      sendEvent(jobId, { event: 'progress', message: 'Fetching playlist…', progress: 0.04 });
      const { segCount } = await buildLocalPlaylist(m3u8Url, referer, jobId);
      if (!segCount) throw new Error('No segments found in playlist.');

      await runFfmpeg(jobId, filename);
      await cleanup();

      sendEvent(jobId, { event: 'done' });
    } catch (e) {
      await cleanup().catch(() => {});
      sendEvent(jobId, { event: 'error', message: e?.message ?? String(e) });
    }
  })();
  return true;
});
