// ChatGPT DOM adapter — mirrors native turn layout structure.
//
// DOM methods fall into three categories:
//   1. Composer gating: a local prompt is stopped before the host page can send it
//   2. Turn building: buildUserTurn / buildAssistantTurn produce whole turns, not messages
//   3. Streaming: appendToStream → finalizeStream

const PROMPT_SELECTOR = "div#prompt-textarea";

// Server conversation path: `/c/<uuid>`, optionally prefixed (`/c/WEB:<uuid>`).
const CONVERSATION_ID =
  /\/c\/((?:[A-Za-z]+:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

window.LocalGateProviders.register({
  id: "chatgpt",

  matches(hostname) {
    // Exact equality: a substring test also claimed lookalike hosts.
    return ["chatgpt.com", "www.chatgpt.com"].includes(hostname);
  },

  getPromptElement() {
    return document.querySelector(PROMPT_SELECTOR);
  },

  readPromptText(element) {
    return element?.innerText || "";
  },

  // ── Composer gating ─────────────────────────────────────────────────
  //
  // A local prompt is stopped here, at the composer, and never sent. Aborting an in-flight
  // send instead corrupts the host page's conversation model: an aborted send never
  // advances `parent_message_id`, so the next prompt renders as a sibling version of the
  // same turn, and the optimistic user bubble is discarded on the next re-sync.

  isSubmitKey(event) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return false;
    const prompt = this.getPromptElement();
    return !!prompt && (event.target === prompt || prompt.contains(event.target));
  },

  isSubmitClick(event) {
    return !!event.target?.closest?.("#composer-submit-button");
  },

  // True while the host page is answering. Latched rather than read live — see
  // `refreshHostGenerating` for why the composer button cannot be trusted at keypress time.
  // Without it, a mid-answer prompt was answered locally into the same thread.
  isHostGenerating() {
    return hostGenerating;
  },

  // Re-issues the send the gate blocked, by pressing the host page's own button: the
  // request is then built by the host page exactly as it would have been, rather than
  // reconstructed by us.
  submitNatively() {
    document.querySelector("#composer-submit-button")?.click();
  },

  // The composer is a controlled contenteditable, so its text cannot simply be assigned —
  // the host page's editor state would keep the old value and restore it. Editing through
  // the selection makes the host page observe the change as the user's own.
  clearComposer() {
    const prompt = this.getPromptElement();
    if (!prompt) return;
    prompt.focus();
    const range = document.createRange();
    range.selectNodeContents(prompt);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("delete");
  },

  // Writes through the selection for the same reason clearComposer edits that way: the
  // editor state must observe the change as the user's own.
  setComposerText(text) {
    const prompt = this.getPromptElement();
    if (!prompt) return;
    prompt.focus();
    const range = document.createRange();
    range.selectNodeContents(prompt);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("insertText", false, text);
  },

  // ── Conversation identity ───────────────────────────────────────────

  // The server conversation id from the URL, or null. The id must contain a UUID: a looser
  // pattern matched the prefix alone on `/c/WEB:<uuid>` ids, bucketing them all as "WEB".
  getConversationId() {
    return location.pathname.match(CONVERSATION_ID)?.[1] ?? null;
  },

  // The newest server-backed message id on screen, of either role: an assistant turn keeps
  // a client-side request id until its answer settles, and position matters, not role.
  getLastServerMessageId() {
    const nodes = document.querySelectorAll("[data-message-id]");
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].closest("[data-localgate-id]")) continue;   // one of ours
      return nodes[i].getAttribute("data-message-id");
    }
    return null;
  },

  // Whether the host page has a thread of its own. Our turns are clones with the test id
  // stripped, so this counts server content only.
  hasServerTurns() {
    return !!document.querySelector('[data-testid^="conversation-turn-"]');
  },

  // The kind of turn a list child holds, or null if it is not the host page's.
  getServerTurnKind(node) {
    const section = node?.querySelector('[data-testid^="conversation-turn-"][data-turn]');
    return section?.getAttribute("data-turn") ?? null;
  },

  getHomeUrl() {
    return "/";
  },

  // ── Turn-level injection ────────────────────────────────────────────

  // The list every turn is a sibling in — not the message list, and not
  // `conversation-turn-*` itself: each turn's section sits in its own wrapper div, and the
  // wrappers are siblings under one *virtualised* parent. A node parked inside another
  // turn's subtree is deleted when that turn unmounts and can never hold a position
  // relative to turns it is not a sibling of.
  getTurnList() {
    const native = document.querySelector('[data-testid^="conversation-turn-"]');
    if (native) return native.parentElement?.parentElement ?? null;
    return ensureOwnList(this.getPromptElement());
  },

  // Our turn, in the host page's own clothes: cloning a native turn keeps every layout
  // class it carries. A conversation made only of local turns has none to clone, so the
  // skeleton reproduces the same structure from the host page's utility classes.
  buildUserTurn(text) {
    const { wrapper, slot } = buildTurnShell("user");
    const message = document.createElement("div");
    message.className = USER_MESSAGE_CLASS;
    const bubble = document.createElement("div");
    bubble.className = USER_BUBBLE_CLASS;
    const body = document.createElement("div");
    body.className = "max-w-full min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap";
    body.textContent = text;
    bubble.appendChild(body);
    message.appendChild(bubble);
    slot.appendChild(message);
    return wrapper;
  },

  buildAssistantTurn() {
    const { wrapper, slot } = buildTurnShell("assistant");
    // No flex gap: the label, the prose and the action row each carry their own spacing.
    const message = document.createElement("div");
    message.className = "min-h-8 text-message relative flex w-full flex-col";

    const prose = document.createElement("div");
    // The host page's own markdown container: native typography, native code blocks,
    // native list spacing, and both themes, none of it maintained by us.
    prose.className = MARKDOWN_CLASS;

    // The action row's own home: a native row's top sits 4px above the bottom of the
    // prose, where appending into the turn's slot put a 16px flex gap there instead.
    const actions = document.createElement("div");
    actions.className = ACTION_ROW_PARENT_CLASS;

    message.append(createLabel(), prose, actions);
    slot.appendChild(message);
    return { wrapper, prose, slot: actions };
  },

  getStylesheetPath() {
    return "providers/chatgpt/styles.css";
  },

  // ── Static nodes ────────────────────────────────────────────────────

  buildApprovalNode(confidence) {
    const inner = document.createElement("div");
    inner.className = "localgate-approval";

    const body = document.createElement("p");
    body.className = "localgate-approval-body";
    body.textContent = "This prompt looks simple enough for your local model.";

    inner.append(createLabel(), body);

    if (typeof confidence === "number") {
      const meta = document.createElement("div");
      meta.className = "localgate-approval-meta";
      meta.textContent = `Classifier confidence ${Math.round(confidence * 100)}%`;
      inner.appendChild(meta);
    }

    const actions = document.createElement("div");
    actions.className = "localgate-approval-actions";

    const cloudBtn = document.createElement("button");
    cloudBtn.className = "localgate-btn localgate-btn--ghost";
    cloudBtn.textContent = "Use cloud";

    const localBtn = document.createElement("button");
    localBtn.className = "localgate-btn localgate-btn--solid";
    localBtn.textContent = "Answer locally";

    actions.append(cloudBtn, localBtn);
    inner.appendChild(actions);
    return inner;
  },

  // ── Transient nodes ─────────────────────────────────────────────────

  buildThinkingNode() {
    const thinking = document.createElement("div");
    thinking.className = "localgate-thinking";
    thinking.innerHTML = '<span class="localgate-thinking-dot"></span> Thinking…';
    return thinking;
  },

  // ── Streaming ───────────────────────────────────────────────────────

  // Puts the host page's own composer button into its interrupt state for the duration of a
  // local answer, and routes its click to `onStop`. Returns a function that restores it.
  //
  // Send and interrupt are the *same* element (`#composer-submit-button`); only
  // `data-testid`, `aria-label` and the sprite fragment change, so this is a swap of three
  // attributes, not a replacement button. The sprite *file* is content-hashed, so the href
  // is rewritten from whatever the button points at; only the fragment names are stable.
  hijackComposerButton(onStop) {
    const form = this.getPromptElement()?.closest("form");
    if (!form || !submitTemplate) return () => {};

    const trailing = () =>
      form.querySelector("#composer-submit-button") ||
      [...form.querySelectorAll("button")].pop();

    const anchor = trailing();
    const holder = anchor?.parentElement;
    if (!holder) return () => {};

    const stop = submitTemplate.cloneNode(true);
    stop.removeAttribute("id");
    stop.dataset.localgateStop = "true";
    stop.setAttribute("data-testid", "stop-button");
    stop.setAttribute("aria-label", stopLabel);
    stop.disabled = false;
    const icon = stop.querySelector("svg use");
    if (icon && composerSprite) {
      icon.setAttribute("href", `${composerSprite}#${STOP_SPRITE}`);
    }
    stop.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      onStop();
    }, true);

    // Whatever the host page has there is hidden rather than altered: relabelling only
    // worked while the composer had text — empty, the host page renders a *voice* button
    // instead, a different element that never became a stop control.
    const hidden = new Set();
    const conceal = () => {
      for (const button of form.querySelectorAll("button")) {
        if (button === stop || hidden.has(button)) continue;
        if (button !== trailing() && button !== anchor) continue;
        hidden.add(button);
        button.dataset.localgateConcealed = "true";
      }
      if (!stop.isConnected) holder.appendChild(stop);
    };

    conceal();
    // React replaces the trailing control as the composer's contents change — typing makes
    // a submit button appear where the voice button was. Concealing again keeps ours the
    // only send-shaped control on screen while a local answer is generating, which is also
    // what stops a prompt being pushed to the cloud mid-answer.
    const observer = new MutationObserver(conceal);
    observer.observe(form, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      stop.remove();
      for (const button of hidden) delete button.dataset.localgateConcealed;
      hidden.clear();
    };
  },

  // Marks an answer the user cut short, or one superseded by the next prompt, so a partial
  // response is never mistaken for a complete one.
  markStopped(turn) {
    const label = turn.querySelector(".localgate-label");
    if (label && !label.dataset.stopped) {
      label.dataset.stopped = "true";
      label.textContent = "Local · stopped";
    }
  },

  // Labels a turn something went wrong with — a failed generation, a transcript write that
  // did not stick — so the state is visible rather than silent.
  markFailed(turn, text) {
    const label = turn.querySelector(".localgate-label");
    if (!label) return;
    label.dataset.stopped = "true";
    label.textContent = `Local · ${text}`;
  },

  appendToStream(prose, fullText) {
    renderProse(prose, fullText, true);
  },

  // Ends the turn: final render, then the action row. Guarded so that whichever end-of-
  // stream paths reach it, a turn never gets a second row.
  finalizeStream(prose, slot, fullText, onRegenerate, model) {
    renderProse(prose, fullText, false);
    if (slot.querySelector("[data-localgate-actions]")) return;
    const actions = createActions(fullText, onRegenerate, model);
    if (actions) slot.appendChild(actions);
  },

  // ── Sidebar ─────────────────────────────────────────────────────────
  //
  // A conversation row is `#history > ul > li > a[data-sidebar-item][href="/c/<id>"]`;
  // `#history` is the only stable id in the chain, so everything here anchors on it.

  getHistoryList() {
    return document.querySelector("#history ul");
  },

  // A row in the host page's own clothes: hover, focus ring, truncation and both themes
  // come from the clone rather than being maintained here. The badge is not decoration — a
  // row in someone's chat history that is not one of their chats has to say so.
  buildHistoryRow({ id, title }) {
    // A *conversation* row, not merely a sidebar item: "New chat", "Library" and the project
    // rows carry the same attribute and a different inner structure, and the first match in
    // document order is one of those.
    //
    // Not simply the first conversation row, either. The host page orders its history
    // most-recent-first, so the first row is nearly always the conversation being viewed,
    // and cloning it copies that row's *selected* styling onto every row we build — leaving
    // all of ours looking permanently highlighted.
    const rows = [...document.querySelectorAll('a[data-sidebar-item="true"][href^="/c/"]')];
    const template =
      rows.find((row) => row.getAttribute("href") !== location.pathname) ?? rows[0];
    if (!template) return null;

    const link = template.cloneNode(true);
    link.dataset.localgateRow = id;
    link.removeAttribute("data-discover");
    link.setAttribute("href", `#localgate=${id}`);
    link.setAttribute("aria-label", title);
    link.setAttribute("draggable", "false");

    // The clone arrives carrying another conversation's title and its hover controls, which
    // are React-driven and inert on a clone. Only the label survives.
    const label = link.querySelector(".truncate");
    if (!label) return null;
    label.replaceChildren(createRowMarker(), document.createTextNode(title));
    for (const child of [...link.children]) {
      if (!child.contains(label)) child.remove();
    }

    const item = document.createElement("li");
    item.className = "list-none";
    item.dataset.localgateRowItem = id;
    item.appendChild(link);
    return item;
  },

  // Empties a finished assistant turn so the next stream can go back into it, which is what
  // "try again" means: a new answer in place of the old one, not a second exchange with the
  // question asked twice.
  reopenAssistantTurn(wrapper) {
    const prose = wrapper?.querySelector(`.${MARKDOWN_CLASS.split(" ")[0]}`);
    const slot = wrapper?.querySelector("[data-localgate-actions]")?.parentElement;
    if (!prose || !slot) return null;
    prose.replaceChildren();
    slot.replaceChildren();
    return { prose, slot };
  },
});

// ── Shared helpers ──────────────────────────────────────────────────

// Class strings read off live nodes: the host page's own utilities, so a local turn
// inherits its typography and both themes. Only reached when there is no native turn to
// clone — a conversation made entirely of local prompts.
const MARKDOWN_CLASS =
  "markdown prose dark:prose-invert wrap-break-word w-full markdown-new-styling";
const USER_MESSAGE_CLASS =
  "min-h-8 text-message relative flex w-full flex-col items-end gap-2 text-start " +
  "break-words whitespace-normal";
const USER_BUBBLE_CLASS =
  "user-message-bubble-color corner-superellipse/0.98 relative min-w-0 overflow-hidden " +
  "rounded-[22px] px-4 py-2.5 leading-6 max-w-(--user-chat-width,70%)";
const TURN_MARGIN_CLASS =
  "text-base my-auto mx-auto px-(--thread-content-margin) " +
  "[--thread-content-margin:var(--thread-content-margin-xs,calc(var(--spacing)*4))] " +
  "@w-sm/main:[--thread-content-margin:var(--thread-content-margin-sm,calc(var(--spacing)*6))] " +
  "@w-lg/main:[--thread-content-margin:var(--thread-content-margin-lg,calc(var(--spacing)*16))]";
const ACTION_ROW_PARENT_CLASS = "z-0 flex min-h-[46px] justify-start";
const TURN_WIDTH_CLASS =
  "[--thread-content-max-width:40rem] @w-lg/main:[--thread-content-max-width:48rem] " +
  "mx-auto max-w-(--thread-content-max-width) flex-1 relative flex w-full min-w-0 flex-col";

// A conversation answered entirely locally has no thread — the host page never left its
// landing state — so the list is built here, inside the host page's own thread column.
// Nothing else is touched: direct DOM changes last only until React re-renders, so turning
// the landing layout into the thread layout is the stylesheet's job, keyed on this list's
// presence (styles.css).
function ensureOwnList(promptElement) {
  const existing = document.querySelector("[data-localgate-list]");
  if (existing?.isConnected) return existing.firstElementChild;

  const column = promptElement?.closest(".composer-parent")?.children[0];
  if (!column) return null;

  const scroll = document.createElement("div");
  scroll.dataset.localgateList = "true";
  scroll.className = "flex min-h-0 grow flex-col";
  const list = document.createElement("div");
  scroll.appendChild(list);
  column.appendChild(scroll);
  return list;
}

// A turn wrapper matching the host page's, and the slot its messages go in. A clone of a
// live turn of the same kind is preferred: it carries the scroll-margin classes that keep
// a fresh answer clear of the floating composer, computed from CSS variables.
function buildTurnShell(kind) {
  const native = document.querySelector(`[data-testid^="conversation-turn-"][data-turn="${kind}"]`);
  if (native?.parentElement) {
    const wrapper = native.parentElement.cloneNode(true);
    const section = wrapper.querySelector('[data-testid^="conversation-turn-"]');
    // Every attribute that identifies it as one of the host page's own turns has to go, or
    // its queries, its virtualiser and ours all end up arguing over the same node.
    for (const attr of ["data-testid", "data-turn-id", "data-turn-id-container"]) {
      section.removeAttribute(attr);
    }
    section.dataset.localgateTurn = kind;
    const slot = section.querySelector("[data-message-author-role]")?.parentElement;
    if (slot) {
      // The action row is a *sibling* of the message slot, not a child, so emptying the
      // slot alone leaves the clone's inert copy of another turn's row beneath our own.
      // Everything in the turn except the slot goes.
      for (const node of section.querySelectorAll("*")) {
        if (node !== slot && !node.contains(slot) && !slot.contains(node)) node.remove();
      }
      slot.replaceChildren();
      return { wrapper, slot };
    }
  }

  const wrapper = document.createElement("div");
  const section = document.createElement("section");
  section.className = "text-token-text-primary w-full focus:outline-none";
  section.dataset.localgateTurn = kind;
  const margin = document.createElement("div");
  margin.className = TURN_MARGIN_CLASS;
  const width = document.createElement("div");
  width.className = TURN_WIDTH_CLASS;
  const slot = document.createElement("div");
  slot.className = "flex max-w-full flex-col gap-4 grow";
  width.appendChild(slot);
  margin.appendChild(width);
  section.appendChild(margin);
  wrapper.appendChild(section);
  return { wrapper, slot };
}

// The dot a local answer carries, without the word: a sidebar row has no space for it, and
// the row's own title is what the user is reading. The accessible name says it in full.
function createRowMarker() {
  const dot = document.createElement("span");
  dot.className = "localgate-row-dot";
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", "Answered locally");
  return dot;
}

function createLabel() {
  const label = document.createElement("span");
  label.className = "localgate-label";
  label.textContent = "Local";
  return label;
}

// One parser for the page. `html: false` escapes any raw HTML in the model's output instead
// of parsing it, and link schemes are validated. `breaks: true` matches the host page: a
// single newline is a line break, which hand-rolled rendering used to drop, running haiku,
// lists and code together on one line.
const markdown = window.markdownit({ html: false, linkify: true, breaks: true });

// Inline on* handlers survive importNode and fire on insertion, so parsing detached is not
// enough on its own; anything executable is stripped before a node reaches the document.
function stripActiveContent(root) {
  for (const el of root.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (attr.name.toLowerCase().startsWith("on")) el.removeAttribute(attr.name);
    }
    for (const name of ["href", "src", "xlink:href"]) {
      if (/^\s*javascript:/i.test(el.getAttribute(name) || "")) el.removeAttribute(name);
    }
  }
}

function renderProse(prose, text, showCursor) {
  prose.replaceChildren();

  // `html: false` keeps raw HTML out of the render; stripActiveContent covers what would
  // otherwise execute on insertion.
  const parsed = new DOMParser().parseFromString(markdown.render(text), "text/html");
  stripActiveContent(parsed.body);
  for (const node of [...parsed.body.childNodes]) {
    prose.appendChild(document.importNode(node, true));
  }
  if (showCursor) {
    const cursor = document.createElement("span");
    cursor.className = "localgate-cursor";
    const lastP = prose.lastElementChild;
    if (lastP) {
      lastP.appendChild(cursor);
    } else {
      prose.appendChild(cursor);
    }
  }
}

// A clone of the host page's own response action row, cached the first time one is seen.
//
// Cloning is the only way to match it: the icons are content-hashed sprite references that
// rot on the next deploy if copied, and the buttons are styled by the host page's own
// stylesheet, so the row is rendered in the light DOM where both resolve. Clones carry no
// React handlers, so ours are the only behaviour. Cached because an all-local conversation
// contains no assistant message to clone from.
let actionTemplate = null;

// Persisted across page loads and browser restarts: the hand-drawn fallback is visibly not
// the host page's row, and the user sees that as the row changing shape the moment a
// conversation's first cloud answer arrives. The stored template's sprite references are
// content-hashed and can rot, so it is refreshed from a live row whenever one is on screen.
const TEMPLATE_KEY = "localgate:chatgpt:actionRow";

// Rows rendered from the fallback while no template was available, so they can be rebuilt
// as clones the moment one arrives — mid-conversation, or from storage a beat after load.
const awaitingTemplate = new Set();

chrome.storage.local.get(TEMPLATE_KEY).then((stored) => {
  const html = stored[TEMPLATE_KEY];
  if (!html || actionTemplate) return;
  const holder = document.createElement("div");
  // Our own capture, but it round-trips through storage: parsed detached and stripped of
  // executable content before anything reaches the live document.
  const parsed = new DOMParser().parseFromString(html, "text/html").body.firstElementChild;
  if (!parsed) return;
  stripActiveContent(parsed);
  holder.appendChild(document.importNode(parsed, true));
  actionTemplate = holder.firstElementChild;
  upgradeFallbackRows();
});

function rememberActionTemplate(row) {
  void chrome.storage.local.set({ [TEMPLATE_KEY]: row.outerHTML });
}

function upgradeFallbackRows() {
  if (!actionTemplate || !awaitingTemplate.size) return;
  for (const pending of [...awaitingTemplate]) {
    awaitingTemplate.delete(pending);
    const { row, text, onRegenerate, model } = pending;
    if (!row.isConnected) continue;
    row.replaceWith(createNativeActions(actionTemplate, text, onRegenerate, model));
  }
}

function captureActionTemplate() {
  if (actionTemplate) return actionTemplate;
  // Anchored on an assistant message: aria-labels are localised, the copy button's testid
  // is shared by the *user* hover row, and our own rows are clones carrying that same
  // testid — matching any of those cloned the wrong row, or a clone of a clone that lost
  // every button but the first.
  const assistant = document.querySelector('[data-message-author-role="assistant"]');
  let node = assistant;
  for (let depth = 0; depth < 6 && node; depth++) {
    node = node.parentElement;
    const row = node?.querySelector('[role="group"]:not([data-localgate-actions])');
    if (row && row.querySelectorAll("button").length > 1) {
      actionTemplate = row.cloneNode(true);
      // Refreshed on every capture, not only the first: a stored template's sprite
      // references are content-hashed and go stale across the host page's deploys.
      rememberActionTemplate(actionTemplate);
      upgradeFallbackRows();
      break;
    }
  }
  return actionTemplate;
}

function createActions(text, onRegenerate, model) {
  const template = captureActionTemplate();
  if (template) return createNativeActions(template, text, onRegenerate, model);

  // No native row anywhere yet — a conversation that has never been to the cloud, on a
  // profile that has not stored one. The hand-drawn row stands in and is registered for
  // replacement, so it becomes a clone as soon as a real one exists.
  const row = createFallbackActions(text, onRegenerate, model);
  awaitingTemplate.add({ row, text, onRegenerate, model });
  return row;
}

// Which control on the row is "try again". Only the copy button carries a test id, labels
// are localised, and the sprite fragments are content hashes — so the key is this button's
// shape: a dropdown trigger sized to its content (`h-[30px] px-1.5`) where every other
// button on the row is a fixed 32×32 square. If that stops holding we lose the button
// rather than mislabel one, which is the failure worth having.
function isRegenerateButton(button) {
  return button.className.includes("h-[30px]");
}

function createNativeActions(template, text, onRegenerate, model) {
  const row = template.cloneNode(true);
  row.dataset.localgateActions = "true";

  // The native row is hidden until an ancestor carrying the host page's turn-group class is
  // hovered, which ours never is — cloned, it renders at opacity 0 with pointer events off.
  // Inline styles override those classes without stripping them, so the row keeps every
  // other visual it inherits.
  row.style.opacity = "1";
  row.style.pointerEvents = "auto";
  row.style.maskImage = "none";
  row.style.webkitMaskImage = "none";

  for (const button of row.querySelectorAll("button")) {
    if (button.dataset.testid === "copy-turn-action-button") {
      // Drop the testid once it has served its purpose: leaving it would put a duplicate of
      // the host page's own test hook in the document, and would make this row a candidate
      // for the template capture above.
      button.removeAttribute("data-testid");
      attachTooltip(button);
      button.addEventListener("click", () => copyToClipboard(text, button));
      continue;
    }

    if (isRegenerateButton(button) && onRegenerate) {
      // The clone's label is whichever variant the host page was showing ("Switch model"),
      // and neither variant is what this button now does. Relabelled outright — the one
      // place on this row we cannot inherit the user's language; the icon carries meaning.
      button.setAttribute("aria-label", "Try again");
      attachTooltip(button, model ? `Used ${model}` : null);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onRegenerate();
      });
      continue;
    }

    attachTooltip(button);

    // Sources is misleading rather than merely unavailable: a local answer has none, and a
    // greyed "Sources" reads as a failure to load them. Detected by having visible text —
    // the only control on this row that is not icon-only, since labels are localised.
    if (button.textContent.trim()) {
      button.remove();
      continue;
    }

    // Everything else on this row is server-side — share, branch, read aloud — and cannot
    // work for an answer the provider has no record of. Shown but inert, so the local
    // route's limits are legible rather than looking broken.
    button.disabled = true;
    button.style.opacity = "0.4";
    button.style.cursor = "default";
  }
  return row;
}

// Tooltips live in lib/tooltip.js; this alias keeps the call sites short.
const attachTooltip = (button, subtitle) => window.LocalGateTooltip.attach(button, subtitle);

// Sprite fragment names for the composer button's two states. Unlike the action-row icons
// these are stable words rather than content hashes; only the sprite file is versioned.
const SEND_SPRITE = "send-prompt-style-thin";
const STOP_SPRITE = "stop-filled-style-thin";

// The host page's own wording, learned the first time a native interrupt state is seen so
// the label stays in the user's language. The fallback is only used before that happens.
let stopLabel = "Stop answering";
// The composer sprite file, learned while a send button is on screen. Content-hashed, so it
// cannot be hardcoded, and unavailable at the moment we need it — the composer is empty by
// then and its button points at a different file.
let composerSprite = null;

// The send button, cloned the first time one is on screen (childList as well as attributes
// below: it *appears* rather than changing). It only exists while the composer has text, so
// it has to be kept — by generation time the host page has swapped in a voice button.
let submitTemplate = null;

// Whether the host page is answering. Latched rather than read live: the button carries
// `data-testid="stop-button"` for the whole of a cloud answer but only while the composer
// is empty — typing mid-answer swaps it back to a send button, so a live read at keypress
// time always says "not generating".
//
// Cleared two ways: the control goes away with an *empty* composer, or the button reverts
// to its send state (send sprite, no stop testid) — without the second, an answer ending
// while unsent text sits in the composer leaves the latch stale.
let hostGenerating = false;

function refreshHostGenerating(native) {
  if (native && !native.dataset.localgateStop) {
    hostGenerating = true;
    return;
  }
  const submit = document.querySelector("#composer-submit-button");
  if (submit && !submit.dataset.localgateStop &&
      submit.querySelector(`svg use[href*="${SEND_SPRITE}"]`)) {
    hostGenerating = false;
    return;
  }
  const prompt = document.querySelector(PROMPT_SELECTOR);
  if (!prompt || !prompt.innerText.trim()) hostGenerating = false;
}

new MutationObserver(() => {
  const submit = document.querySelector("#composer-submit-button");
  if (submit && !submitTemplate) submitTemplate = submit.cloneNode(true);
  if (!composerSprite) {
    const href = document
      .querySelector(`#composer-submit-button svg use[href*="${SEND_SPRITE}"]`)
      ?.getAttribute("href");
    if (href) composerSprite = href.split("#")[0];
  }
  const native = document.querySelector('#composer-submit-button[data-testid="stop-button"]');
  const label = native?.getAttribute("aria-label");
  if (label) stopLabel = label;
  refreshHostGenerating(native);
}).observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ["data-testid", "aria-label", "href"],
});

function copyToClipboard(text, button) {
  navigator.clipboard.writeText(text).then(() => {
    button.classList.add("copied");
    setTimeout(() => button.classList.remove("copied"), 2000);
  });
}

// Used until the page has shown us a native row to clone — a conversation that has only
// ever gone local never renders one.
function createFallbackActions(text, onRegenerate, model) {
  const actions = document.createElement("div");
  actions.className = "localgate-actions";
  // Marked like a cloned row so the "already finalized" guard recognises it too — without
  // it a second finalize appended a second copy button.
  actions.dataset.localgateActions = "true";

  const copyBtn = document.createElement("button");
  copyBtn.className = "localgate-action-btn";
  copyBtn.setAttribute("aria-label", "Copy response");
  copyBtn.innerHTML =
    '<svg class="localgate-copy" viewBox="0 0 20 20" fill="currentColor">' +
      '<path d="M12.668 10.667c0-.71 0-1.204-.031-1.588a2.4 2.4 0 0 0-.113-.615l-.055-.13a1.84 1.84 0 0 0-.676-.731l-.127-.072c-.158-.08-.37-.137-.745-.168-.384-.031-.877-.031-1.588-.031H6.5c-.711 0-1.204 0-1.588.031a2.4 2.4 0 0 0-.615.113l-.13.055a1.84 1.84 0 0 0-.731.676l-.07.127c-.081.158-.138.37-.169.745-.031.384-.032.877-.032 1.588V13.5c0 .711 0 1.204.032 1.588.031.376.088.587.168.745l.07.126c.177.288.43.522.732.676l.13.056c.144.052.333.089.615.112.384.031.877.032 1.588.032h2.833c.71 0 1.204 0 1.588-.032.376-.031.587-.088.745-.168l.127-.07c.287-.177.522-.43.676-.732l.055-.13c.052-.144.09-.333.113-.615.031-.384.031-.877.031-1.588zm1.33 1.998c.455-.002.803-.005 1.09-.028.376-.031.587-.088.745-.168l.126-.071c.288-.177.522-.43.676-.732l.056-.13a2.4 2.4 0 0 0 .112-.615c.031-.384.032-.877.032-1.588V6.5c0-.711 0-1.204-.032-1.588a2.4 2.4 0 0 0-.112-.615l-.056-.13a1.84 1.84 0 0 0-.676-.731l-.126-.07c-.158-.081-.37-.138-.745-.169-.384-.031-.877-.032-1.588-.032h-2.833c-.71 0-1.204.001-1.588.032-.282.023-.471.06-.615.112l-.13.056a1.84 1.84 0 0 0-.731.676l-.072.126c-.08.158-.137.37-.168.745-.023.287-.027.635-.029 1.09h1.999c.689 0 1.246 0 1.696.036.458.038.865.117 1.242.309l.217.122c.496.304.9.74 1.165 1.26l.067.143c.144.337.21.698.242 1.099.037.45.036 1.007.036 1.696zm4.167-3.332c0 .689 0 1.246-.036 1.696-.033.401-.098.762-.242 1.099l-.067.143c-.265.52-.67.956-1.165 1.26l-.219.122c-.376.192-.782.271-1.24.309-.337.027-.734.031-1.2.033-.003.467-.007.864-.034 1.201-.033.401-.098.762-.242 1.098l-.067.142c-.265.522-.669.958-1.165 1.262l-.217.122c-.377.192-.784.271-1.242.309-.45.037-1.007.036-1.696.036H6.5c-.69 0-1.246 0-1.696-.036-.4-.033-.762-.098-1.098-.242l-.143-.067a3.17 3.17 0 0 1-1.261-1.165l-.122-.219c-.192-.376-.271-.782-.309-1.24-.037-.45-.036-1.007-.036-1.696v-2.833c0-.689 0-1.246.036-1.696.038-.458.117-.865.309-1.242l.122-.217c.304-.496.74-.9 1.261-1.165l.143-.067c.336-.144.697-.21 1.098-.242.337-.027.733-.032 1.2-.034.002-.467.007-.863.034-1.2.037-.458.117-.864.309-1.24l.122-.22c.304-.495.74-.899 1.26-1.164l.143-.067c.337-.144.698-.21 1.099-.242.45-.037 1.007-.036 1.696-.036H13.5c.69 0 1.246 0 1.696.036.458.038.864.117 1.24.309l.22.122c.495.304.899.74 1.164 1.261l.067.143c.144.336.21.697.242 1.098.037.45.036 1.007.036 1.696z"/>' +
    '</svg>' +
    '<svg class="localgate-check" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="15 5 7.5 13 5 10"/>' +
    '</svg>';

  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.classList.add("copied");
      setTimeout(() => copyBtn.classList.remove("copied"), 2000);
    });
  });

  attachTooltip(copyBtn);
  actions.appendChild(copyBtn);

  if (onRegenerate) {
    const again = document.createElement("button");
    again.className = "localgate-action-btn";
    again.setAttribute("aria-label", "Try again");
    // The host page's own icon is a sprite reference into a content-hashed file, and this
    // row is only reached when there is no native turn to read one from. Drawn here instead.
    again.innerHTML =
      '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" ' +
        'stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M16.2 8.6A6.5 6.5 0 1 0 16.5 12"/>' +
        '<polyline points="16.5 4.5 16.5 8.8 12.2 8.8"/>' +
      '</svg>';
    again.addEventListener("click", () => onRegenerate());
    attachTooltip(again, model ? `Used ${model}` : null);
    actions.appendChild(again);
  }

  return actions;
}
