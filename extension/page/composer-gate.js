// Stops every send at the composer, decides the route, then either answers locally or
// hands the prompt straight back to the host page. The single interception point.
//
// A send is stopped here or not at all — never aborted in flight: an aborted send still
// advances nothing (`parent_message_id` stays put), so the next prompt renders as a sibling
// version of the same turn and the optimistic user bubble is dropped on re-sync.
//
// Blocking unconditionally is safe because release() presses the host page's own send
// button, re-issuing the prompt exactly as the host page would have.
//
// Content scripts share the host page's DOM, so a capture-phase listener on `document` runs
// before the host page's own handlers, which are bound below it.

(() => {
  const adapter = window.LocalGateProviders.getActiveAdapter();
  if (!adapter) return;

  // Set while we are re-issuing a send on purpose, so the gate does not catch its own
  // synthetic click and block the prompt forever.
  let releasing = false;
  // One prompt in the gate at a time: Enter and the send button both fire for one send in
  // some paths, and a second decision would answer the same prompt twice.
  let pending = false;

  function release() {
    // The one moment adoption is correct: this send is what makes the host page create the
    // conversation our local turns will belong to. Downstream, a conversation-id change is
    // just a change — nothing there can tell this apart from the user navigating.
    window.LocalGateTranscript?.expectAdoption?.();
    releasing = true;
    try {
      adapter.submitNatively();
    } finally {
      // Cleared on a later task: the host page's click handling runs synchronously, but the
      // listeners we must not re-enter are on the same event.
      setTimeout(() => { releasing = false; }, 0);
    }
  }

  async function gate(event) {
    if (releasing) return;

    // One decision is already in flight; a second Enter must not fall through to the host
    // page unclassified. Dropped, not queued — the first decision owns this prompt.
    if (pending) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    // While a local answer is generating the composer is a stop control, exactly as it is
    // during a cloud answer, so a send must not go anywhere — including to the cloud.
    if (window.LocalGateRouter.isGenerating()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    // The mirror case: while the *host page* is answering, the composer is its stop
    // control. Whatever this event means it is not a send, so it is left alone.
    if (adapter.isHostGenerating()) return;

    const prompt = adapter.readPromptText(adapter.getPromptElement()).trim();
    if (!prompt) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    pending = true;

    try {
      const decision = await window.LocalGateRouter.decide(prompt, adapter.id);

      // The composer can change while the decision is awaited. A decision about text the
      // user has since edited must not act on it: release to cloud and let the next
      // keystroke re-gate whatever is there now.
      const current = adapter.readPromptText(adapter.getPromptElement()).trim();
      if (current !== prompt) {
        release();
        return;
      }

      if (decision.route === "local") {
        adapter.clearComposer();
        await decision.answer();
      } else {
        release();
      }
    } catch {
      release();                       // never strand a prompt in the composer
    } finally {
      pending = false;
    }
  }

  // Synthetic events never gate: the page could fabricate a "send" to probe or bypass the
  // gate. (Our own release() click is additionally covered by the `releasing` flag.)
  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted) return;
    if (!adapter.isSubmitKey(event)) return;
    void gate(event);
  }, true);

  document.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    if (!adapter.isSubmitClick(event)) return;
    void gate(event);
  }, true);
})();
