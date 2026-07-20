// Reader annotation controller — the highlighter.com-style layer. Select text in
// an article to highlight it, add a private note, and (once signed in with Nostr)
// publish it as a NIP-84 kind-9802 event and read it back on any device. Without
// an account everything still works and persists locally. Highlights are painted
// with the CSS Custom Highlight API, so the article markup is never mutated.
import { describe, resolve, hitTest } from "./anchor.js";
import * as store from "./store.js";

let root = null;
let list = [];
let ranges = new Map(); // id -> Range (for scroll + hit-test)
const supportsHL = typeof globalThis.Highlight === "function" && !!(globalThis.CSS && CSS.highlights);
let nostr = null; // lazy-loaded ./nostr.js
let user = null;

const $ = (sel, r = document) => r.querySelector(sel);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

async function nlib() { if (!nostr) nostr = await import("./nostr.js"); return nostr; }
// Read the stored session without pulling in nostr-tools — keeps the heavy
// bundle off the page for the common anonymous/logged-out reader.
function storedAuth() { try { return JSON.parse(localStorage.getItem("tw:auth") || "null"); } catch { return null; } }

// ── painting ──────────────────────────────────────────────────────────────
function paint() {
  if (!supportsHL || !root) return;
  ranges.clear();
  const base = [], active = [];
  for (const h of list) {
    const r = resolve(root, h.anchor);
    if (!r) continue;
    ranges.set(h.id, r);
    (h.id === activeId ? active : base).push(r);
  }
  CSS.highlights.set("tw-hl", new Highlight(...base));
  CSS.highlights.set("tw-hl-on", new Highlight(...active));
  updateFab();
}

let activeId = null;
function setActive(id) { activeId = id; paint(); renderPanel(); }

// ── selection popover ───────────────────────────────────────────────────────
const pop = el("div", "tw-pop");
pop.hidden = true;
pop.innerHTML = `<button type="button" class="tw-hlbtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 20h16M6 16l9-9a2 2 0 0 1 3 0l0 0a2 2 0 0 1 0 3l-9 9H6v-3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>Highlight</button>`;
document.body.appendChild(pop);

function hidePop() { pop.hidden = true; }
function showPop(rect) {
  pop.hidden = false;
  const pw = pop.offsetWidth || 108, ph = pop.offsetHeight || 38;
  let x = rect.left + rect.width / 2 - pw / 2;
  let y = rect.top - ph - 8;
  x = Math.max(8, Math.min(x, innerWidth - pw - 8));
  if (y < 8) y = rect.bottom + 8;
  pop.style.left = x + "px";
  pop.style.top = y + "px";
}

function currentSelection() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  if (!range.toString().trim()) return null;
  return range;
}

const coarsePointer = () => matchMedia("(pointer:coarse)").matches;

async function makeHighlight(range) {
  const anchor = describe(root, range);
  if (!anchor) return;
  const hl = { id: store.uid(), url: store.pageUrl(), anchor, note: "", createdAt: Date.now(), source: "local" };
  store.upsert(hl);
  list = store.all();
  getSelection().removeAllRanges();
  hidePop();
  paint();
  updateFab();
  // On touch, don't shove the full panel over the page — confirm with a toast and
  // let the reader open it deliberately. On desktop, open it to add a note inline.
  if (coarsePointer()) {
    toast("Highlighted ✓ — tap the highlights button to add a note.");
  } else {
    openPanel();
    setActive(hl.id);
    requestAnimationFrame(() => { const ta = $(`.tw-item[data-id="${hl.id}"] textarea`); ta && ta.focus(); });
  }
  if (user && (await nlib()).hasSigner()) publishOne(hl.id);
}

// ── side panel ───────────────────────────────────────────────────────────
const panel = el("aside", "tw-panel");
panel.hidden = true;
panel.innerHTML = `
  <div class="tw-p-head">
    <div><b>Your highlights</b><span class="tw-count">0</span></div>
    <button type="button" class="tw-x" aria-label="Close">✕</button>
  </div>
  <div class="tw-auth"></div>
  <div class="tw-list"></div>
  <div class="tw-p-foot">Highlights are saved on this device. Sign in with Nostr to sync them across devices.</div>`;
document.body.appendChild(panel);

const fab = el("button", "tw-fab");
fab.type = "button";
fab.setAttribute("aria-label", "Highlights & notes");
fab.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 20h16M6 16l9-9a2 2 0 0 1 3 0a2 2 0 0 1 0 3l-9 9H6v-3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg><span class="tw-fab-t">Highlights</span><span class="tw-fab-n"></span>`;
document.body.appendChild(fab);

let lastClose = 0;
function openPanel() { panel.hidden = false; renderPanel(); }
function closePanel() { panel.hidden = true; activeId = null; lastClose = Date.now(); paint(); }
function updateFab() {
  const n = list.length;
  fab.querySelector(".tw-fab-n").textContent = n > 0 ? n : "";
  panel.querySelector(".tw-count").textContent = n;
}

const saveNote = debounce((id, val) => {
  store.upsert({ id, note: val });
  list = store.all();
}, 350);

function renderPanel() {
  renderAuth();
  const box = panel.querySelector(".tw-list");
  box.innerHTML = "";
  if (!list.length) {
    box.appendChild(el("p", "tw-empty", "No highlights yet. Select any text in the article to highlight it."));
    updateFab();
    return;
  }
  for (const h of list) {
    const item = el("div", "tw-item" + (h.id === activeId ? " on" : ""));
    item.dataset.id = h.id;

    const quote = el("blockquote", "tw-quote", h.anchor.exact);
    quote.addEventListener("click", () => scrollTo(h.id));
    item.appendChild(quote);

    const ta = el("textarea", "tw-note");
    ta.placeholder = "Add a note…";
    ta.value = h.note || "";
    ta.rows = 1;
    ta.addEventListener("input", (e) => { autogrow(ta); saveNote(h.id, e.target.value); });
    item.appendChild(ta);

    const foot = el("div", "tw-item-foot");
    const badge = el("span", "tw-badge " + (h.source === "nostr" ? "n" : "l"), h.source === "nostr" ? "Nostr" : "On this device");
    foot.appendChild(badge);
    const spacer = el("span", "tw-sp"); foot.appendChild(spacer);

    if (user && h.source !== "nostr") {
      const pub = el("button", "tw-mini", "Publish");
      pub.title = "Publish to Nostr";
      pub.addEventListener("click", () => publishOne(h.id, pub));
      foot.appendChild(pub);
    }
    const del = el("button", "tw-mini danger", "Delete");
    del.addEventListener("click", () => { store.remove(h.id); list = store.all(); if (activeId === h.id) activeId = null; renderPanel(); paint(); });
    foot.appendChild(del);
    item.appendChild(foot);

    box.appendChild(item);
    requestAnimationFrame(() => autogrow(ta));
  }
  updateFab();
}

function autogrow(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }

function scrollTo(id) {
  setActive(id);
  const r = ranges.get(id);
  if (r) r.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ── auth ────────────────────────────────────────────────────────────────
const chip = $("#signin");
const authMenu = el("div", "tw-authmenu");
authMenu.hidden = true;
authMenu.innerHTML = `
  <button type="button" data-m="nip07">Browser extension<span>Alby, nos2x — desktop</span></button>
  <button type="button" data-m="bunker">Amber / remote signer<span>Paste a bunker:// string</span></button>
  <button type="button" data-m="pubky" disabled>Pubky<span>Coming next</span></button>`;
document.body.appendChild(authMenu);

function renderChip() {
  if (!chip) return;
  if (user) {
    chip.innerHTML = `<span class="dot on"></span>${user.npub ? nshort(user.npub) : "Signed in"}`;
    chip.title = "Signed in with " + (user.method === "nip46" ? "remote signer" : "extension") + " — click to sign out";
  } else {
    chip.innerHTML = `<span class="dot"></span>Sign in · Nostr / Pubky`;
    chip.title = "Sign in to sync highlights";
  }
}
function nshort(npub) { return npub.slice(0, 10) + "…" + npub.slice(-4); }

function toggleAuthMenu() {
  if (user) { doLogout(); return; }
  authMenu.hidden = !authMenu.hidden;
  if (!authMenu.hidden && chip) {
    const r = chip.getBoundingClientRect();
    authMenu.style.top = r.bottom + 8 + "px";
    authMenu.style.right = Math.max(8, innerWidth - r.right) + "px";
  }
}

async function doLogin(method) {
  authMenu.hidden = true;
  const lib = await nlib();
  try {
    if (method === "nip07") user = await lib.loginNip07();
    else if (method === "bunker") {
      const s = prompt("Paste your bunker:// connect string (from Amber → Connect):");
      if (!s) return;
      user = await lib.loginBunker(s);
    } else return;
    renderChip();
    renderAuth();
    await syncFromNostr();
    toast("Signed in — your highlights will sync.");
  } catch (e) {
    if (e.code === "no-extension" || e.message === "no-extension")
      toast("No Nostr extension found. Install Alby or nos2x, or use Amber on mobile.", true);
    else toast("Sign-in failed: " + (e.message || e), true);
  }
}
async function doLogout() {
  (await nlib()).logout();
  user = null;
  renderChip(); renderAuth();
  toast("Signed out. Highlights stay saved on this device.");
}

function renderAuth() {
  const box = panel.querySelector(".tw-auth");
  if (!box) return;
  if (user) {
    const unpublished = list.filter((h) => h.source !== "nostr").length;
    box.innerHTML = `<div class="tw-signed"><span class="dot on"></span>Signed in · <b>${nshort(user.npub)}</b></div>`;
    if (unpublished > 0) {
      const b = el("button", "tw-syncbtn", `Publish ${unpublished} to Nostr`);
      b.addEventListener("click", () => publishAll(b));
      box.appendChild(b);
    }
  } else {
    box.innerHTML = `<button type="button" class="tw-syncbtn ghost">Sign in with Nostr to sync</button>`;
    box.querySelector("button").addEventListener("click", () => { const r = chip?.getBoundingClientRect(); authMenu.hidden = false; if (r) { authMenu.style.top = r.bottom + 8 + "px"; authMenu.style.right = Math.max(8, innerWidth - r.right) + "px"; } });
  }
}

async function publishOne(id, btn) {
  const lib = await nlib();
  const h = list.find((x) => x.id === id);
  if (!h) return;
  if (btn) { btn.disabled = true; btn.textContent = "Publishing…"; }
  try {
    const evid = await lib.publish(h, store.pageUrl());
    store.upsert({ id, source: "nostr", published: true, pubkey: user.pubkey });
    // Re-key to the event id so future fetches dedupe cleanly.
    store.remove(id);
    const updated = { ...h, id: evid, source: "nostr", published: true, pubkey: user.pubkey };
    store.upsert(updated);
    if (activeId === id) activeId = evid;
    list = store.all();
    renderPanel(); paint();
  } catch (e) {
    toast("Publish failed: " + (e.message || e), true);
    if (btn) { btn.disabled = false; btn.textContent = "Publish"; }
  }
}
async function publishAll(btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Publishing…"; }
  for (const h of list.filter((x) => x.source !== "nostr")) await publishOne(h.id);
  renderPanel();
}

async function syncFromNostr() {
  if (!user) return;
  try {
    const lib = await nlib();
    const incoming = await lib.fetch(user.pubkey, store.pageUrl());
    if (incoming.length) { list = store.merge(incoming); paint(); renderPanel(); }
  } catch {}
}

// ── tiny toast ────────────────────────────────────────────────────────────
let toastEl;
function toast(msg, warn) {
  if (!toastEl) { toastEl = el("div", "tw-toast"); document.body.appendChild(toastEl); }
  toastEl.textContent = msg;
  toastEl.className = "tw-toast show" + (warn ? " warn" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (toastEl.className = "tw-toast"), 4200);
}

// ── wiring ────────────────────────────────────────────────────────────────
export async function init() {
  // Auth chip works on every page.
  if (chip) {
    chip.addEventListener("click", (e) => { e.stopPropagation(); toggleAuthMenu(); });
    authMenu.querySelectorAll("button[data-m]").forEach((b) =>
      b.addEventListener("click", () => doLogin(b.dataset.m)));
    document.addEventListener("click", (e) => { if (!authMenu.contains(e.target) && e.target !== chip) authMenu.hidden = true; });
  }
  // Only pull in nostr-tools if there's a session to restore; anonymous readers
  // get the highlighter with no heavy bundle.
  const saved = storedAuth();
  if (saved) { user = saved; (await nlib()).restore(); }
  renderChip();

  root = $("[data-annotate]");
  if (!root) { fab.hidden = true; return; }

  list = store.all();
  paint();
  updateFab();

  fab.addEventListener("click", () => (panel.hidden ? openPanel() : closePanel()));
  panel.querySelector(".tw-x").addEventListener("click", (e) => { e.stopPropagation(); closePanel(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) closePanel(); });

  // Selection → popover. `selectionchange` (debounced) is the mobile-safe trigger:
  // unlike touchend it does NOT fire while scrolling, so the popover never chases
  // the reader down the page. mouseup keeps desktop feeling instant.
  const showForSelection = debounce(() => { const r = currentSelection(); if (r) showPop(r.getBoundingClientRect()); else hidePop(); }, 60);
  document.addEventListener("selectionchange", showForSelection);
  document.addEventListener("mouseup", showForSelection);

  // Dismiss on scroll or any outside tap — the fix for mobile, where a lingering
  // selection would otherwise leave the fixed popover hanging over the page.
  addEventListener("scroll", hidePop, { passive: true, capture: true });
  document.addEventListener("pointerdown", (e) => { if (!pop.hidden && !pop.contains(e.target)) hidePop(); }, true);

  // pointerdown (not mousedown) so the button works under touch; preventDefault
  // keeps the selection alive long enough to read it.
  pop.querySelector(".tw-hlbtn").addEventListener("pointerdown", (e) => { e.preventDefault(); const r = currentSelection(); if (r) makeHighlight(r); });

  // Click an existing highlight → open it. Skip briefly after a close so the tap
  // that dismissed the panel can't immediately reopen it on touch.
  root.addEventListener("click", (e) => {
    if (currentSelection()) return; // a fresh selection, not a click-through
    if (Date.now() - lastClose < 400) return;
    const h = hitTest(root, list, e.clientX, e.clientY);
    if (h) { openPanel(); scrollTo(h.id); }
  });

  window.addEventListener("resize", debounce(() => paint(), 150));

  // If a session restored, pull this page's highlights from relays.
  if (user) syncFromNostr();
}
