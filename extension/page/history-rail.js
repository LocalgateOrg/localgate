// Puts local-only conversations into the host page's own chat history sidebar.
//
// A locally answered conversation has no server-side row — the prompt was never sent — so
// the row is ours: cloned from a host row so hover, focus, truncation and both themes match,
// and carrying the local marker, because a row that is not one of the user's chats has to
// say so. The sidebar re-renders like the thread does, so this is a sweep, not an insert.

(() => {
  const SWEEP_MS = 1500;

  function adapter() {
    return window.LocalGateProviders.getActiveAdapter();
  }

  // Navigation without a page load: the host page's router never sees this, and
  // `transcript.js` restores on `hashchange`.
  function open(id, event) {
    event.preventDefault();
    event.stopPropagation();
    if (location.hash === `#localgate=${id}`) return;
    // A local conversation renders into the landing screen's stand-in thread, so anything
    // the host page has on screen has to go first — otherwise its turns and ours interleave.
    const home = adapter()?.getHomeUrl?.() ?? "/";
    if (location.pathname !== home) {
      location.href = `${home}#localgate=${id}`;
      return;
    }
    location.hash = `localgate=${id}`;
  }

  function markCurrent(list) {
    const active = location.hash.replace("#localgate=", "");
    for (const row of list.querySelectorAll("[data-localgate-row]")) {
      // `aria-current` is what a router would set; the host page's own active styling keys
      // off its route, which ours is invisible to, so this is the honest half of it.
      row.setAttribute("aria-current", row.dataset.localgateRow === active ? "page" : "false");
    }
  }

  async function sweep() {
    if (document.hidden) return;         // nothing to reconcile in a background tab
    const provider = adapter();
    const list = provider?.getHistoryList?.();
    if (!list) return;

    let conversations;
    try {
      conversations = await window.LocalGateTranscript.list();
    } catch {
      return;
    }
    if (!conversations.length) {
      for (const stale of list.querySelectorAll("[data-localgate-row-item]")) stale.remove();
      return;
    }

    const wanted = new Map(conversations.map((c) => [c.id, c]));

    // Rows for conversations that have since been deleted, or that were adopted by a server
    // id once the user sent something to the cloud.
    for (const item of list.querySelectorAll("[data-localgate-row-item]")) {
      if (!wanted.has(item.dataset.localgateRowItem)) item.remove();
    }

    // Newest first, above the host page's own rows: they are the conversations the user was
    // most recently in, and the host page orders its own the same way.
    let before = list.firstElementChild;
    for (const conversation of conversations) {
      const existing = list.querySelector(
        `[data-localgate-row-item="${conversation.id}"]`
      );
      if (existing) {
        if (existing !== before) list.insertBefore(existing, before);
        before = existing.nextElementSibling;
        continue;
      }

      const item = provider.buildHistoryRow(conversation);
      if (!item) return;                       // no row to clone from yet; try next sweep
      item.firstElementChild.addEventListener(
        "click", (event) => open(conversation.id, event), true
      );
      list.insertBefore(item, before);
      before = item.nextElementSibling;
    }

    markCurrent(list);
  }

  window.addEventListener("hashchange", () => { void sweep(); });
  // The interval skips hidden tabs, so catch up the moment the tab is visible again.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void sweep();
  });
  setInterval(() => { void sweep(); }, SWEEP_MS);
})();
