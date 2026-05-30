const tabCandidates = new Map();
let offscreenReady = false;

const normalizeCandidate = (u) => {
  try {
    const url = new URL(u);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
};

const looksLikeM3u8 = (u) => /\.m3u8(\?|$)/i.test(u);

const addCandidate = (tabId, u) => {
  const url = normalizeCandidate(u);
  if (!url) return;
  if (!looksLikeM3u8(url)) return;
  const set = tabCandidates.get(tabId) ?? new Set();
  set.add(url);
  tabCandidates.set(tabId, set);
};

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    addCandidate(details.tabId, details.url);
  },
  { urls: ['<all_urls>'] },
);

chrome.tabs.onRemoved.addListener((tabId) => {
  tabCandidates.delete(tabId);
});

const ensureOffscreen = async () => {
  if (offscreenReady) return;
  if (chrome.offscreen?.hasDocument) {
    const has = await chrome.offscreen.hasDocument();
    if (has) {
      offscreenReady = true;
      return;
    }
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Transcode HLS (m3u8) to MP4 locally.',
  });
  offscreenReady = true;
};

const scanTabForM3u8 = async (tabId) => {
  const [{ result } = { result: [] }] = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const found = new Set();
      const pushFromText = (t) => {
        if (!t) return;
        const re = /https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/gi;
        for (const m of t.matchAll(re)) found.add(m[0]);
        const re2 = /\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/gi;
        for (const m of t.matchAll(re2)) found.add(new URL(m[0], location.href).toString());
      };

      pushFromText(document.documentElement?.innerHTML ?? '');
      for (const s of document.querySelectorAll('script')) pushFromText(s.textContent ?? '');

      return [...found];
    },
  });

  for (const u of result ?? []) addCandidate(tabId, u);
  return (result ?? []).length;
};

let ruleCounter = 1;
const activeRules = new Map();

const setRefererRule = async (targetUrl, referer) => {
  try {
    const host = new URL(targetUrl).hostname;
    if (activeRules.has(host)) return;
    const ruleId = ruleCounter++;
    
    let origin = null;
    try {
      const refUrl = new URL(referer);
      if (refUrl.protocol.startsWith('http')) {
        origin = refUrl.origin;
      }
    } catch {}

    const requestHeaders = [
      { header: 'Referer', operation: 'set', value: referer }
    ];
    if (origin) {
      requestHeaders.push({ header: 'Origin', operation: 'set', value: origin });
    }

    const rule = {
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders
      },
      condition: {
        urlFilter: `||${host}`,
        resourceTypes: ['xmlhttprequest']
      }
    };

    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [rule]
    });
    activeRules.set(host, ruleId);
  } catch (e) {
    console.error('Error setting referer rule:', e);
  }
};

const clearRefererRule = async (targetUrl) => {
  try {
    const host = new URL(targetUrl).hostname;
    const ruleId = activeRules.get(host);
    if (ruleId) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId]
      });
      activeRules.delete(host);
    }
  } catch (e) {
    console.error('Error clearing referer rule:', e);
  }
};

const clearAllSessionRules = async () => {
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ids = rules.map((r) => r.id);
    if (ids.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: ids
      });
    }
    activeRules.clear();
  } catch (e) {
    console.error('Failed to clear session rules:', e);
  }
};

chrome.runtime.onInstalled.addListener(clearAllSessionRules);
chrome.runtime.onStartup.addListener(clearAllSessionRules);
clearAllSessionRules();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'setRefererRule') {
      await setRefererRule(message.targetUrl, message.referer);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'clearRefererRule') {
      await clearRefererRule(message.targetUrl);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'getCandidates') {
      const tabId = message.tabId ?? sender.tab?.id;
      const urls = tabCandidates.get(tabId) ? [...tabCandidates.get(tabId)] : [];
      sendResponse({ ok: true, urls });
      return;
    }

    if (message?.type === 'clearCandidates') {
      const tabId = message.tabId ?? sender.tab?.id;
      tabCandidates.delete(tabId);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'scanTab') {
      const tabId = message.tabId ?? sender.tab?.id;
      if (typeof tabId !== 'number') {
        sendResponse({ ok: false, error: 'No tab.' });
        return;
      }
      const added = await scanTabForM3u8(tabId);
      sendResponse({ ok: true, added });
      return;
    }

    if (message?.type === 'startJob') {
      await ensureOffscreen();
      const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await chrome.runtime.sendMessage({
        type: 'offscreenRunJob',
        jobId,
        m3u8Url: message.m3u8Url,
        filename: message.filename,
        referer: message.referer,
      });
      sendResponse({ ok: true, jobId });
      return;
    }

    if (message?.type === 'bgDownload') {
      try {
        const downloadId = await chrome.downloads.download({
          url: message.url,
          filename: message.filename,
          saveAs: false,
        });
        sendResponse({ ok: true, downloadId });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    if (message?.type === 'jobEvent') {
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message.' });
  })().catch((e) => {
    sendResponse({ ok: false, error: e?.message ?? String(e) });
  });
  return true;
});
