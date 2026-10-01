// Keeps local exchanges alive across the host page's own re-renders.
//
// Two things remove them. The thread is virtualised: turns scrolled far enough away are
// unmounted and replaced by fixed-height spacers, ours included, because to the host page
// they are just DOM. And a reload rebuilds the thread from the server, which has no record
// of a local exchange at all — the prompt was never sent.
//
// So each finished exchange is recorded with an anchor and re-rendered whenever it is
// missing. The anchor is a message *id*, never a position: indices shift as the host page
// mounts and unmounts its own turns.
//
//   afterId  the last server-backed message at the time, or null for "start of the
//            conversation".
//
// Stored in `local`: a conversation answered only locally exists nowhere else — the
// provider never saw the prompt — so it must survive reload and restart to be returnable at
// all. The cost is prompt text sitting in the profile until deleted, which is why `remove`
// and `clear` exist and are surfaced in the popup.

(() => {
  // One storage key per conversation, so recording a turn writes that conversation alone
  // rather than read-modify-writing every stored one.
  const KEY_PREFIX = "localgate:tx:";
  const LEGACY_KEY = "localgate:transcripts";
  const NEW_CONVERSATION = "new";
  const SWEEP_MS = 1000;
  const TITLE_MAX = 60;
  const store = chrome.storage.local;

  const txKey = (key) => `${KEY_PREFIX}${key}`;

  function adapter() {
    return window.LocalGateProviders.getActiveAdapter();
  }

  // Our own conversations are addressed by a hash rather than a path. `/c/<uuid>` would look
  // right until the user reloaded, at which point the host page fetches it and shows a
  // not-found error; a hash it ignores entirely, and a reload degrades to a clean new chat
  // that we then restore into.
  const LOCAL_HASH = /#localgate=([0-9a-f-]{36})/i;

  let entries = [];

  function conversationKey() {
    const server = adapter()?.getConversationId?.();
    if (server) return server;
    const own = location.hash.match(LOCAL_HASH);
    return own ? `local:${own[1]}` : NEW_CONVERSATION;
  }

  let conversation = conversationKey();

  // A conversation with no server id gets one of ours the first time it is answered
  // locally, so it can be linked to, listed, and returned to. The hash is written without a
  // history entry: this is naming what the user is already looking at, not navigation.
  function nameOwnConversation() {
    const id = crypto.randomUUID();
    history.replaceState(history.state, "", `${location.pathname}#localgate=${id}`);
    return `local:${id}`;
  }

  // A client-side provisional id precedes the server's own in the URL. Treating that hop as
  // navigation to a different conversation drops every local turn recorded before the first
  // cloud send.
  function isProvisional(key) {
    return key === NEW_CONVERSATION || key.includes(":");
  }

  // Adoption — carrying local entries into the conversation the server has just named — is
  // an *event*, not a property of the id. It is correct after exactly one thing: a prompt
  // released to the host page, which is what makes the host page create a conversation for
  // our turns to live in. Every other way the key changes is navigation.
  //
  // Keying on the id's shape instead conflated the two. `local:<uuid>` contains a colon, so
  // it read as provisional, so *leaving* a local conversation by any route adopted it into
  // wherever the user went: opening a cloud chat merged the local turns into that chat and
  // deleted the local record, and opening another local conversation merged the two into
  // one. Both silently destroyed a conversation that exists nowhere else.
  //
  // The window is a backstop for a send that never navigated — a failed request, say — so a
  // stale signal cannot arm an adoption on some later, unrelated navigation.
  const ADOPT_WINDOW_MS = 10_000;
  let cloudSentAt = 0;

  // Called by the gate as it hands a prompt to the host page; only meaningful when there is
  // something to carry.
  function expectAdoption() {
    if (entries.length) cloudSentAt = Date.now();
  }

  // An assistant turn is not identified while the page is live — the newest *identified*
  // message is usually the user half of the exchange our turns follow, and anchoring on it
  // alone drops them between a question and its answer.
  function skipReply(anchor) {
    const provider = adapter();
    if (!provider?.getServerTurnKind) return anchor;
    const next = anchor?.nextElementSibling;
    if (provider.getServerTurnKind(anchor) === "user" &&
        provider.getServerTurnKind(next) === "assistant") {
      return next;
    }
    return anchor;
  }

  // One-time split of the old aggregate store into per-conversation keys.
  async function migrateLegacyStore() {
    const stored = await store.get(LEGACY_KEY);
    const all = stored[LEGACY_KEY];
    if (!all) return;
    const split = {};
    for (const [key, record] of Object.entries(all)) split[txKey(key)] = record;
    if (Object.keys(split).length) await store.set(split);
    await store.remove(LEGACY_KEY);
  }
  // A failed migration must not wedge every later storage call behind a rejected promise.
  const storeReady = migrateLegacyStore().catch(() => {});

  async function readRecord(key) {
    await storeReady;
    const stored = await store.get(txKey(key));
    return stored[txKey(key)];
  }

  // A record is `{title, updatedAt, entries}`. The title is the opening prompt, truncated:
  // the host page titles a conversation server-side from its first message, which is not
  // available for one the server has never seen, and the first thing asked is the closest
  // honest stand-in. `updatedAt` orders the sidebar. Neither is recoverable later.
  async function writeEntries(key, list) {
    await storeReady;
    if (!list.length) {
      await store.remove(txKey(key));
      return;
    }
    const existing = await readRecord(key);
    await store.set({
      [txKey(key)]: {
        title: existing?.title || titleFrom(list[0].prompt),
        updatedAt: Date.now(),
        entries: list,
      },
    });
  }

  // Storage full (or otherwise refusing writes): drop the least recently touched other
  // conversation and try once more. No quota arithmetic — one eviction, one retry.
  async function pruneOldestAndRetry(key, list) {
    try {
      const all = await store.get(null);
      const oldest = Object.entries(all)
        .filter(([k]) => k.startsWith(KEY_PREFIX) && k !== txKey(key))
        .sort((a, b) => (a[1]?.updatedAt || 0) - (b[1]?.updatedAt || 0))[0];
      if (oldest) await store.remove(oldest[0]);
      await writeEntries(key, list);
      return true;
    } catch {
      return false;
    }
  }

  // A turn that did not make it into storage says so, rather than silently vanishing on
  // the next reload.
  function markUnsaved(id) {
    const turn = document.querySelector(
      `[data-localgate-id="${id}"][data-localgate-role="assistant"]`
    );
    if (turn) adapter()?.markFailed?.(turn, "not saved");
  }

  function titleFrom(prompt) {
    const flat = (prompt || "").replace(/\s+/g, " ").trim();
    return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
  }

  function entriesOf(record) {
    // Tolerates the old shape, which stored the array directly.
    return Array.isArray(record) ? record : record?.entries ?? [];
  }

  // `id` is the one already on the live turns, so the sweep recognises the exchange
  // currently on screen instead of rebuilding a second copy. `model` is provenance — cheap
  // to keep now, impossible to reconstruct later.
  async function record(prompt, answer, id, model) {
    if (!prompt || !answer || !id) return;
    // "Try again" re-runs a prompt into the turn already on screen and reports the same id
    // when it finishes, so an entry is replaced rather than appended — otherwise the
    // superseded answer stays in the store and the sweep renders it a second time.
    const existing = entries.find((e) => e.id === id);
    const entry = {
      id,
      prompt,
      answer,
      model: model ?? null,
      // A re-run keeps the exchange's original anchor: same question, same turn, answered
      // again. Re-anchoring would file it after whatever the thread has grown to since.
      afterId: existing ? existing.afterId : adapter()?.getLastServerMessageId?.() ?? null,
      // Recorded up front: at restore time "opened the conversation" and "anchor not on
      // screen" produce the same empty query and must not be conflated.
      atStart: existing ? existing.atStart : !adapter()?.hasServerTurns?.(),
    };
    entries = existing
      ? entries.map((e) => (e.id === id ? entry : e))
      : [...entries, entry];
    // An unnamed conversation is named here rather than left in memory. Persisting under
    // NEW_CONVERSATION would file entries under a key every future new chat also starts on,
    // so it gets an id of ours instead — which is also what the sidebar row links to.
    if (conversation === NEW_CONVERSATION) conversation = nameOwnConversation();
    try {
      await writeEntries(conversation, entries);
    } catch {
      const saved = await pruneOldestAndRetry(conversation, entries);
      if (!saved) markUnsaved(id);
    }
  }

  // Entries recorded under a provisional id are carried into the conversation the server
  // has now named. The provisional record is deleted in the same step: left behind, it
  // lists the conversation a second time in the sidebar as a phantom row.
  async function adoptInto(key, previousKey) {
    const existingRecord = await readRecord(key);
    const existing = entriesOf(existingRecord);
    const merged = [...existing,
      ...entries.filter((e) => !existing.some((k) => k.id === e.id))];
    if (merged.length) {
      const previousRecord = await readRecord(previousKey);
      await store.set({
        [txKey(key)]: {
          title: existingRecord?.title || previousRecord?.title || titleFrom(merged[0].prompt),
          updatedAt: Date.now(),
          entries: merged,
        },
      });
    }
    await store.remove(txKey(previousKey));

    // The host page pushes `/c/<id>` without touching the fragment, so our own address rides
    // along on a conversation that is no longer ours — and would re-open the wrong thing on
    // the next reload.
    if (LOCAL_HASH.test(location.hash)) {
      history.replaceState(history.state, "", location.pathname + location.search);
    }
    return merged;
  }

  // The turn this entry should be inserted *before*; null means append, and `false` means
  // leave it where it is.
  //
  // Two anchors compete and the *later* wins: `afterId` (the server content this exchange
  // followed) and `previous` (the exchange placed just before it). Either alone misorders —
  // `previous` outright chains every exchange to the top of the thread; `afterId` outright
  // unorders two local exchanges sharing one anchor, the common case.
  function placementFor(entry, list, previous) {
    // Looked up by message id, not the section's turn id — they differ on assistant turns.
    let anchor = entry.afterId
      ? list.querySelector(`[data-message-id="${entry.afterId}"]`)
      : null;
    while (anchor && anchor.parentElement !== list) anchor = anchor.parentElement;
    anchor = skipReply(anchor);

    if (!anchor && !previous) {
      // `atStart` (recorded up front) distinguishes "opened the conversation" from "anchor
      // unmounted by the virtualiser"; for the latter, moving on a guess is worse than
      // leaving the turns alone.
      return entry.atStart ? list.firstElementChild : false;
    }

    const candidates = [anchor, previous].filter(Boolean);
    const last = candidates.reduce((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? b : a
    );
    return last.nextElementSibling;
  }

  // True when this exchange's turns already sit together, in order, in the right place.
  // Checked rather than assumed: re-inserting an already-correct pair swaps question and
  // answer on alternate sweeps.
  function isPlaced(turns, list, before) {
    if (turns[0].parentElement !== list) return false;
    if (turns.includes(before)) return true;      // already at the start of the list
    for (let i = 1; i < turns.length; i++) {
      if (turns[i - 1].nextElementSibling !== turns[i]) return false;
    }
    return turns[turns.length - 1].nextElementSibling === before;
  }

  async function restore() {
    const list = adapter()?.getTurnList?.();
    if (!list) return;

    // Entries are walked in order so each can chain off the one before it.
    let previous = null;

    for (const entry of entries) {
      // Looked up across the document, not within the list: a conversation that began
      // with local prompts had no thread to put them in, so its turns are standing in a
      // list of ours. The first cloud send creates the real one, and they move.
      const turns = [...document.querySelectorAll(`[data-localgate-id="${entry.id}"]`)];

      const before = placementFor(entry, list, previous);

      if (turns.length) {
        // Re-homed, and re-ordered: our own stand-in list has no idea where a later cloud
        // turn landed, and the host page appends its own turns wherever it likes.
        if (before !== false && !isPlaced(turns, list, before)) {
          for (const turn of turns) list.insertBefore(turn, before);
        }
        previous = turns[turns.length - 1];
        continue;
      }

      await window.LocalGateChatUI.renderStoredExchange(
        entry, before === false ? null : before
      );
      const rebuilt = [...list.querySelectorAll(`[data-localgate-id="${entry.id}"]`)];
      previous = rebuilt[rebuilt.length - 1] ?? previous;
    }

    // Our stand-in list has served its purpose once the host page has a thread of its own.
    const own = document.querySelector("[data-localgate-list]");
    if (own && own !== list.parentElement && !own.querySelector("[data-localgate-turn]")) {
      own.remove();
    }
  }

  // Turns belonging to a conversation we are no longer looking at. Left behind they would
  // appear inside whichever conversation the user opened next, which is the one way this
  // feature could show someone else's words in the wrong place.
  function evictForeignTurns() {
    const mine = new Set(entries.map((e) => e.id));
    for (const node of document.querySelectorAll("[data-localgate-id]")) {
      if (!mine.has(node.dataset.localgateId)) node.remove();
    }
    const own = document.querySelector("[data-localgate-list]");
    if (own && !own.querySelector("[data-localgate-turn]")) own.remove();
  }

  // One sweep at a time: rendering is asynchronous, and a sweep that starts while the
  // previous one is still building nodes cannot see them yet, so it builds them again.
  let sweeping = false;

  async function sweep() {
    if (document.hidden) return;         // nothing to reconcile in a background tab
    if (sweeping) return;
    sweeping = true;
    try {
      await sweepOnce();
    } finally {
      sweeping = false;
    }
  }

  async function sweepOnce() {
    const key = conversationKey();
    if (key !== conversation) {
      const previous = conversation;
      const adopting = isProvisional(previous)
        && Date.now() - cloudSentAt < ADOPT_WINDOW_MS;
      conversation = key;
      if (key === NEW_CONVERSATION) {
        entries = [];                        // a fresh chat starts empty
      } else if (adopting) {
        // Adopted on *every* hop, not only the last: a conversation that begins locally
        // reaches its server id in two, and the middle id is provisional too. Each hop
        // deletes the record it leaves behind; the chain ends at the server's own id.
        entries = await adoptInto(key, previous);
        if (!isProvisional(key)) cloudSentAt = 0;
      } else {
        entries = entriesOf(await readRecord(key));
      }
      evictForeignTurns();
    }
    if (entries.length) await restore();
  }

  // Newest first, which is the order the host page's own history is in.
  async function list() {
    await storeReady;
    const all = await store.get(null);
    const localPrefix = `${KEY_PREFIX}local:`;
    return Object.entries(all)
      .filter(([key]) => key.startsWith(localPrefix))
      .map(([key, record]) => ({
        key: key.slice(KEY_PREFIX.length),
        id: key.slice(localPrefix.length),
        title: record?.title || "Local conversation",
        updatedAt: record?.updatedAt || 0,
        count: entriesOf(record).length,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function remove(key) {
    await storeReady;
    await store.remove(txKey(key));
    if (key === conversation) entries = [];
  }

  async function clear() {
    await storeReady;
    const all = await store.get(null);
    const doomed = Object.keys(all).filter((key) => key.startsWith(KEY_PREFIX));
    if (doomed.length) await store.remove(doomed);
    entries = [];
  }

  window.LocalGateTranscript = { record, list, remove, clear, expectAdoption };

  if (conversation !== NEW_CONVERSATION) {
    readRecord(conversation).then((record) => {
      entries = entriesOf(record);
    });
  }
  // The sweep would notice on its own within a second, but a conversation the user just
  // clicked should not take a second to appear.
  window.addEventListener("hashchange", () => { void sweep(); });
  window.addEventListener("popstate", () => { void sweep(); });
  // The interval skips hidden tabs, so catch up the moment the tab is visible again.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void sweep();
  });

  setInterval(() => { void sweep(); }, SWEEP_MS);
})();
