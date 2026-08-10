// Shared highlights — the reading side of the "phone book". Renders OTHER
// readers' public highlights from the pre-baked nightly aggregate at
// /shared/p/<pageKey>.json (built by scripts/shared-crawl.mjs on the box):
// a static fetch, no relay or homeserver query ever leaves the browser, and an
// anonymous reader pays one small JSON request — or none, when the page has no
// shared highlights (the fetch 404s and that's the whole cost).
//
// Both rails arrive merged into ONE visual layer: a highlight is a highlight,
// whether it lives on Nostr relays or a Pubky homeserver; attribution shows
// whichever profile exists. Passages paint directly over the article text —
// they are, verifiably, the wiki's own words (the crawler drops anything that
// isn't). Notes appear ONLY in the side panel, never inline, and only after
// editorial review.
//
// One on/off toggle (default on), remembered per device. Turning it off clears
// the paint and the panel; the switch also lives in the highlights panel's
// settings so it stays reachable while off.
import { resolve, hitTest } from "./anchor.js";

// Keep in sync with pageKey() in src/lib/pubky.js and scripts/shared-crawl.mjs.
const pageKey = (path) => path.replace(/^\/|\/$/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "home";

const VIEW_KEY = "tw:sharedview";
const supportsHL = typeof globalThis.Highlight === "function" && !!(globalThis.CSS && CSS.highlights);

let root = null;
let hooks = { ownHit: () => null, ownIds: () => new Set(), closeOwn: () => {} };
let items = [];        // [{id, rail, anchor:{...}, note?, createdAt, author}]
let fetched = false;
let activeId = null;

export function isOn() { try { return localStorage.getItem(VIEW_KEY) !== "0"; } catch { return true; } }
function setPref(v) { try { localStorage.setItem(VIEW_KEY, v ? "1" : "0"); } catch {} }

const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

// ── data ──────────────────────────────────────────────────────────────────
async function load() {
  if (fetched) return;
  fetched = true;
  try {
    const path = location.pathname.replace(/\/$/, "") || "/";
    const res = await fetch(`/shared/p/${pageKey(path)}.json`);
    if (!res.ok) return;                       // 404 = no shared highlights here
    const data = await res.json();
    items = (data.items || []).map((i) => ({
      id: i.id, rail: i.rail, note: i.note || "", createdAt: i.createdAt || 0, author: i.author || {},
      anchor: { exact: i.exact, prefix: i.prefix || "", suffix: i.suffix || "", pos: i.pos || 0 },
    }));
  } catch {}
}

// A reader's own published highlight comes back in the aggregate; painting it
// twice would stack two tints. The own layer wins.
function visible() {
  const own = hooks.ownIds();
  return items.filter((i) => !own.has(i.id.replace(/^n:/, "")) && !own.has(i.id.replace(/^p:[^:]+:/, "")));
}

// ── paint ─────────────────────────────────────────────────────────────────
function paint() {
  if (!supportsHL || !root) return;
  if (!isOn()) { CSS.highlights.delete("tw-shared"); CSS.highlights.delete("tw-shared-on"); return; }
  const base = [], active = [];
  for (const h of visible()) {
    const r = resolve(root, h.anchor);
    if (!r) continue;
    (h.id === activeId ? active : base).push(r);
  }
  CSS.highlights.set("tw-shared", new Highlight(...base));
  CSS.highlights.set("tw-shared-on", new Highlight(...active));
}

// ── side panel ────────────────────────────────────────────────────────────
let panel = null;
function buildPanel() {
  if (panel) return panel;
  panel = el("aside", "tw-panel tw-shared-panel");
  panel.hidden = true;
  panel.innerHTML = `
    <div class="tw-p-head">
      <div><b>Readers' highlights</b><span class="tw-count">0</span></div>
      <button type="button" class="tw-x" aria-label="Close">✕</button>
    </div>
    <div class="tw-sh-toggle"></div>
    <div class="tw-list"></div>
    <div class="tw-p-foot">Public highlights left by other readers, straight from their own accounts — Nostr's open relays, and Pubky homeservers whose owners opted in. Refreshed nightly. Every passage is verified to be this wiki's own text, and notes are read by the editors before they appear. Nobody's private highlights are here — private means private.</div>`;
  document.body.appendChild(panel);
  panel.querySelector(".tw-x").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) close(); });

  const row = el("div", "tw-seg-row");
  row.appendChild(el("span", "tw-toggle-t", "Shared layer"));
  const seg = el("div", "tw-seg");
  for (const o of [{ v: true, label: "On" }, { v: false, label: "Off" }]) {
    const b = el("button", "tw-seg-b" + (o.v === isOn() ? " on" : ""), o.label);
    b.type = "button";
    b.dataset.v = o.v ? "1" : "0";
    b.addEventListener("click", () => setOn(o.v));
    seg.appendChild(b);
  }
  row.appendChild(seg);
  panel.querySelector(".tw-sh-toggle").appendChild(row);
  return panel;
}

function railLabel(i) {
  if (i.rail === "both") return "Nostr + Pubky";
  return i.rail === "pubky" ? "Pubky" : "Nostr";
}
function authorLabel(a) {
  if (a.name) return a.name;
  if (a.npub) return a.npub.slice(0, 10) + "…" + a.npub.slice(-4);
  if (a.pubky) return a.pubky.slice(0, 6) + "…" + a.pubky.slice(-4);
  return "a reader";
}

function renderPanel() {
  const p = buildPanel();
  const list = visible();
  p.querySelector(".tw-count").textContent = list.length;
  const box = p.querySelector(".tw-list");
  box.innerHTML = "";
  if (!isOn()) {
    box.appendChild(el("p", "tw-empty", "The shared layer is off. Turn it on to see what other readers highlighted on these pages."));
    return;
  }
  if (!list.length) {
    box.appendChild(el("p", "tw-empty", "No shared highlights on this page yet. Publish one of yours and it can be the first — the layer refreshes nightly."));
    return;
  }
  for (const h of list) {
    const item = el("div", "tw-item" + (h.id === activeId ? " on" : ""));
    item.dataset.id = h.id;
    const quote = el("blockquote", "tw-quote", h.anchor.exact);
    quote.addEventListener("click", () => scrollTo(h.id));
    item.appendChild(quote);
    if (h.note) item.appendChild(el("p", "tw-sh-note", h.note));
    const foot = el("div", "tw-sh-author");
    if (h.author.picture) {
      const av = el("span", "tw-sh-av");
      av.style.backgroundImage = `url("${h.author.picture}")`;
      foot.appendChild(av);
    }
    foot.appendChild(el("b", null, authorLabel(h.author)));
    foot.appendChild(el("span", "tw-sh-via", "via " + railLabel(h)));
    if (h.createdAt) foot.appendChild(el("span", "tw-sh-when", new Date(h.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })));
    item.appendChild(foot);
    box.appendChild(item);
  }
}

function open() { hooks.closeOwn(); renderPanel(); buildPanel().hidden = false; }
export function close() { if (panel) panel.hidden = true; activeId = null; paint(); }
export function isOpen() { return !!panel && !panel.hidden; }

function scrollTo(id) {
  activeId = id;
  paint(); renderPanel();
  const h = visible().find((x) => x.id === id);
  const r = h && resolve(root, h.anchor);
  if (r) r.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ── toggle (used here and by the settings row in annotate.js) ─────────────
export async function setOn(v) {
  setPref(v);
  if (v) { await load(); paint(); } else paint();
  if (panel && !panel.hidden) renderPanel();
  if (panel) panel.querySelectorAll(".tw-sh-toggle .tw-seg-b").forEach((b) => b.classList.toggle("on", (b.dataset.v === "1") === v));
}

// ── wiring ────────────────────────────────────────────────────────────────
export async function init(rootEl, h) {
  root = rootEl;
  hooks = { ...hooks, ...h };
  if (!root || !supportsHL) return;
  if (!isOn()) return;          // stays lazy: nothing fetched while off
  await load();
  if (!items.length) return;
  paint();

  // Click a shared highlight → open the side panel on it. The reader's OWN
  // highlights win a contested click — their layer paints on top too.
  root.addEventListener("click", (e) => {
    if (!isOn()) return;
    const sel = getSelection();
    if (sel && !sel.isCollapsed) return;
    if (hooks.ownHit(e.clientX, e.clientY)) return;
    const hit = hitTest(root, visible(), e.clientX, e.clientY);
    if (hit) { open(); scrollTo(hit.id); }
  });

  window.addEventListener("resize", () => paint());
}

// Repaint after the own-layer changes (publish/delete can change what's hidden).
export function refresh() { if (fetched) { paint(); if (panel && !panel.hidden) renderPanel(); } }
