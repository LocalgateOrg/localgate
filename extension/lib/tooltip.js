// Tooltip engine, generic across controls: driven by each control's own `aria-label`, so
// the text is already localised and right per button — no string table. The host page's
// tooltips are rendered by its React layer, not by the button, so a cloned control keeps
// the hover background and loses the label; this restores it.
//
// The pill is positioned against the button and appended to the body, because a tooltip
// inside an injected block would be clipped by the thread's scroll container.

(() => {
  // Values taken from the host pill's *computed* style, not its class list: its shadow
  // utility resolves fully transparent, and the pill carries `dark` itself, so one value
  // serves both themes.
  const TOOLTIP_STYLE =
    "background:rgb(27,27,27);color:#fff;" +
    "border-radius:9999px;padding:5px 12px;" +
    "border:0.571429px solid rgba(255,255,255,0.05);" +
    "max-width:20rem;overflow:hidden;";

  // Tuned so ours *appears* when the host page's does, not so the two timers agree: theirs
  // is ~200 ms plus a React render ours does not pay. Re-measure against the live UI rather
  // than reasoning about it if this needs changing.
  const TOOLTIP_DELAY_MS = 212;

  // The host page's warm window: within this long of a tooltip hiding, the next control's
  // appears at once, which is what makes sliding along a row of icons feel continuous.
  const TOOLTIP_WARM_MS = 300;

  // One pill for the page, matching the host page's: moving between controls hands the same
  // element over. A pill per button would fade one out and another in — a different motion.
  let activeTip = null;
  let activeButton = null;
  let tipTimer = null;
  let tipHiddenAt = 0;

  function fillTooltip(tip, label, subtitle) {
    const text = document.createElement("span");
    text.style.cssText =
      "font-size:14px;line-height:18px;font-weight:600;letter-spacing:-0.15px;";
    text.textContent = label;
    tip.replaceChildren(text);
    tip.style.textAlign = subtitle ? "center" : "";

    if (!subtitle) return;
    const second = document.createElement("div");
    second.style.cssText =
      "font-size:12px;line-height:16px;font-weight:400;color:rgba(255,255,255,0.6);";
    second.textContent = subtitle;
    tip.appendChild(second);
  }

  function paintTooltip(button, label, subtitle) {
    tipTimer = null;
    if (!activeTip) {
      activeTip = document.createElement("div");
      activeTip.dataset.localgateTooltip = "true";
      activeTip.style.cssText =
        "position:fixed;z-index:2147483000;pointer-events:none;white-space:nowrap;" +
        // The host pill's own line box is taller than its 14px/18px label; both must be set.
        "font-size:16px;line-height:20px;" + TOOLTIP_STYLE;
      document.body.appendChild(activeTip);
    }
    fillTooltip(activeTip, label, subtitle);
    activeButton = button;

    const anchor = button.getBoundingClientRect();
    const own = activeTip.getBoundingClientRect();
    // 8px ≈ the host component's own offset (derived from its flipped instance) plus mt-0.5.
    activeTip.style.top = `${Math.round(anchor.bottom + 8)}px`;
    activeTip.style.left = `${Math.round(anchor.left + anchor.width / 2 - own.width / 2)}px`;
  }

  // `subtitle` is an optional second line, matching the host page's own — a native "try
  // again" tooltip reads "Try again…" over the model name.
  function attach(button, subtitle) {
    const label = button.getAttribute("aria-label");
    if (!label) return;

    // Cancels a pending appearance as well as removing a shown one: a pointer crossing the
    // row must not leave a trail of tooltips behind it a fifth of a second later.
    const hide = () => {
      clearTimeout(tipTimer);
      tipTimer = null;
      if (activeButton !== button) return;    // already handed over to a sibling
      activeTip?.remove();
      activeTip = null;
      activeButton = null;
      tipHiddenAt = performance.now();
    };

    const show = () => {
      if (activeButton === button) return;
      clearTimeout(tipTimer);
      // Leave fires before enter, so the warm handoff must happen in this same task: the old
      // pill is already gone, and deferring by even one frame paints a frame with no pill.
      if (performance.now() - tipHiddenAt < TOOLTIP_WARM_MS) {
        paintTooltip(button, label, subtitle);
        return;
      }
      tipTimer = setTimeout(() => paintTooltip(button, label, subtitle), TOOLTIP_DELAY_MS);
    };

    button.addEventListener("pointerenter", show);
    button.addEventListener("focus", show);
    button.addEventListener("pointerleave", hide);
    button.addEventListener("blur", hide);
    button.addEventListener("click", hide);
  }

  window.LocalGateTooltip = { attach };
})();
