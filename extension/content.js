// Content script — the "brain". Pre-classifies prompts while the user types, answers the
// composer gate's routing question, and drives local generation. Runs in the ISOLATED world.

(() => {
  // Submit-time ceiling on the routing decision. A daemon that hangs past it is the
  // ambiguous case, and ambiguous routes cloud — the Enter key must never depend on it.
  const DECIDE_TIMEOUT_MS = 2000;
  // Ceiling on silence between stream chunks. Generous — local models can think — but a
  // stream this quiet is dead, and an unsettled stream would swallow every later send.
  const STREAM_IDLE_MS = 120000;

  // The service worker seeds settings into storage; awaited before the first routing
  // decision so a saved "passthrough" cannot be violated during the startup tick.
  const settings = { mode: "transparent" };
  const settingsReady = chrome.storage.local.get("mode").then((stored) => {
    if (stored.mode) settings.mode = stored.mode;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.mode) settings.mode = changes.mode.newValue;
  });

  let currentDraftDecision = { route: "cloud", prompt: "" };

  const HITL_TELEMETRY = {
    local: "approved_local",
    cloud: "overrode_cloud",
    timeout: "timeout_cloud",
  };

  // Active stream cancel function, the UI controller rendering its output, and the resolver
  // for the generation currently in flight.
  let cancelStream = null;
  let activeController = null;
  let finishGeneration = null;

  // Ends whatever is generating now. Reached two ways: the user pressing the composer
  // button, which we have put into its stop state and whose click routes here, or a new
  // prompt superseding this one.
  function stopLocalGeneration() {
    if (cancelStream) {
      cancelStream();
      cancelStream = null;
    }
    if (activeController) {
      activeController.stop();
      activeController = null;
    }
    // Disconnecting the port fires neither onDone nor onError, so nothing else would ever
    // settle this generation — and the composer button would stay stuck showing a stop
    // control for a stream that has already ended.
    window.LocalGateChatUI.releaseComposer();
    if (finishGeneration) {
      const settle = finishGeneration;
      finishGeneration = null;
      settle();
    }
  }

  // Classification is debounced while typing, so a prompt sent inside that window has never
  // been classified. Classify inline in that case; on a warm classifier it costs a few ms,
  // and the gate is holding the send until this returns.
  async function classify(prompt, provider) {
    if (prompt === currentDraftDecision.prompt) return currentDraftDecision;
    // One request_id per classified send, carried through generate and feedback so the
    // daemon can join the three events.
    const requestId = crypto.randomUUID();
    const result = await window.LocalGateDaemon.classify(
      prompt, provider, settings.mode, requestId
    );
    currentDraftDecision = { ...result, prompt, provider, requestId };
    return currentDraftDecision;
  }

  // Answers the composer gate. Returns the route and, for a local route, the work to do —
  // the gate clears the composer before calling it, so the page looks exactly as it does
  // after a normal send.
  async function decide(prompt, provider) {
    await settingsReady;

    let decision;
    try {
      decision = await Promise.race([
        classify(prompt, provider),
        new Promise((resolve) =>
          setTimeout(() => resolve({ route: "cloud" }), DECIDE_TIMEOUT_MS)
        ),
      ]);
    } catch {
      return { route: "cloud" };       // no daemon, no interception
    }

    if (decision.route !== "local") return { route: "cloud" };

    if (settings.mode === "hitl") {
      let choice = "cloud";
      try {
        choice = await window.LocalGateChatUI.requestApproval({
          prompt,
          confidence: decision.confidence,
        });
      } catch {
        choice = "cloud";
      }

      void window.LocalGateDaemon.feedback({
        decision: HITL_TELEMETRY[choice],
        provider,
        reason: decision.reason,
        confidence: decision.confidence,
        request_id: decision.requestId,
      });

      if (choice !== "local") return { route: "cloud" };
    }

    return {
      route: "local",
      answer: () => runLocalGenerationAndRelease(prompt, decision.requestId),
    };
  }

  // True from the moment a local route is settled until its answer finishes or is stopped —
  // not just while a stream is open. The composer is a stop control for that whole window,
  // so the gate must refuse to send anything during it, cloud included.
  let generating = false;

  async function runLocalGenerationAndRelease(prompt, requestId) {
    generating = true;
    try {
      await runLocalGeneration(prompt, requestId);
    } finally {
      generating = false;
      window.LocalGateChatUI.releaseComposer();
    }
  }

  async function runLocalGeneration(prompt, requestId) {
    if (!prompt) return;

    // A new prompt supersedes whatever is still running. The composer stays live during a
    // local answer, so this is reachable simply by sending again — the partial answer is
    // kept and labelled rather than left looking finished.
    stopLocalGeneration();

    // The host page's send button is the control the user reaches for to interrupt, so it
    // is put into its stop state for the duration and its click routed here.
    window.LocalGateChatUI.hijackComposer(stopLocalGeneration);

    await window.LocalGateChatUI.showThinking(prompt);

    return new Promise((resolve) => {
      finishGeneration = resolve;
      let controller = null;
      let firstToken = true;
      let model = null;
      let watchdog = null;

      // False once this generation was stopped or superseded; late callbacks then no-op.
      const isCurrent = () => finishGeneration === resolve;

      const armWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => fail("local model stopped responding"), STREAM_IDLE_MS);
      };

      // A failed generation degrades instead of dead-ending: the turn is labelled with the
      // error, the prompt goes back into the composer, and the next send re-gates.
      function fail(message) {
        if (!isCurrent()) return;
        finishGeneration = null;
        clearTimeout(watchdog);
        if (cancelStream) {
          cancelStream();
          cancelStream = null;
        }
        activeController = null;
        window.LocalGateChatUI.abort(message);
        window.LocalGateChatUI.restorePrompt(prompt);
        resolve();
      }

      armWatchdog();

      cancelStream = window.LocalGateDaemon.generateStream(prompt, requestId, {
        async onToken(chunk) {
          if (!isCurrent()) return;
          if (chunk.error) {
            fail(String(chunk.error));
            return;
          }
          armWatchdog();
          if (chunk.model) model = chunk.model;
          if (firstToken) {
            firstToken = false;
            controller = await window.LocalGateChatUI.showStreaming();
            activeController = controller;
          }
          if (controller && model) controller.noteModel(model);
          if (controller && chunk.token) {
            controller.appendToken(chunk.token);
          }
        },
        onDone() {
          if (!isCurrent()) return;
          // A stream that ends without ever streaming is a failure, not an empty answer.
          if (!controller) {
            fail("empty response");
            return;
          }
          finishGeneration = null;
          clearTimeout(watchdog);
          // Keep the finished exchange: the thread is virtualised, so scrolling away from
          // a local turn is enough for the host page to drop it.
          const done = controller.finish();
          if (done && done.text) {
            void window.LocalGateTranscript.record(prompt, done.text, done.id, model);
          }
          cancelStream = null;
          activeController = null;
          resolve();
        },
        onError(error) {
          fail(error?.message || "generation failed");
        },
      });
    });
  }

  // Debounced pre-classification while typing, so the gate usually has its answer already.
  window.LocalGateBus.addEventListener(
    window.LocalGateEvents.PROMPT_DRAFT_DETECTED,
    async (event) => {
      await settingsReady;
      const { prompt, provider } = event.detail;
      try {
        await classify(prompt, provider);
      } catch {
        // Pre-classification is best-effort; the gate classifies inline on send.
      }
    }
  );

  // "Try again" on a local answer. The prompt is re-run into the turn already on screen, so
  // the classifier is not consulted again: the route was decided when the question was
  // asked, and re-deciding it could quietly answer the same question from the other side.
  // The re-run is a new send, so it gets a request_id of its own.
  async function regenerate(prompt, wrapper) {
    if (generating) return;
    if (!window.LocalGateChatUI.reopen(prompt, wrapper)) return;
    await runLocalGenerationAndRelease(prompt, crypto.randomUUID());
  }

  window.LocalGateRouter = {
    decide,
    regenerate,
    isGenerating: () => generating,
  };
})();
