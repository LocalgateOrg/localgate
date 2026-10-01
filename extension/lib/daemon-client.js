// Client interface to the LocalGate daemon.
// All HTTP is proxied through the background service worker because content
// scripts can't reach localhost (Private Network Access). Content code names an
// endpoint; the worker owns the endpoint→URL mapping and the daemon base URL.
//
// Two transport modes:
//   - request/response: chrome.runtime.sendMessage (classify, feedback)
//   - streaming: chrome.runtime.connect port (streaming generate)

(() => {
  async function daemonRequest(endpoint, body) {
    const result = await chrome.runtime.sendMessage({
      type: "localgate:daemon-request",
      endpoint,
      body,
    });
    if (result?._error) throw new Error(result._error);
    return result;
  }

  window.LocalGateDaemon = {
    async classify(prompt, provider, mode, requestId) {
      if (mode === "passthrough") {
        return { route: "cloud" };
      }

      try {
        return await daemonRequest("classify", {
          prompt,
          request_id: requestId,
          metadata: { provider, mode },
        });
      } catch (error) {
        console.error("[LocalGate] Classification error:", error);
        chrome.runtime.sendMessage({ type: "localgate:classify-error" });
        return { route: "cloud" };
      }
    },

    generateStream(prompt, requestId, { onToken, onDone, onError }) {
      const port = chrome.runtime.connect({ name: "localgate:stream" });

      // A stream can end without the [DONE] sentinel — daemon crash, service-worker death —
      // and the port just closes. Anything unsettled at disconnect must surface as an
      // error, or the caller waits forever on a stream that has already ended.
      let settled = false;

      port.onMessage.addListener((msg) => {
        if (msg._error) {
          settled = true;
          onError(new Error(msg._error));
          return;
        }
        if (msg._done) {
          settled = true;
          onDone();
          return;
        }
        if (msg._chunk) {
          try {
            onToken(JSON.parse(msg._chunk));
          } catch {}
        }
      });

      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        onError(new Error(chrome.runtime.lastError?.message || "stream ended"));
      });

      port.postMessage({
        endpoint: "generate",
        body: { prompt, stream: true, request_id: requestId },
      });

      return () => {
        settled = true;              // a deliberate cancel is not an error
        try { port.disconnect(); } catch {}
      };
    },

    async feedback(payload) {
      try {
        await daemonRequest("feedback", payload);
      } catch {
        // Telemetry is non-critical.
      }
    }
  };
})();
