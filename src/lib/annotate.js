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
let pubkyMod = null; // lazy-loaded ./pubky.js
let user = null; // { method:'nip07'|'nip46'|'pubky', … }

const $ = (sel, r = document) => r.querySelector(sel);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

async function nlib() { if (!nostr) nostr = await import("./nostr.js"); return nostr; }
async function plib() { if (!pubkyMod) pubkyMod = await import("./pubky.js"); return pubkyMod; }
const isPubky = () => user && user.method === "pubky";
const userLabel = () => (user && user.name) || (isPubky() ? user.label : nshort(user.npub));

// Read the stored session without pulling in the heavy sync bundles — keeps them
// off the page for the common anonymous/logged-out reader. Either backend's key.
function storedAuth() {
  try { return JSON.parse(localStorage.getItem("tw:pubky") || localStorage.getItem("tw:auth") || "null"); }
  catch { return null; }
}
// Publish/fetch/ready routed to whichever backend the session uses.
async function remotePublish(h) {
  if (isPubky()) { const p = await plib(); return p.publish(h, p.pageKey(store.pageUrl())); }
  return (await nlib()).publish(h, store.pageUrl());
}
async function remoteReady() {
  return isPubky() ? (await plib()).hasSession() : (await nlib()).hasSigner();
}

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

function hidePop() { pop.hidden = true; pop.classList.remove("tw-pop--bar"); document.body.classList.remove("tw-selecting"); }
function showPop(rect) {
  pop.hidden = false;
  // On touch, the OS paints its own selection toolbar (Copy/Share/…) right where
  // an anchored popover would sit and covers it. So dock ours as a bar at the
  // bottom of the screen, clear of the OS toolbar; the body class hides the FAB
  // while it shows so the two don't overlap.
  if (coarsePointer()) {
    pop.classList.add("tw-pop--bar");
    pop.style.left = pop.style.top = "";
    document.body.classList.add("tw-selecting");
    return;
  }
  pop.classList.remove("tw-pop--bar");
  document.body.classList.remove("tw-selecting");
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
  if (user && (await remoteReady())) publishOne(hl.id);
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

const saveNote = debounce(async (id, val) => {
  store.upsert({ id, note: val });
  list = store.all();
  // If this highlight is synced to Pubky, an edited note re-writes the homeserver
  // record (putJson overwrites). Nostr kind-9802 events are immutable, so a Nostr
  // highlight's note edit stays local.
  const hl = list.find((x) => x.id === id);
  if (hl && hl.source === "pubky" && isPubky()) {
    try { const p = await plib(); await p.publish(hl, p.pageKey(store.pageUrl())); }
    catch (e) { toast("Couldn't save the note to Pubky: " + (e.message || e), true); }
  }
}, 500);

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
    const synced = h.source === "nostr" || h.source === "pubky";
    const badgeText = h.source === "nostr" ? "Nostr" : h.source === "pubky" ? "Pubky" : "On this device";
    const badge = el("span", "tw-badge " + (synced ? "n" : "l"), badgeText);
    foot.appendChild(badge);
    const spacer = el("span", "tw-sp"); foot.appendChild(spacer);

    if (user && h.source === "local") {
      const pub = el("button", "tw-mini", "Publish");
      pub.title = `Publish to ${isPubky() ? "Pubky" : "Nostr"}`;
      pub.addEventListener("click", () => publishOne(h.id, pub));
      foot.appendChild(pub);
    }
    const del = el("button", "tw-mini danger", "Delete");
    del.addEventListener("click", async () => {
      const hl = list.find((x) => x.id === h.id);
      // Delete from the server too when synced — otherwise it'd reappear on the
      // next sync. Pubky: remove the homeserver record (block local delete if that
      // fails, so the user can retry). Nostr: best-effort kind-5 deletion.
      if (hl && hl.source === "pubky") {
        try { const p = await plib(); await p.remove(hl.id, p.pageKey(store.pageUrl())); }
        catch (e) { toast("Couldn't delete from Pubky: " + (e.message || e), true); return; }
      } else if (hl && hl.source === "nostr") {
        try { await (await nlib()).deleteEvent(hl.id); } catch {}
      }
      store.remove(h.id); list = store.all(); if (activeId === h.id) activeId = null; renderPanel(); paint();
    });
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

// A centered sign-in chooser (Pubky + Nostr), opened from the top chip or the
// panel's "Sign in" button. A modal rather than an anchored dropdown so it works
// on mobile and can't be dismissed by the same click that opened it.
const signinModal = el("div", "tw-dialog tw-signin");
signinModal.hidden = true;
signinModal.innerHTML = `
  <div class="tw-dialog-bg" data-siclose></div>
  <div class="tw-dialog-panel" role="dialog" aria-modal="true">
    <h3 class="tw-dialog-t">Sign in to sync</h3>
    <p class="tw-dialog-d">Your highlights already save on this device. Sign in to sync them across your devices — your keys, your data, no account with us.</p>
    <div class="tw-signin-opts">
      <button type="button" data-m="pubky"><b>Pubky</b><span>Approve in Pubky Ring (QR or deep link)</span></button>
      <button type="button" data-m="nip07"><b>Nostr — browser extension</b><span>Alby, nos2x (desktop)</span></button>
      <button type="button" data-m="bunker"><b>Nostr — Amber / remote signer</b><span>Paste a bunker:// string</span></button>
    </div>
    <div class="tw-dialog-actions"><button type="button" class="tw-dialog-cancel" data-siclose>Cancel</button></div>
  </div>`;
document.body.appendChild(signinModal);
function closeSignin() { signinModal.hidden = true; }
signinModal.querySelectorAll("[data-siclose]").forEach((e) => e.addEventListener("click", closeSignin));
signinModal.querySelectorAll("button[data-m]").forEach((b) => b.addEventListener("click", () => { closeSignin(); doLogin(b.dataset.m); }));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !signinModal.hidden) closeSignin(); });

// Account menu — shown when the chip is clicked while signed in (previously this
// signed out on the first click, with no way to see the account or cancel).
const accountModal = el("div", "tw-dialog tw-account");
accountModal.hidden = true;
accountModal.innerHTML = `
  <div class="tw-dialog-bg" data-acclose></div>
  <div class="tw-dialog-panel" role="dialog" aria-modal="true">
    <div class="tw-acc-head">
      <div class="tw-acc-av"></div>
      <div class="tw-acc-meta"><b class="tw-acc-name"></b><span class="tw-acc-id mono"></span></div>
    </div>
    <p class="tw-dialog-d tw-acc-sub"></p>
    <div class="tw-dialog-actions">
      <button type="button" class="tw-dialog-cancel" data-acclose>Close</button>
      <button type="button" class="tw-dialog-ok tw-acc-out">Sign out</button>
    </div>
  </div>`;
document.body.appendChild(accountModal);
function closeAccount() { accountModal.hidden = true; }
accountModal.querySelectorAll("[data-acclose]").forEach((e) => e.addEventListener("click", closeAccount));
accountModal.querySelector(".tw-acc-out").addEventListener("click", () => { closeAccount(); doLogout(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !accountModal.hidden) closeAccount(); });

async function openAccount() {
  const how = isPubky() ? "Pubky" : user.method === "nip46" ? "Nostr · remote signer" : "Nostr · browser extension";
  accountModal.querySelector(".tw-acc-name").textContent = user.name || userLabel();
  accountModal.querySelector(".tw-acc-id").textContent = isPubky() ? user.pubky : (user.npub || "");
  accountModal.querySelector(".tw-acc-sub").textContent = `Signed in with ${how}. Your highlights sync to your account; they also stay on this device.`;
  const av = accountModal.querySelector(".tw-acc-av");
  av.style.backgroundImage = user.avatar ? `url("${user.avatar}")` : "";
  av.textContent = user.avatar ? "" : (user.name || userLabel() || "•").slice(0, 1).toUpperCase();
  accountModal.hidden = false;
  if (isPubky() && user.name === undefined) loadProfile(); // fetch once, lazily
}

function openSignin() { if (user) { openAccount(); return; } signinModal.hidden = false; }

// Pull the reader's Pubky profile (name + avatar) and refresh the chip + menu.
async function loadProfile() {
  try {
    const prof = await (await plib()).getProfile();
    user.name = prof?.name || null;
    user.avatar = prof?.image || null;
    renderChip();
    if (!accountModal.hidden) openAccount();
  } catch { user.name = null; }
}

// A styled input dialog — replaces the browser's native prompt() so every popup
// matches the site. askInput() resolves to the trimmed value or null (cancel).
const dialog = el("div", "tw-dialog");
dialog.hidden = true;
dialog.innerHTML = `
  <div class="tw-dialog-bg" data-cancel></div>
  <div class="tw-dialog-panel" role="dialog" aria-modal="true">
    <h3 class="tw-dialog-t"></h3>
    <p class="tw-dialog-d"></p>
    <input class="tw-dialog-in" type="text" autocomplete="off" spellcheck="false" />
    <div class="tw-dialog-actions">
      <button type="button" class="tw-dialog-cancel" data-cancel>Cancel</button>
      <button type="button" class="tw-dialog-ok"></button>
    </div>
  </div>`;
document.body.appendChild(dialog);
let dialogResolve = null;
function closeDialog(val) { dialog.hidden = true; const r = dialogResolve; dialogResolve = null; r && r(val); }
{
  const input = dialog.querySelector(".tw-dialog-in");
  dialog.querySelector(".tw-dialog-ok").addEventListener("click", () => closeDialog(input.value.trim() || null));
  dialog.querySelectorAll("[data-cancel]").forEach((e) => e.addEventListener("click", () => closeDialog(null)));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); closeDialog(input.value.trim() || null); }
    else if (e.key === "Escape") { e.preventDefault(); closeDialog(null); }
  });
}
function askInput({ title, desc, placeholder = "", confirmText = "Confirm" }) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    dialog.querySelector(".tw-dialog-t").textContent = title;
    dialog.querySelector(".tw-dialog-d").textContent = desc;
    dialog.querySelector(".tw-dialog-ok").textContent = confirmText;
    const input = dialog.querySelector(".tw-dialog-in");
    input.value = ""; input.placeholder = placeholder;
    dialog.hidden = false;
    requestAnimationFrame(() => input.focus());
  });
}

// Pubky sign-in dialog: a QR to scan with Pubky Ring (desktop) + a deep link to
// open it on the same device (mobile), while we wait for approval.
const pkModal = el("div", "tw-dialog tw-pkdlg");
pkModal.hidden = true;
pkModal.innerHTML = `
  <div class="tw-dialog-bg" data-pkcancel></div>
  <div class="tw-dialog-panel" role="dialog" aria-modal="true">
    <h3 class="tw-dialog-t">Sign in with Pubky</h3>
    <p class="tw-dialog-d">Scan with the Pubky Ring app — or, on this phone, tap Open Pubky Ring to approve.</p>
    <div class="tw-qr"></div>
    <a class="tw-pk-open" href="#">Open Pubky Ring</a>
    <div class="tw-pk-wait"><span class="tw-spin"></span>Waiting for approval…</div>
    <div class="tw-dialog-actions"><button type="button" class="tw-dialog-cancel" data-pkcancel>Cancel</button></div>
  </div>`;
document.body.appendChild(pkModal);
pkModal.querySelectorAll("[data-pkcancel]").forEach((e) => e.addEventListener("click", cancelPubky));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pkModal.hidden) cancelPubky(); });
function showPubkyDialog(url, qrSvg) {
  pkModal.querySelector(".tw-qr").innerHTML = qrSvg;
  pkModal.querySelector(".tw-pk-open").href = url;
  pkModal.hidden = false;
}
function hidePubkyDialog() { pkModal.hidden = true; }
async function cancelPubky() { hidePubkyDialog(); try { (await plib()).cancelPending(); } catch {} }

// Single completion path for a Pubky sign-in — whichever finishes first (the
// in-page flow, a resume on return, or a resume on load). Guarded to run once.
async function onSignedIn(u) {
  if (!u || user) return;
  user = u;
  hidePubkyDialog();
  renderChip();
  renderAuth();
  toast("Signed in with Pubky — your highlights will sync.");
  loadProfile();      // name + avatar, async; refreshes the chip when it arrives
  await syncRemote();
}

function renderChip() {
  if (!chip) return;
  chip.classList.toggle("tw-in", !!user); // lets CSS show the label on mobile when signed in
  if (user) {
    const badge = user.avatar
      ? `<span class="tw-chip-av" style="background-image:url('${user.avatar}')"></span>`
      : `<span class="dot on"></span>`;
    chip.innerHTML = badge + (userLabel() || "Signed in");
    const how = isPubky() ? "Pubky" : user.method === "nip46" ? "remote signer" : "extension";
    chip.title = "Signed in with " + how + " — click to sign out";
  } else {
    chip.innerHTML = `<span class="dot"></span>Sign in · Nostr / Pubky`;
    chip.title = "Sign in to sync highlights";
  }
}
function nshort(npub) { return npub.slice(0, 10) + "…" + npub.slice(-4); }

async function doLogin(method) {
  closeSignin();
  try {
    if (method === "pubky") {
      // Non-blocking: show the QR/deep link, then complete via onSignedIn — which
      // may fire here (desktop / tab stays alive) OR from the resume paths in
      // init()/visibilitychange when the tab was backgrounded during the app switch.
      const p = await plib();
      const { url, qrSvg, approved } = p.startLogin();
      showPubkyDialog(url, qrSvg);
      approved.then(onSignedIn).catch(() => {});
      return;
    } else {
      const lib = await nlib();
      if (method === "nip07") user = await lib.loginNip07();
      else if (method === "bunker") {
        const s = await askInput({
          title: "Connect a remote signer",
          desc: "Paste the connect string from your signer app (in Amber: Connect → copy the bunker:// link).",
          placeholder: "bunker://…",
          confirmText: "Connect",
        });
        if (!s) return;
        user = await lib.loginBunker(s);
      } else return;
    }
    renderChip();
    renderAuth();
    await syncRemote();
    toast(`Signed in with ${isPubky() ? "Pubky" : "Nostr"} — your highlights will sync.`);
  } catch (e) {
    if (e.code === "no-extension" || e.message === "no-extension")
      toast("No Nostr extension found. Install Alby or nos2x, or use Amber on mobile.", true);
    else toast("Sign-in failed: " + (e.message || e), true);
  }
}
async function doLogout() {
  try { if (isPubky()) await (await plib()).logout(); else (await nlib()).logout(); } catch {}
  user = null;
  renderChip(); renderAuth();
  toast("Signed out. Highlights stay saved on this device.");
}

function renderAuth() {
  const box = panel.querySelector(".tw-auth");
  if (!box) return;
  if (user) {
    const unpublished = list.filter((h) => h.source === "local").length;
    box.innerHTML = `<div class="tw-signed"><span class="dot on"></span>Signed in · <b>${userLabel()}</b></div>`;
    if (unpublished > 0) {
      const b = el("button", "tw-syncbtn", `Publish ${unpublished} to ${isPubky() ? "Pubky" : "Nostr"}`);
      b.addEventListener("click", () => publishAll(b));
      box.appendChild(b);
    }
  } else {
    box.innerHTML = `<button type="button" class="tw-syncbtn ghost">Sign in to sync across devices</button>`;
    box.querySelector("button").addEventListener("click", openSignin);
  }
}

async function publishOne(id, btn) {
  const h = list.find((x) => x.id === id);
  if (!h) return;
  if (btn) { btn.disabled = true; btn.textContent = "Publishing…"; }
  try {
    const newId = await remotePublish(h);           // Pubky keeps the id; Nostr returns an event id
    const src = isPubky() ? "pubky" : "nostr";
    if (newId && newId !== id) {
      store.remove(id);
      store.upsert({ ...h, id: newId, source: src, published: true, pubkey: user.pubky || user.pubkey });
      if (activeId === id) activeId = newId;
    } else {
      store.upsert({ id, source: src, published: true, pubkey: user.pubky || user.pubkey });
    }
    list = store.all();
    renderPanel(); paint();
  } catch (e) {
    toast("Publish failed: " + (e.message || e), true);
    if (btn) { btn.disabled = false; btn.textContent = "Publish"; }
  }
}
async function publishAll(btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Publishing…"; }
  for (const h of list.filter((x) => x.source === "local")) await publishOne(h.id);
  renderPanel();
}

async function syncRemote() {
  if (!user) return;
  try {
    let incoming;
    if (isPubky()) { const p = await plib(); incoming = await p.fetch(p.pageKey(store.pageUrl())); }
    else { incoming = await (await nlib()).fetch(user.pubkey, store.pageUrl()); }
    if (incoming && incoming.length) { list = store.merge(incoming); paint(); renderPanel(); }
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
  // Auth chip works on every page — opens the sign-in chooser, or signs out.
  if (chip) chip.addEventListener("click", openSignin);
  // Only pull in a sync bundle if there's a session to restore; anonymous readers
  // get the highlighter with no heavy download.
  const saved = storedAuth();
  if (saved) {
    user = saved;
    try {
      if (saved.method === "pubky") { await (await plib()).restore(); loadProfile(); }
      else (await nlib()).restore();
    } catch {}
  }
  renderChip();

  // A Pubky sign-in that finished after the hand-off to Pubky Ring (tab
  // backgrounded or reloaded) is picked up here on return: resume on load, and
  // again whenever the tab becomes visible, until we're signed in.
  const pubkyPending = () => { try { return !!sessionStorage.getItem("tw:pubky-pending"); } catch { return false; } };
  const tryResume = () => { if (!user && pubkyPending()) plib().then((p) => p.resume()).then(onSignedIn).catch(() => {}); };
  if (pubkyPending()) tryResume();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tryResume(); });
  window.addEventListener("focus", tryResume);

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

  // If a session restored, pull this page's highlights from the sync backend.
  if (user) syncRemote();
}
