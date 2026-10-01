// Popup controller. Three concerns, all non-blocking: theme, routing mode, and a
// one-shot health/stats probe of the daemon. The UI is fully usable before the
// network probe resolves, so a slow or dead daemon never blocks interaction.

// Settings are seeded into storage by the service worker, which owns the defaults; the
// popup only reads them back.
const PROBE_TIMEOUT_MS = 2000;

// system → light → dark → system. "system" defers to the OS via prefers-color-scheme.
const THEME_CYCLE = ["system", "light", "dark"];

// Inline so the description needs no network round-trip; mirrors the modes the
// content script honours.
const MODE_DESC = {
  transparent: "Routes automatically. Simple prompts run locally; complex or risky ones go to the cloud.",
  hitl: "Asks before answering locally. You approve each local routing decision.",
  passthrough: "Every prompt goes to the cloud. LocalGate observes but never intercepts.",
};

const els = {
  body: document.body,
  statusDot: document.getElementById("status-dot"),
  themeToggle: document.getElementById("theme-toggle"),
  banner: document.getElementById("banner"),
  bannerText: document.getElementById("banner-text"),
  segment: document.getElementById("segment"),
  segmentBtns: Array.from(document.querySelectorAll(".segment__btn")),
  modeDesc: document.getElementById("mode-desc"),
  statLocal: document.getElementById("stat-local"),
  statLatency: document.getElementById("stat-latency"),
  modelName: document.getElementById("model-name"),
  endpoint: document.getElementById("endpoint"),
};

// ── Theme ──────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  els.themeToggle.dataset.active = theme;
  els.themeToggle.title = `Theme: ${theme}`;
}

async function loadTheme() {
  const { theme } = await chrome.storage.local.get({ theme: "system" });
  applyTheme(THEME_CYCLE.includes(theme) ? theme : "system");
}

async function cycleTheme() {
  const current = document.documentElement.dataset.theme || "system";
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
  applyTheme(next);
  await chrome.storage.local.set({ theme: next });
}

// ── Routing mode ───────────────────────────────────────────────────────────

function renderMode(mode) {
  for (const btn of els.segmentBtns) {
    btn.setAttribute("aria-pressed", String(btn.dataset.mode === mode));
  }
  els.modeDesc.textContent = MODE_DESC[mode] ?? "";
}

async function loadMode() {
  const { mode } = await chrome.storage.local.get("mode");
  renderMode(mode in MODE_DESC ? mode : "transparent");
}

async function setMode(mode) {
  renderMode(mode);
  await chrome.storage.local.set({ mode });
}

// Arrow keys move through the segment like a native radio group.
function onSegmentKey(event) {
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (step === 0) return;
  event.preventDefault();
  const btns = els.segmentBtns;
  const current = btns.findIndex((b) => b.getAttribute("aria-pressed") === "true");
  const next = btns[(current + step + btns.length) % btns.length];
  next.focus();
  setMode(next.dataset.mode);
}

// ── Daemon probe ───────────────────────────────────────────────────────────

function setStatus(state, bannerMessage) {
  els.statusDot.dataset.state = state;
  if (bannerMessage) {
    els.bannerText.textContent = bannerMessage;
    els.banner.hidden = false;
  } else {
    els.banner.hidden = true;
  }
}

function fillValue(el, text) {
  el.textContent = text;
  el.classList.remove("is-placeholder");
}

async function probeDaemon(baseUrl) {
  let health;
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`health ${res.status}`);
    health = await res.json();
  } catch {
    // Daemon down: the content script fails open to cloud, so surface that here.
    setStatus("dead", "Daemon unreachable — routing defaults to cloud.");
    return;
  }

  if (health.model) fillValue(els.modelName, health.model);

  // Daemon up but Ollama down means classify works yet local generation can't.
  if (health.ollama_reachable) {
    setStatus("live");
  } else {
    setStatus("dead", "Ollama unreachable — local generation unavailable.");
  }

  await loadStats(baseUrl);
}

async function loadStats(baseUrl) {
  let stats;
  try {
    const res = await fetch(`${baseUrl}/stats`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return;
    stats = await res.json();
  } catch {
    return;
  }

  fillValue(els.statLocal, String(stats.local_routes ?? 0));
  const latency = stats.average_latency_ms;
  fillValue(els.statLatency, latency == null ? "—" : `${Math.round(latency)}ms`);
}

// ── Boot ───────────────────────────────────────────────────────────────────

async function init() {
  const { daemonBaseUrl } = await chrome.storage.local.get("daemonBaseUrl");

  // Apply theme and mode before revealing the body — no flash of wrong colours.
  await Promise.all([loadTheme(), loadMode()]);
  els.body.classList.add("loaded");

  els.themeToggle.addEventListener("click", cycleTheme);
  els.segment.addEventListener("keydown", onSegmentKey);
  for (const btn of els.segmentBtns) {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  }

  // Storage is seeded on install; an unseeded profile just shows the dead state.
  if (!daemonBaseUrl) {
    setStatus("dead", "Daemon endpoint not configured.");
    return;
  }
  els.endpoint.textContent = daemonBaseUrl.replace(/^https?:\/\//, "");

  // Fire-and-forget: the UI is already interactive.
  probeDaemon(daemonBaseUrl);
}

init();

// Local conversations are stored in this profile and nowhere else — the provider never saw
// the prompts. Clearing is therefore destructive in a way clearing a cloud history is not,
// so it confirms first.
// Transcripts are stored one key per conversation; the legacy aggregate key is counted and
// cleared too in case no chat page has run the migration yet.
const TX_PREFIX = "localgate:tx:";
const LEGACY_KEY = "localgate:transcripts";
const clearButton = document.getElementById("clear-history");

async function localCount() {
  const all = await chrome.storage.local.get(null);
  const rekeyed = Object.keys(all)
    .filter((k) => k.startsWith(`${TX_PREFIX}local:`)).length;
  const legacy = Object.keys(all[LEGACY_KEY] || {})
    .filter((k) => k.startsWith("local:")).length;
  return rekeyed + legacy;
}

async function refreshClearButton() {
  const count = await localCount();
  clearButton.textContent = count ? `Clear ${count}` : "None";
  clearButton.disabled = !count;
}

clearButton?.addEventListener("click", async () => {
  const count = await localCount();
  if (!count) return;
  const noun = count === 1 ? "conversation" : "conversations";
  if (!confirm(`Delete ${count} local ${noun}? They are not stored anywhere else.`)) return;
  const all = await chrome.storage.local.get(null);
  const doomed = Object.keys(all).filter((k) => k.startsWith(TX_PREFIX));
  if (all[LEGACY_KEY]) doomed.push(LEGACY_KEY);
  if (doomed.length) await chrome.storage.local.remove(doomed);
  await refreshClearButton();
});

void refreshClearButton();
