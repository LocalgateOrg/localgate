// Provider Registry — manages dynamic resolution of DOM adapters based on the
// current hostname. Every provider adapter must call register() with an object
// implementing the interface below.
//
// Required adapter methods:
//   id: string                            — unique provider key (e.g. "chatgpt")
//   matches(hostname: string): boolean    — true if this adapter owns the page
//   getPromptElement(): Element|null      — the user's text input element
//   readPromptText(el: Element): string   — extracts prompt text from the input
//   getStylesheetPath(): string           — path to the provider's CSS (extension-relative)
//
// Composer gating — a local prompt must never be sent, so the gate needs to recognise a
// submission, undo one, and re-issue one:
//   isSubmitKey(event): boolean           — this keystroke would send
//   isSubmitClick(event): boolean         — this click would send
//   submitNatively(): void                — send, using the host page's own control
//   clearComposer(): void                 — empty the composer as the user would
//   setComposerText(text): void           — write text into the composer as the user would
//
// Conversation identity — provider knowledge of URLs and server turn markup stays here, so
// transcript.js and history-rail.js remain provider-agnostic:
//   getConversationId(): string|null      — server conversation id from the URL, or null
//   getLastServerMessageId(): string|null — newest server-backed message id on screen
//   hasServerTurns(): boolean             — whether the host page has a thread of its own
//   getServerTurnKind(node): "user"|"assistant"|null — kind of host turn a list child holds
//   getHomeUrl(): string                  — path of the provider's landing page
//
// Turn building — a local exchange is rendered as whole turns, siblings of the host page's
// own, never as nodes parked inside one of them:
//   getTurnList(): Element|null           — the list every turn is a sibling in
//   buildUserTurn(text): Element          — the question, as a turn
//   buildAssistantTurn(): {wrapper, prose, slot}
//   appendToStream(prose, text): void     — re-render mid-stream
//   finalizeStream(prose, slot, text): void — final render plus the action row
//   markStopped?(wrapper): void           — label a partial answer as one
//   markFailed?(wrapper, text): void      — label a turn "Local · <text>" after a failure
//   hijackComposerButton?(onStop): () => void
//   buildApprovalNode(confidence?: number): Element
//       — DOM node for the HITL approval prompt. Must contain exactly one
//         .localgate-btn--ghost (cloud) and one .localgate-btn--solid (local)
//         button; chat-ui.js wires click handlers to those class selectors.

window.LocalGateProviders = {
  _adapters: [],

  register(adapter) {
    this._adapters.push(adapter);
  },

  getActiveAdapter() {
    return this._adapters.find((adapter) => adapter.matches(window.location.hostname));
  }
};
