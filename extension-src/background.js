let offscreenPromise = null;

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

const addCandidate = async (tabId, u) => {
  const url = normalizeCandidate(u);
  if (!url) return;
  if (!looksLikeM3u8(url)) return;
  
  const { tabCandidates = {} } = await chrome.storage.session.get('tabCandidates');
  const set = new Set(tabCandidates[tabId] || []);
  set.add(url);
  tabCandidates[tabId] = [...set];
  await chrome.storage.session.set({ tabCandidates });
};

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    addCandidate(details.tabId, details.url);
  },
  { urls: ['<all_urls>'] },
);

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { tabCandidates = {} } = await chrome.storage.session.get('tabCandidates');
  if (tabCandidates[tabId]) {
    delete tabCandidates[tabId];
    await chrome.storage.session.set({ tabCandidates });
  }
});

const ensureOffscreen = async () => {
  if (offscreenPromise) return offscreenPromise;
  offscreenPromise = (async () => {
    const has = await chrome.offscreen.hasDocument();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Transcode HLS (m3u8) to MP4 locally.',
      });
    }
  })();
  try {
    await offscreenPromise;
  } finally {
    offscreenPromise = null;
  }
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

  for (const u of result ?? []) await addCandidate(tabId, u);
  return (result ?? []).length;
};

const setRefererRule = async (targetUrl, referer) => {
  try {
    const host = new URL(targetUrl).hostname;
    
    const { activeRules = {}, ruleCounter = 1 } = await chrome.storage.session.get(['activeRules', 'ruleCounter']);
    if (activeRules[host]) return;
    
    const ruleId = ruleCounter;
    
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

    const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
    const responseHeaders = [
      { header: 'Access-Control-Allow-Origin', operation: 'set', value: extensionOrigin },
      { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, POST, OPTIONS' },
      { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
      { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' }
    ];

    const rule = {
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders,
        responseHeaders
      },
      condition: {
        urlFilter: `||${host}`,
        resourceTypes: ['xmlhttprequest']
      }
    };

    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [rule]
    });
    
    activeRules[host] = ruleId;
    await chrome.storage.session.set({ activeRules, ruleCounter: ruleId + 1 });
  } catch (e) {
    console.error('Error setting referer rule:', e);
  }
};

const clearRefererRule = async (targetUrl) => {
  try {
    const host = new URL(targetUrl).hostname;
    const { activeRules = {} } = await chrome.storage.session.get('activeRules');
    
    const ruleId = activeRules[host];
    if (ruleId) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [ruleId]
      });
      delete activeRules[host];
      await chrome.storage.session.set({ activeRules });
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
    await chrome.storage.session.set({ activeRules: {}, ruleCounter: 1 });
  } catch (e) {
    console.error('Failed to clear session rules:', e);
  }
};

chrome.runtime.onInstalled.addListener(clearAllSessionRules);
chrome.runtime.onStartup.addListener(clearAllSessionRules);

chrome.downloads.onChanged.addListener(async (delta) => {
  const { activeDownloadId } = await chrome.storage.session.get('activeDownloadId');
  if (activeDownloadId && delta.id === activeDownloadId && delta.state) {
    if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
      chrome.offscreen.closeDocument().catch(() => {});
      await chrome.storage.session.remove(['activeJobId', 'activeJobProgress', 'activeDownloadId']);
    }
  }
});

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
      const { tabCandidates = {} } = await chrome.storage.session.get('tabCandidates');
      const urls = tabCandidates[tabId] || [];
      sendResponse({ ok: true, urls });
      return;
    }

    if (message?.type === 'clearCandidates') {
      const tabId = message.tabId ?? sender.tab?.id;
      const { tabCandidates = {} } = await chrome.storage.session.get('tabCandidates');
      if (tabCandidates[tabId]) {
        delete tabCandidates[tabId];
        await chrome.storage.session.set({ tabCandidates });
      }
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
      const { activeJobId } = await chrome.storage.session.get('activeJobId');
      if (activeJobId) {
        sendResponse({ ok: false, error: 'A job is already running.' });
        return;
      }
      await ensureOffscreen();
      const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const activeJobProgress = { event: 'progress', message: 'Starting…', progress: 0.01 };
      
      await chrome.storage.session.set({ activeJobId: jobId, activeJobProgress });
      
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

    if (message?.type === 'getJobState') {
      const { activeJobId, activeJobProgress } = await chrome.storage.session.get(['activeJobId', 'activeJobProgress']);
      sendResponse({ ok: true, jobId: activeJobId, progress: activeJobProgress });
      return;
    }

    if (message?.type === 'bgDownload') {
      try {
        const downloadId = await chrome.downloads.download({
          url: message.url,
          filename: message.filename,
          saveAs: false,
        });
        await chrome.storage.session.set({ activeDownloadId: downloadId });
        sendResponse({ ok: true, downloadId });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message ?? String(e) });
      }
      return;
    }

    if (message?.type === 'jobEvent') {
      const { activeJobId } = await chrome.storage.session.get('activeJobId');
      if (message.jobId === activeJobId) {
        await chrome.storage.session.set({ activeJobProgress: message });
        
        if (message.event === 'error') {
          chrome.offscreen.closeDocument().catch(() => {});
          await chrome.storage.session.remove(['activeJobId', 'activeJobProgress', 'activeDownloadId']);
        }
      }
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message.' });
  })().catch((e) => {
    sendResponse({ ok: false, error: e?.message ?? String(e) });
  });
  return true;
});
