// Renders local exchanges into the host page's thread as whole turns, and owns their
// lifecycle. Provider-agnostic: it talks to the adapter interface and never to a selector.
//
// Both halves of the exchange are ours. The send is stopped at the composer, so the host
// page never creates a turn for a local prompt — which is what makes this stable. Nothing
// of ours sits inside a turn the host page owns, so nothing of ours is carried off when
// that turn re-renders, is re-synced from the server, or is unmounted by the virtualiser.
//
// UI state machine:
//   idle → thinking → streaming (appendToken*) → done
//   idle → approval → local → thinking → streaming → done
//   idle → approval → cloud (removed)

(() => {
  const TIMEOUT_MS = 18000;

  // The exchange currently being answered. Null when idle.
  let active = null;

  let sheetLoaded = false;

  // One stylesheet in the light DOM, for the few things that are ours: the "Local" badge,
  // the thinking indicator, the approval prompt. Everything else — typography, code blocks,
  // the user bubble, both themes — comes from the host page's own classes, which is why
  // there is no shadow root and no theme observer. Adopted as a constructable stylesheet
  // attached to the document directly, so nothing depends on the host page's style-src.
  async function ensureStylesheet(adapter) {
    if (sheetLoaded) return;
    sheetLoaded = true;
    const res = await fetch(chrome.runtime.getURL(adapter.getStylesheetPath()));
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(await res.text());
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }

  function getAdapterOrNull() {
    return window.LocalGateProviders.getActiveAdapter();
  }

  // ── Composer lifecycle ────────────────────────────────────────────────
  //
  // The host page's send button doubles as the stop control during a local answer. The
  // hijack/restore pair lives here so provider-DOM lifecycle state stays behind this module.

  let restoreComposer = null;

  function hijackComposer(onStop) {
    releaseComposer();
    const adapter = getAdapterOrNull();
    if (adapter?.hijackComposerButton) {
      restoreComposer = adapter.hijackComposerButton(onStop);
    }
  }

  function releaseComposer() {
    if (!restoreComposer) return;
    restoreComposer();
    restoreComposer = null;
  }

  // Puts a prompt back into the composer. Called on a failed generation: the gate cleared
  // the composer before answering, and the user's prompt must survive the failure.
  function restorePrompt(text) {
    getAdapterOrNull()?.setComposerText?.(text);
  }

  // Scrolling is the host page's job: the cloned turn wrapper carries its scroll-margin
  // classes, so asking the browser to bring the turn into view lands it where a native
  // answer lands — clear of the floating composer, rather than tucked under it.
  function reveal(node) {
    node.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // Appends a turn to the thread. The list is virtualised and re-rendered by the host page,
  // so `place` is also what the restore sweep calls to put a turn back where it belongs.
  function appendTurn(adapter, wrapper) {
    const list = adapter.getTurnList();
    if (!list) return false;
    list.appendChild(wrapper);
    return true;
  }

  // Opens an exchange: our question bubble, then the turn its answer will stream into.
  async function beginExchange(adapter, prompt) {
    await ensureStylesheet(adapter);

    const id = crypto.randomUUID();
    const question = adapter.buildUserTurn(prompt);
    question.dataset.localgateId = id;
    question.dataset.localgateRole = "user";

    const answer = adapter.buildAssistantTurn();
    answer.wrapper.dataset.localgateId = id;
    answer.wrapper.dataset.localgateRole = "assistant";

    if (!appendTurn(adapter, question)) return null;
    appendTurn(adapter, answer.wrapper);
    reveal(question);

    return { id, prompt, question, ...answer };
  }

  function dismiss(choice) {
    if (!active) return;
    if (!active.resolve) {
      const stale = active;
      active = null;
      stale.question.remove();
      stale.wrapper.remove();
      return;
    }
    const { resolve, timer, onKey } = active;
    clearTimeout(timer);
    window.removeEventListener("keydown", onKey);

    if (choice === "local") {
      active = { ...active, resolve: null, timer: null, onKey: null };
      active.prose.replaceChildren();
    } else {
      const stale = active;
      active = null;
      stale.question.remove();
      stale.wrapper.remove();
    }
    resolve(choice);
  }

  // ── Public API ────────────────────────────────────────────────────────

  // Held open until the user chooses. On "cloud" both turns are removed again and the gate
  // releases the prompt to the host page, which then renders the exchange itself.
  async function requestApproval({ prompt, confidence } = {}) {
    dismiss("cloud");

    const adapter = getAdapterOrNull();
    if (!adapter) return "cloud";

    const exchange = await beginExchange(adapter, prompt);
    if (!exchange) return "cloud";

    return new Promise((resolve) => {
      const approvalNode = adapter.buildApprovalNode(confidence);
      const cloudBtn = approvalNode.querySelector(".localgate-btn--ghost");
      const localBtn = approvalNode.querySelector(".localgate-btn--solid");
      cloudBtn.addEventListener("click", () => dismiss("cloud"));
      localBtn.addEventListener("click", () => dismiss("local"));

      exchange.prose.appendChild(approvalNode);
      reveal(exchange.wrapper);

      const onKey = (e) => { if (e.key === "Escape") dismiss("cloud"); };
      window.addEventListener("keydown", onKey);
      const timer = setTimeout(() => dismiss("timeout"), TIMEOUT_MS);

      active = { ...exchange, resolve, timer, onKey };
      localBtn.focus();
    });
  }

  async function showThinking(prompt) {
    const adapter = getAdapterOrNull();
    if (!adapter) return;
    // An approval that was accepted has already built the exchange; anything else starts one.
    if (!active) active = await beginExchange(adapter, prompt);
    if (!active) return;
    active.prose.replaceChildren(adapter.buildThinkingNode());
    reveal(active.wrapper);
  }

  // Ends a generation that failed. Clears `active` — otherwise the turn shows "Thinking…"
  // forever and the next question streams into it — and labels the turn with the error.
  // Partial streamed text is kept; a turn that never streamed shows the error instead.
  function abort(reason) {
    if (!active) return;
    const turn = active;
    active = null;
    if (!turn.streaming) turn.prose.replaceChildren(document.createTextNode(reason));
    getAdapterOrNull()?.markFailed?.(turn.wrapper, "failed");
  }

  // "Try again" re-runs the prompt into the turn that is already on screen, which is what it
  // means natively: a new answer in place of the old one, not a second exchange with the
  // question asked twice. Version navigation between the two is a separate job — the host
  // page's arrows are React state we do not have.
  //
  // Returns null when there is nothing to re-run, so the adapter leaves the button out
  // rather than rendering one that does nothing.
  function regenerator(turn) {
    if (!turn.prompt) return null;
    return () => window.LocalGateRouter?.regenerate(turn.prompt, turn.wrapper);
  }

  // Points the next stream at a turn that has already finished. The generation path then
  // reuses it instead of opening a new exchange, because `showThinking` only builds one when
  // nothing is active.
  function reopen(prompt, wrapper) {
    const adapter = getAdapterOrNull();
    const parts = adapter?.reopenAssistantTurn?.(wrapper);
    if (!parts) return false;
    active = {
      id: wrapper.dataset.localgateId,
      prompt,
      wrapper,
      question: null,
      ...parts,
    };
    return true;
  }

  async function showStreaming() {
    const adapter = getAdapterOrNull();
    if (!adapter || !active) return null;

    const turn = active;
    turn.streaming = true;                 // abort() keeps partial text from here on
    turn.prose.replaceChildren();

    let fullText = "";
    let renderPending = false;
    let settled = false;
    // Which local model answered. Reported by the daemon on the stream rather than known up
    // front, and shown under "Try again" the way the host page shows its own model there.
    let model = null;

    // One exit for every way a stream can end — finished, stopped by the user, or
    // superseded by the next prompt — so a partial answer is always labelled as one and the
    // action row is only ever added once.
    function finalize(wasStopped) {
      const result = { id: turn.id, text: fullText, stopped: wasStopped };
      if (settled) return result;
      settled = true;
      if (wasStopped && adapter.markStopped) adapter.markStopped(turn.wrapper);
      adapter.finalizeStream(turn.prose, turn.slot, fullText, regenerator(turn), model);
      if (active === turn) active = null;
      return result;
    }

    return {
      appendToken(token) {
        fullText += token;
        if (renderPending) return;
        renderPending = true;
        requestAnimationFrame(() => {
          renderPending = false;
          adapter.appendToStream(turn.prose, fullText);
          reveal(turn.wrapper);
        });
      },
      noteModel(name) { model = name ?? model; },
      finish: () => finalize(false),
      stop: () => finalize(true),
    };
  }

  // Rebuilds a finished exchange the host page's thread no longer shows — after a reload,
  // or after the virtualiser unmounted the region it was in. `before` is the node it should
  // precede; null appends.
  async function renderStoredExchange(entry, before) {
    const adapter = getAdapterOrNull();
    if (!adapter) return false;
    const list = adapter.getTurnList();
    if (!list) return false;
    await ensureStylesheet(adapter);

    const question = adapter.buildUserTurn(entry.prompt);
    question.dataset.localgateId = entry.id;
    question.dataset.localgateRole = "user";

    const answer = adapter.buildAssistantTurn();
    answer.wrapper.dataset.localgateId = entry.id;
    answer.wrapper.dataset.localgateRole = "assistant";
    adapter.finalizeStream(
      answer.prose, answer.slot, entry.answer,
      regenerator({ prompt: entry.prompt, wrapper: answer.wrapper }), entry.model
    );

    for (const node of [question, answer.wrapper]) {
      if (before && before.parentElement === list) {
        list.insertBefore(node, before);
      } else {
        list.appendChild(node);
      }
    }
    return true;
  }

  window.LocalGateChatUI = {
    requestApproval,
    showThinking,
    showStreaming,
    abort,
    renderStoredExchange,
    reopen,
    hijackComposer,
    releaseComposer,
    restorePrompt,
  };
})();
