// Detects what the user is typing, so a routing decision is usually ready before they send.
// Submission itself is not handled here — the composer gate owns that, because deciding and
// intercepting have to happen in the same event for the send to be stoppable.

(() => {
  const adapter = window.LocalGateProviders.getActiveAdapter();

  if (!adapter) {
    return;
  }

  let debounceTimer;

  document.addEventListener(
    "input",
    (event) => {
      const promptElement = adapter.getPromptElement();
      if (!promptElement || (promptElement !== event.target && !promptElement.contains(event.target))) {
        return;
      }

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const prompt = adapter.readPromptText(promptElement).trim();
        if (!prompt) return;

        window.LocalGateBus.dispatchEvent(
          new CustomEvent(window.LocalGateEvents.PROMPT_DRAFT_DETECTED, {
            detail: { prompt, provider: adapter.id }
          })
        );
      }, 500);
    },
    true
  );
})();
