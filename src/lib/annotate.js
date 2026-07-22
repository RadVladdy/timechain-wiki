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

// Reader-controlled sync defaults. Highlights: "private" (encrypted NIP-78 app
// data — synced, feed-invisible, readable only by the reader) | "public"
// (NIP-84 highlights — the social model) | "off" (this device only).
// Suggestions: "private" (NIP-17 encrypted DM) | "public" (kind-1 note).
// Every highlight card can override the default per item.
const MODE_KEY = "tw:syncmode", SUG_KEY = "tw:sugmode";
function syncMode() {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v) return v;
    const old = localStorage.getItem("tw:autosync"); // migrate the old binary toggle
    return old === "0" ? "off" : old === "1" ? "public" : "private";
  } catch { return "private"; }
}
function sugMode() { try { return localStorage.getItem(SUG_KEY) || "private"; } catch { return "private"; } }
const setMode = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

const TIP_TEXT = "Private sync stores highlights + notes as encrypted app data on Nostr relays (NIP-78, kind 30078) — synced across your devices, readable only by you, never shown in anyone's feed. Public uses Nostr's highlight format (NIP-84, kind 9802; your note travels inside the same event) — highlight-aware apps like Amethyst or Highlighter show these on your profile/feed. Off keeps everything on this device. Suggestions: Private sends an encrypted direct message to the wiki's editors (NIP-17 gift wrap — invisible to feeds, sender hidden from relays); Public sends a regular note (kind 1) that appears on your feed. Pubky highlights save to your own homeserver (public today — private storage is on Pubky's roadmap). Private modes need a signer that supports encryption (most modern extensions + Amber do).";
function infoTip() {
  const s = el("span", "tw-info");
  s.tabIndex = 0;
  s.setAttribute("role", "note");
  s.setAttribute("aria-label", "About publishing");
  s.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.3" fill="currentColor"/></svg>`;
  const tip = el("span", "tw-tip", TIP_TEXT);
  s.appendChild(tip);
  return s;
}
const MODE_TOASTS = {
  private: "New highlights sync privately — encrypted, invisible to feeds.",
  public: "New highlights publish publicly to your account as you make them.",
  off: "New highlights stay on this device until you act on them.",
};
function segRow(label, key, options, withTip) {
  const row = el("div", "tw-seg-row");
  row.dataset.key = key;
  row.appendChild(el("span", "tw-toggle-t", label));
  const seg = el("div", "tw-seg");
  const cur = key === MODE_KEY ? syncMode() : sugMode();
  for (const o of options) {
    const b = el("button", "tw-seg-b" + (o.v === cur ? " on" : ""), o.label);
    b.type = "button";
    b.dataset.v = o.v;
    b.addEventListener("click", () => {
      setMode(key, o.v);
      document.querySelectorAll(`.tw-seg-row[data-key="${key}"] .tw-seg-b`).forEach((x) => x.classList.toggle("on", x.dataset.v === o.v));
      if (key === MODE_KEY) toast(MODE_TOASTS[o.v]);
      else toast(o.v === "private" ? "Suggestions send as encrypted DMs — nothing on your feed." : "Suggestions send as public notes on your feed.");
    });
    seg.appendChild(b);
  }
  row.appendChild(seg);
  if (withTip) row.appendChild(infoTip());
  return row;
}
function settingsBlock(compact) {
  const box = el("div", "tw-settings");
  box.appendChild(segRow("Highlights", MODE_KEY, [
    { v: "private", label: "Private" }, { v: "public", label: "Public" }, { v: "off", label: "Off" },
  ], true));
  box.appendChild(segRow("Suggestions", SUG_KEY, [
    { v: "private", label: "Private" }, { v: "public", label: "Public" },
  ], false));
  return box;
}
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

// pending deep-link target (#twhl=<id>) — resolved opportunistically as data arrives
let deepLinkId = null, deepLinkUntil = 0;
function tryDeepLink() {
  if (!deepLinkId) return true;
  if (ranges.has(deepLinkId)) {
    const id = deepLinkId; deepLinkId = null;
    openPanel(); scrollTo(id);
    return true;
  }
  return false;
}

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
  if (user && (await remoteReady())) {
    if (isPubky()) { publishOne(hl.id); return; }
    const m = syncMode();
    if (m === "public") publishOne(hl.id);
    else if (m === "private") {
      const n = await nlib();
      if (n.canEncrypt()) {
        store.upsert({ id: hl.id, source: "nostrp", published: true, pubkey: user.pubkey });
        list = store.all(); renderPanel(); paint();
        queuePrivateSync();
      } else {
        toast("Your signer can't encrypt (NIP-44) — highlight kept on this device. Use Publish for public, or a signer like Alby/Amber for private sync.", true);
      }
    }
  }
}

// Private sync: the page's private highlights live in ONE encrypted, replaceable
// Nostr app-data event — any change re-writes the whole page blob (debounced).
async function privateSyncNow() {
  if (!user || isPubky()) return;
  const n = await nlib();
  if (!n.canEncrypt()) return;
  const items = store.all().filter((h) => h.source === "nostrp");
  await n.privateSave(store.pageUrl(), items);
}
const queuePrivateSync = debounce(() => privateSyncNow().catch((e) => toast("Private sync failed: " + (e.message || e), true)), 1200);

// ── side panel ───────────────────────────────────────────────────────────
const panel = el("aside", "tw-panel");
panel.hidden = true;
panel.innerHTML = `
  <div class="tw-p-head">
    <div><b>Your highlights</b><span class="tw-count">0</span><a class="tw-all-link" href="/highlights">All pages →</a></div>
    <button type="button" class="tw-x" aria-label="Close">✕</button>
  </div>
  <div class="tw-auth"></div>
  <div class="tw-list"></div>
  <div class="tw-p-foot">Signed out, highlights and notes stay on this device — private. Signed in, they publish to your own Nostr or Pubky account as you make them — publicly, like posts. "Suggest" sends your note to the wiki's editors — privately (encrypted DM) or publicly, your choice. Signed in, the Highlights setting picks the default for new highlights: Private (encrypted sync), Public (feed-visible), or Off; every card can override it.</div>`;
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
// Hang the FAB at the reading column's lower-right corner — over the text itself,
// clear of the "On this page" rail. The column's right edge shifts with the grid's
// gap/rail/padding clamps, so measure it rather than guess in CSS. Below the
// two-column breakpoint (rail hidden) fall back to the CSS corner default.
function positionFab() {
  if (root && window.innerWidth > 900) {
    const r = root.getBoundingClientRect();
    fab.style.right = Math.max(14, Math.round(window.innerWidth - r.right)) + "px";
  } else {
    fab.style.right = "";
  }
}

const dirtyNostr = new Set(); // Nostr highlights whose note changed but isn't re-published yet

const saveNote = debounce(async (id, val) => {
  store.upsert({ id, note: val });
  list = store.all();
  // Pubky: an edited note re-writes the homeserver record live (putJson overwrites
  // the same path — cheap and idempotent). Nostr events are immutable, so we don't
  // churn a new event per keystroke; the edit is re-published once, on blur.
  const hl = list.find((x) => x.id === id);
  if (hl && hl.source === "pubky" && isPubky()) {
    try { const p = await plib(); await p.publish(hl, p.pageKey(store.pageUrl())); }
    catch (e) { toast("Couldn't save the note to Pubky: " + (e.message || e), true); }
  }
  if (hl && hl.source === "nostrp") queuePrivateSync();
}, 500);

// Nostr edit = publish a fresh kind-9802 with the new note and delete the old one
// (kind-9802 is immutable). Runs on blur, only if the note actually changed.
async function republishNostrIfDirty(id) {
  if (!dirtyNostr.has(id)) return;
  dirtyNostr.delete(id);
  const hl = list.find((x) => x.id === id);
  if (!hl || hl.source !== "nostr" || !user || isPubky()) return;
  try {
    const n = await nlib();
    const newId = await n.publish(hl, store.pageUrl());
    n.deleteEvent(id).catch(() => {});
    store.remove(id);
    store.upsert({ ...hl, id: newId });
    if (activeId === id) activeId = newId;
    list = store.all();
    renderPanel(); paint();
  } catch (e) { toast("Couldn't update the note on Nostr: " + (e.message || e), true); }
}

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
    ta.addEventListener("input", (e) => { autogrow(ta); saveNote(h.id, e.target.value); if (h.source === "nostr") dirtyNostr.add(h.id); });
    ta.addEventListener("blur", () => republishNostrIfDirty(h.id));
    item.appendChild(ta);

    const foot = el("div", "tw-item-foot");
    // Status is plain text with a dot — deliberately not pill/button-shaped, so
    // it can't be mistaken for an action. Saving is automatic; this just states
    // where the highlight lives right now.
    const statusText = h.source === "nostr" ? "Public on Nostr" : h.source === "pubky" ? "Public on Pubky"
      : h.source === "nostrp" ? "Private · synced" : "On this device";
    const statusCls = h.source === "nostrp" ? "priv" : (h.source === "nostr" || h.source === "pubky") ? "pub" : "loc";
    const status = el("span", "tw-status " + statusCls);
    status.appendChild(el("i", "tw-status-dot"));
    status.appendChild(document.createTextNode(statusText));
    status.title = h.source === "nostrp"
      ? "Synced across your devices as encrypted data — only you can read it; never in feeds."
      : statusCls === "pub"
        ? "Published to your own account — publicly visible. Saves automatically."
        : "Saved only in this browser — private. Saves automatically.";
    foot.appendChild(status);
    const spacer = el("span", "tw-sp"); foot.appendChild(spacer);

    const sug = el("button", "tw-mini", h.suggestedAt ? "Sent ✓" : "Suggest");
    sug.title = h.suggestedAt
      ? "Sent to the wiki's editors"
      : "Send this passage + your note to the wiki's editors (public, signed as you)";
    if (h.suggestedAt) sug.disabled = true;
    else sug.addEventListener("click", () => suggestOne(h.id, sug));
    foot.appendChild(sug);

    // per-card visibility overrides
    if (user && (h.source === "local" || h.source === "nostrp")) {
      const pub = el("button", "tw-mini", "Publish");
      pub.title = h.source === "nostrp"
        ? "Make THIS highlight public — publishes it to your account (visible in feeds)"
        : `Publish publicly to your own ${isPubky() ? "Pubky" : "Nostr"} account`;
      pub.addEventListener("click", () => publishOne(h.id, pub));
      foot.appendChild(pub);
    }
    if (user && !isPubky() && h.source === "local") {
      const pv = el("button", "tw-mini", "Private");
      pv.title = "Sync THIS highlight privately — encrypted, cross-device, never in feeds";
      pv.addEventListener("click", async () => {
        const n = await nlib();
        if (!n.canEncrypt()) { toast("Your signer can't encrypt (NIP-44) — private sync unavailable.", true); return; }
        store.upsert({ id: h.id, source: "nostrp", published: true, pubkey: user.pubkey });
        list = store.all(); renderPanel(); paint(); queuePrivateSync();
      });
      foot.appendChild(pv);
    }
    if (user && !isPubky() && h.source === "nostr") {
      const mp = el("button", "tw-mini", "Make private");
      mp.title = "Retract from public: asks relays to delete the public event and keeps the highlight in your encrypted private sync";
      mp.addEventListener("click", async () => {
        const n = await nlib();
        if (!n.canEncrypt()) { toast("Your signer can't encrypt (NIP-44) — private sync unavailable.", true); return; }
        try { n.deleteEvent(h.id).catch(() => {}); } catch {}
        store.upsert({ id: h.id, source: "nostrp" });
        list = store.all(); renderPanel(); paint(); queuePrivateSync();
        toast("Retracted — deletion requested from relays (best-effort; copies may persist). Now in private sync.");
      });
      foot.appendChild(mp);
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
      if (hl && hl.source === "nostrp") queuePrivateSync();
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
    <p class="tw-dialog-d">Your highlights already save on this device, privately. Sign in to sync them across your devices — your keys, your data, no account with us. Synced highlights live on your own public account, like posts.</p>
    <div class="tw-si-toggle"></div>

    <div class="tw-signin-sect">
      <div class="tw-signin-label">Nostr</div>
      <div class="tw-signin-opts">
        <button type="button" data-m="bunker"><b>Amber / remote signer</b><span>Paste a bunker:// string — mobile</span></button>
        <button type="button" data-m="nip07"><b>Browser extension</b><span>Alby, nos2x — desktop</span></button>
      </div>
      <a class="tw-signin-what" href="/learn/nostr">New to Nostr? What it is + how to get set up →</a>
    </div>

    <div class="tw-signin-sect">
      <div class="tw-signin-label">Pubky</div>
      <div class="tw-signin-opts">
        <button type="button" data-m="pubky"><b>Approve in Pubky Ring</b><span>Scan a QR, or open the app on your phone</span></button>
      </div>
      <a class="tw-signin-what" href="/learn/pubky">New to Pubky? What it is + how to get set up →</a>
    </div>
    <div class="tw-dialog-actions"><button type="button" class="tw-dialog-cancel" data-siclose>Cancel</button></div>
  </div>`;
document.body.appendChild(signinModal);
signinModal.querySelector(".tw-si-toggle").appendChild(settingsBlock(true));
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
    <a class="tw-acc-all" href="/highlights">My highlights — all pages →</a>
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
  accountModal.querySelector(".tw-acc-sub").textContent = `Signed in with ${how}. New highlights publish to your account as you make them — publicly. They also stay on this device.`;
  const av = accountModal.querySelector(".tw-acc-av");
  av.style.backgroundImage = user.avatar ? `url("${user.avatar}")` : "";
  av.textContent = user.avatar ? "" : (user.name || userLabel() || "•").slice(0, 1).toUpperCase();
  accountModal.hidden = false;
  if (user.name === undefined) loadProfile(); // fetch once, lazily
}

function openSignin() { if (user) { openAccount(); return; } signinModal.hidden = false; }

// Pull the reader's profile (name + avatar) from whichever backend they used —
// Pubky's pubky.app profile or a Nostr kind-0 — and refresh the chip + menu.
async function loadProfile() {
  try {
    const prof = isPubky()
      ? await (await plib()).getProfile()
      : await (await nlib()).fetchProfile(user.pubkey);
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

// Confirm dialog for the suggestion send — states plainly that the send is
// public and signed, and previews exactly what will be sent.
const confirmModal = el("div", "tw-dialog tw-confirm");
confirmModal.hidden = true;
confirmModal.innerHTML = `
  <div class="tw-dialog-bg" data-cfcancel></div>
  <div class="tw-dialog-panel" role="dialog" aria-modal="true">
    <h3 class="tw-dialog-t"></h3>
    <p class="tw-dialog-d"></p>
    <blockquote class="tw-quote tw-cf-quote"></blockquote>
    <p class="tw-cf-note"></p>
    <div class="tw-cf-choice" hidden></div>
    <div class="tw-dialog-actions">
      <button type="button" class="tw-dialog-cancel" data-cfcancel>Cancel</button>
      <button type="button" class="tw-dialog-ok"></button>
    </div>
  </div>`;
document.body.appendChild(confirmModal);
let confirmResolve = null, confirmChoice = null;
function closeConfirm(ok) { confirmModal.hidden = true; const r = confirmResolve; confirmResolve = null; r && r({ ok, choice: confirmChoice }); }
confirmModal.querySelectorAll("[data-cfcancel]").forEach((e) => e.addEventListener("click", () => closeConfirm(false)));
confirmModal.querySelector(".tw-dialog-ok").addEventListener("click", () => closeConfirm(true));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !confirmModal.hidden) closeConfirm(false); });
function askConfirm({ title, desc, quote, note, confirmText, choice }) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    confirmModal.querySelector(".tw-dialog-t").textContent = title;
    confirmModal.querySelector(".tw-dialog-d").textContent = desc;
    confirmModal.querySelector(".tw-cf-quote").textContent = quote || "";
    confirmModal.querySelector(".tw-cf-note").textContent = note || "";
    confirmModal.querySelector(".tw-dialog-ok").textContent = confirmText;
    const box = confirmModal.querySelector(".tw-cf-choice");
    box.innerHTML = ""; box.hidden = !choice; confirmChoice = null;
    if (choice) {
      confirmChoice = choice.def;
      for (const o of choice.options) {
        const card = el("button", "tw-choice" + (o.v === choice.def ? " on" : "") + (o.disabled ? " off" : ""));
        card.type = "button";
        card.appendChild(el("b", null, o.label));
        card.appendChild(el("span", null, o.disabled ? "Needs a signer with encryption (Alby, Amber…)" : o.hint));
        if (!o.disabled) card.addEventListener("click", () => {
          confirmChoice = o.v;
          box.querySelectorAll(".tw-choice").forEach((c) => c.classList.remove("on"));
          card.classList.add("on");
        });
        box.appendChild(card);
      }
    }
    confirmModal.hidden = false;
  });
}

// Send a highlight + its note to the wiki's Suggestions inbox — a public Nostr
// note signed by the reader (Nostr-only: Pubky has no way to receive messages).
async function suggestOne(id, btn) {
  const h = list.find((x) => x.id === id);
  if (!h) return;
  const text = (h.note || "").trim();
  if (!text) {
    toast("Write your suggestion in the note box first, then hit Suggest.", true);
    setActive(id);
    const ta = $(`.tw-item[data-id="${id}"] textarea`);
    ta && ta.focus();
    return;
  }
  if (!user) {
    toast("Suggestions are sent publicly, signed by you — sign in with Nostr first.");
    openSignin();
    return;
  }
  if (isPubky()) {
    toast("Suggestions travel over Nostr, and Pubky can't receive messages yet — sign in with a Nostr method to send one.", true);
    return;
  }
  const n = await nlib();
  const canPriv = n.canEncrypt();
  const res = await askConfirm({
    title: "Send this to the wiki?",
    desc: "Every suggestion is reviewed by hand before anything changes.",
    quote: h.anchor.exact,
    note: text,
    confirmText: "Send suggestion",
    choice: {
      def: canPriv ? sugMode() : "public",
      options: [
        { v: "private", label: "Privately", hint: "Encrypted DM to the editors — nothing on your feed; sender hidden from relays.", disabled: !canPriv },
        { v: "public", label: "Publicly", hint: "A regular Nostr note on your feed, signed as you." },
      ],
    },
  });
  if (!res || !res.ok) return;
  btn.disabled = true; btn.textContent = "Sending…";
  try {
    const payload = { exact: h.anchor.exact, text, path: store.pageUrl() };
    const evId = res.choice === "private"
      ? await n.publishSuggestionPrivate(payload)
      : await n.publishSuggestion(payload);
    store.upsert({ id, suggestedAt: Date.now(), suggestedEvent: evId, suggestedVia: res.choice });
    list = store.all();
    renderPanel();
    toast(res.choice === "private"
      ? "Suggestion sent privately — thank you. The editors read every one."
      : "Suggestion sent — thank you. The editors read every one.");
  } catch (e) {
    toast("Couldn't send the suggestion: " + (e.message || e), true);
    btn.disabled = false; btn.textContent = "Suggest";
  }
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
    const initial = (userLabel() || "•").trim().slice(0, 1).toUpperCase();
    const badge = user.avatar
      ? `<span class="tw-chip-av" style="background-image:url('${user.avatar}')"></span>`
      : `<span class="tw-chip-av tw-chip-av--i">${initial}</span>`;
    chip.innerHTML = badge + `<span class="tw-chip-label">${userLabel() || "Signed in"}</span>`;
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
    loadProfile();      // Nostr kind-0 name + picture, async
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
    if (isPubky()) box.appendChild(el("div", "tw-pk-note", "Highlights save to your Pubky homeserver. Suggestions travel over Nostr."));
    else box.appendChild(settingsBlock(false));
    if (unpublished > 0) {
      const b = el("button", "tw-syncbtn", `Publish ${unpublished} to ${isPubky() ? "Pubky" : "Nostr"} (public)`);
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
    queuePrivateSync(); // if it was in the private blob, drop it there
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
    else {
      const n = await nlib();
      const pub = await n.fetch(user.pubkey, store.pageUrl());
      const priv = n.canEncrypt() ? await n.privateFetch(store.pageUrl()) : [];
      incoming = [...(pub || []), ...(priv || [])];
    }
    if (incoming && incoming.length) { list = store.merge(incoming); paint(); renderPanel(); }
    tryDeepLink();
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
      if (saved.method === "pubky") await (await plib()).restore();
      else (await nlib()).restore();
    } catch {}
    loadProfile();
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
  positionFab();

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

  window.addEventListener("resize", debounce(() => { paint(); positionFab(); }, 150));

  // Deep link from /highlights: #twhl=<id> → activate + scroll. The highlight
  // may only exist remotely (private blob / relay), and decryption through a
  // remote signer (Amber) can take a while — so retry after every sync pass,
  // keep a long patience window, and NEVER fail silently.
  const wanted = (location.hash.match(/^#twhl=(.+)$/) || [])[1];
  if (wanted) {
    deepLinkId = decodeURIComponent(wanted);
    deepLinkUntil = Date.now() + 45000;
    tryDeepLink();
    let n = 0;
    const iv = setInterval(() => {
      if (tryDeepLink() || Date.now() > deepLinkUntil) {
        clearInterval(iv);
        if (deepLinkId && Date.now() > deepLinkUntil) {
          const inList = list.some((h) => h.id === deepLinkId);
          toast(inList
            ? "Found the highlight, but couldn't locate its exact text on the page — it's shown in the panel."
            : "Couldn't load that highlight here yet — if it's synced, give it a moment or check you're signed in.", true);
          if (inList) { openPanel(); setActive(deepLinkId); }
          deepLinkId = null;
        }
      }
    }, 500);
  }

  // If a session restored, pull this page's highlights from the sync backend.
  if (user) syncRemote();
}
