// MV3 service worker. Proxies daemon HTTP requests (content scripts can't
// reach localhost due to Private Network Access restrictions) and manages
// toolbar badge state. Supports both request/response (classify, feedback)
// and streaming (generate) via ports.

const DEFAULT_SETTINGS = {
  mode: "transparent",
  daemonBaseUrl: "http://127.0.0.1:8400"
};

// The worker owns the endpoint map: content scripts name an endpoint, never a URL, so a
// compromised page cannot steer the proxy at an arbitrary host. Classify sits between
// preventDefault and the routing decision, so it gets a short timeout — a hung daemon must
// not hold the Enter key. Generate streams are long-lived and get none.
const ENDPOINTS = {
  classify: { path: "/classify", timeoutMs: 1500 },
  feedback: { path: "/feedback", timeoutMs: 1500 },
  generate: { path: "/generate", timeoutMs: 0 },
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...existing });
});

async function daemonBaseUrl() {
  const { daemonBaseUrl } = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return daemonBaseUrl;
}

function showBadge(text, color, tabId) {
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "", tabId });
  }, 4000);
}

// ── Request/response proxy (classify, feedback) ─────────────────────

async function daemonFetch(endpoint, body) {
  const spec = ENDPOINTS[endpoint];
  if (!spec) throw new Error(`unknown endpoint: ${endpoint}`);
  const response = await fetch(`${await daemonBaseUrl()}${spec.path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: spec.timeoutMs ? AbortSignal.timeout(spec.timeoutMs) : undefined,
  });
  // An error body must not be cached as a decision.
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "localgate:daemon-request") {
    daemonFetch(message.endpoint, message.body)
      .then(sendResponse)
      .catch((err) => sendResponse({ _error: err.message }));
    return true;
  }

  if (message?.type === "localgate:classify-error") {
    showBadge("!", "#c62828", sender.tab?.id);
  }

  return false;
});

// ── Streaming proxy (generate with stream=true) ─────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "localgate:stream") return;

  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  port.onMessage.addListener(async (msg) => {
    try {
      const spec = ENDPOINTS[msg.endpoint];
      if (!spec) throw new Error(`unknown endpoint: ${msg.endpoint}`);
      const response = await fetch(`${await daemonBaseUrl()}${spec.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        port.postMessage({ _error: `HTTP ${response.status}` });
        port.disconnect();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            port.postMessage({ _done: true });
          } else {
            port.postMessage({ _chunk: data });
          }
        }
      }

      port.disconnect();
    } catch (err) {
      if (err.name !== "AbortError") {
        try { port.postMessage({ _error: err.message }); } catch {}
      }
      try { port.disconnect(); } catch {}
    }
  });
});
