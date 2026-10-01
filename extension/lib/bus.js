// Internal event bus for the isolated world. A private EventTarget, never window events or
// postMessage: nothing dispatched here is visible to the host page.

window.LocalGateBus = new EventTarget();

window.LocalGateEvents = {
  PROMPT_DRAFT_DETECTED: "localgate:prompt-draft-detected",
  CLASSIFY_RESULT: "localgate:classify-result"
};
