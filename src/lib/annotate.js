// Reader annotation controller — the highlighter.com-style layer. Select text in
// an article to highlight it, add a private note, and (once signed in with Nostr)
// publish it as a NIP-84 kind-9802 event and read it back on any device. Without
// an account everything still works and persists locally. Highlights are painted
// with the CSS Custom Highlight API, so the article markup is never mutated.
import { describe, resolve, hitTest } from "./anchor.js";
import * as store from "./store.js";
import * as acct from "./accounts.js";
import * as shared from "./shared.js";
import navRank from "./nav-rank.generated.json";

let root = null;
let list = [];
let ranges = new Map(); // id -> Range (for scroll + hit-test)
const supportsHL = typeof globalThis.Highlight === "function" && !!(globalThis.CSS && CSS.highlights);

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

const TIP_TEXT = "One setting for every connected account. Private on Nostr stores highlights + notes as encrypted app data on relays (NIP-78, kind 30078) — synced across your devices, readable only by you, never shown in anyone's feed; it needs a signer that supports encryption (most modern extensions + Amber do). Private on Pubky writes to the authenticated area of your homeserver: no other user can read it, but whoever operates your homeserver can — access-controlled rather than encrypted, and experimental, so a copy always stays on this device. Some homeservers don't enable it yet; if yours refuses, Private highlights simply stay on this device. Public on Nostr uses the highlight format (NIP-84, kind 9802), so apps like Amethyst or Highlighter show these on your profile; Public on Pubky writes to the world-readable area of your homeserver. Public highlights join this site's social layer for other readers — on Pubky, publishing publicly through this site is also what adds your key to the site's opt-in reading list; make your highlights private to withdraw them. Off keeps everything on this device. You can connect both accounts at once — Publish to then chooses where new highlights go, and writing to both links the two records so other readers see one person, not two. Suggestions prefer Nostr (instant, with a private option); with only Pubky connected they save to your homeserver and the editors collect them overnight.";
const SHARED_VIEW_TIP = "Shows public highlights other readers left on these pages — marked in a different color, with any notes in a side panel. Refreshed nightly. Off hides them and shows only your own.";
function infoTip(text) {
  const s = el("span", "tw-info");
  s.tabIndex = 0;
  s.setAttribute("role", "note");
  s.setAttribute("aria-label", "About publishing");
  s.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.3" fill="currentColor"/></svg>`;
  const tip = el("span", "tw-tip", text);
  s.appendChild(tip);
  // Position on show: fixed + clamped to the viewport (the panel sits at the
  // screen edge, where a centered absolute tip clips off-screen).
  const place = () => {
    const r = s.getBoundingClientRect();
    const w = Math.min(300, Math.floor(innerWidth * 0.86));
    tip.style.width = w + "px";
    let left = Math.round(r.left + r.width / 2 - w / 2);
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    tip.style.left = left + "px";
    tip.style.top = "-9999px"; // measurable but out of the way
    requestAnimationFrame(() => {
      const th = tip.offsetHeight || 120;
      let top = r.top - th - 10;
      if (top < 8) top = Math.min(r.bottom + 10, innerHeight - th - 8);
      tip.style.top = Math.round(Math.max(8, top)) + "px";
    });
  };
  s.addEventListener("mouseenter", place);
  s.addEventListener("focus", place);
  s.addEventListener("click", place);
  return s;
}
const MODE_TOASTS = {
  private: "New highlights sync privately — encrypted, invisible to feeds.",
  public: "New highlights publish publicly to your account as you make them.",
  off: "New highlights stay on this device until you act on them.",
};
const PUBLISH_TOASTS = {
  nostr: "New highlights publish to your Nostr account.",
  pubky: "New highlights save to your Pubky homeserver.",
  both: "New highlights go to both — linked, so readers see one person, not two.",
};
// `read`/`write` are passed in because the three rows read from three different
// places (two localStorage keys and the accounts module).
function segRow(label, key, options, tipText, read, write) {
  const row = el("div", "tw-seg-row");
  row.dataset.key = key;
  row.appendChild(el("span", "tw-toggle-t", label));
  const seg = el("div", "tw-seg");
  const cur = read();
  for (const o of options) {
    const b = el("button", "tw-seg-b" + (o.v === cur ? " on" : ""), o.label);
    b.type = "button";
    b.dataset.v = o.v;
    b.addEventListener("click", () => {
      write(o.v);
      document.querySelectorAll(`.tw-seg-row[data-key="${key}"] .tw-seg-b`).forEach((x) => x.classList.toggle("on", x.dataset.v === o.v));
      if (key === MODE_KEY) toast(MODE_TOASTS[o.v]);
      else if (key === PUB_KEY) toast(PUBLISH_TOASTS[o.v]);
      else if (key === SHARED_VIEW_KEY) toast(o.v === "on" ? "Social highlights on — other readers' public highlights show on the pages." : "Social highlights off — you'll see only your own.");
      else toast(o.v === "private" ? "Suggestions send as encrypted DMs — nothing on your feed." : "Suggestions send as public notes on your feed.");
    });
    seg.appendChild(b);
  }
  row.appendChild(seg);
  if (tipText) row.appendChild(infoTip(tipText));
  return row;
}
const PUB_KEY = "tw:publishto";
const SHARED_VIEW_KEY = "tw:sharedview";
function settingsBlock(compact) {
  const box = el("div", "tw-settings");
  box.appendChild(segRow("My highlights", MODE_KEY, [
    { v: "private", label: "Private" }, { v: "public", label: "Public" }, { v: "off", label: "Off" },
  ], TIP_TEXT, syncMode, (v) => setMode(MODE_KEY, v)));
  // The shared LAYER (other readers' public highlights) — kept reachable here
  // so a reader who turned it off in the shared panel can find their way back.
  box.appendChild(segRow("Social highlights", SHARED_VIEW_KEY, [
    { v: "on", label: "On" }, { v: "off", label: "Off" },
  ], SHARED_VIEW_TIP, () => (shared.isOn() ? "on" : "off"), (v) => shared.setOn(v === "on")));
  // Only meaningful with two identities connected — with one there is nowhere else
  // for a highlight to go, and the row would be a control that does nothing.
  if (acct.hasBoth()) {
    box.appendChild(segRow("Publish to", PUB_KEY, [
      { v: "nostr", label: "Nostr" }, { v: "pubky", label: "Pubky" }, { v: "both", label: "Both" },
    ], false, acct.publishTo, acct.setPublishTo));
  }
  box.appendChild(segRow("Suggestions to the Wiki", SUG_KEY, [
    { v: "private", label: "Private" }, { v: "public", label: "Public" },
  ], false, sugMode, (v) => setMode(SUG_KEY, v)));
  return box;
}
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Identity lives in accounts.js — a reader may hold a Nostr key, a Pubky
// identity, or BOTH at once. Nothing here may assume a single "current user".
const { nlib, plib } = acct;
const signedIn = () => acct.any();

// Whether the CURRENT Pubky session was granted the private namespace. Sessions
// created before private storage shipped hold `/pub/` only, so the UI must not
// promise them a Private option that would fail on write. Tracked as a flag
// because renderAuth is synchronous and canPrivate() needs the SDK loaded.
let pubkyPrivateReady = false;
let pubkyPrivateServerNo = false;   // Ring granted /priv/ but the homeserver refuses it
async function refreshPubkyCaps() {
  if (!acct.hasPubky()) { pubkyPrivateReady = false; pubkyPrivateServerNo = false; return; }
  try {
    const p = await plib();
    pubkyPrivateReady = p.canPrivate();
    pubkyPrivateServerNo = p.privUnsupported();
  } catch { pubkyPrivateReady = false; pubkyPrivateServerNo = false; }
}
// The label shown on the chip: the identity new highlights are actually going
// to, so the face matches the destination.
function userLabel() {
  const p = acct.primary();
  return p ? acct.label(p.rail) : "";
}
// Where a public highlight is about to go, in words — "Nostr", "Pubky", or
// "Nostr + Pubky" when the reader has chosen to write to both.
function destLabel() {
  const t = acct.targets().map((r) => (r === "pubky" ? "Pubky" : "Nostr"));
  return t.join(" + ") || "Nostr";
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
  shared.refresh();   // the shared layer hides duplicates of the reader's own
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
  if (signedIn() && (await acct.ready())) {
    const m = syncMode();
    if (m === "public") { publishOne(hl.id); return; }
    if (m !== "private") return;   // "off" — stays on this device
    await makePrivate(hl.id);
  }
}

// Store a highlight privately on whichever target rails can do it — Nostr's
// encrypted app-data blob, Pubky's owner-only /priv/ namespace, or both. If no
// rail can, the highlight stays on this device and the reader is told why,
// rather than it being quietly published somewhere world-readable.
async function makePrivate(id) {
  const h = list.find((x) => x.id === id);
  if (!h) return false;
  const { rails, errors } = await acct.privateHighlight(h, store.pageUrl());
  if (!rails.length) {
    toast(errors.length
      ? `Kept on this device — ${errors[0].message}.`
      : "Kept on this device — private storage isn't available on your account.", true);
    // A refusal may have just taught us the homeserver doesn't do /priv/ at
    // all — recompute the capability so the panel copy tells the truth now,
    // not on the next sign-in.
    await refreshPubkyCaps();
    renderPanel();
    return false;
  }
  // Prefer the Nostr marker when both accepted: its blob is the cross-device
  // sync, and the Pubky copy is already written.
  const source = rails.includes("nostr") ? "nostrp" : "pubkyp";
  const pubkey = source === "nostrp" ? acct.nostr().pubkey : acct.pubky().pubky;
  store.upsert({ id, source, published: true, pubkey });
  list = store.all(); renderPanel(); paint();
  if (rails.includes("nostr")) queuePrivateSync();
  if (errors.length) toast(`Saved privately to ${rails.join(" + ")}, but ${errors[0].rail} failed: ${errors[0].message}`, true);
  return true;
}

// Private sync: the page's private highlights live in ONE encrypted, replaceable
// Nostr app-data event — any change re-writes the whole page blob (debounced).
async function privateSyncNow() {
  if (!acct.hasNostr()) return;   // encrypted app data is a Nostr capability
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
    <div><b>Your highlights</b><a class="tw-all-link" href="/highlights">All pages →</a></div>
    <div class="tw-p-actions">
      <button type="button" class="tw-x tw-cog" aria-label="Settings" title="Settings"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
      <button type="button" class="tw-x tw-close" aria-label="Close">✕</button>
    </div>
  </div>
  <div class="tw-drawer" hidden>
    <div class="tw-drawer-head"><b>Settings</b><button type="button" class="tw-x tw-drawer-x" aria-label="Close settings">✕</button></div>
    <div class="tw-auth"></div>
  </div>
  <div class="tw-list"></div>
  <div class="tw-p-foot">Your highlights save to your own account, never to us. Defaults live behind the ⚙ — each card can override them. "Suggest" sends a note to the wiki's editors.</div>`;
document.body.appendChild(panel);
const drawer = panel.querySelector(".tw-drawer");
panel.querySelector(".tw-cog").addEventListener("click", () => {
  drawer.hidden = !drawer.hidden;
  if (!drawer.hidden) renderAuth();
});
panel.querySelector(".tw-drawer-x").addEventListener("click", () => { drawer.hidden = true; });

const fab = el("button", "tw-fab");
fab.type = "button";
fab.setAttribute("aria-label", "Highlights & notes");
fab.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 20h16M6 16l9-9a2 2 0 0 1 3 0a2 2 0 0 1 0 3l-9 9H6v-3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg><span class="tw-fab-t">Highlights</span><span class="tw-fab-n"></span>`;
document.body.appendChild(fab);

let lastClose = 0;
function openPanel() { shared.close(); panel.hidden = false; renderPanel(); }
function closePanel() { panel.hidden = true; activeId = null; lastClose = Date.now(); paint(); }
function updateFab() {
  const n = list.length;
  const total = n + otherPages().length;
  // this-page / whole-wiki, so a page with none still shows the collection
  // exists ("0/1"); the badge only disappears when there's nothing anywhere.
  fab.querySelector(".tw-fab-n").textContent = total > 0 ? `${n}/${total}` : "";
}

// Every highlight this DEVICE knows about on other pages — the local store is
// the per-page cache/outbox, so this is what's been made or synced here.
// Highlights from another device appear once their page (or /highlights, which
// does the full remote fetch) has been visited.
function otherPages() {
  const cur = store.pageUrl();
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("tw:hl:")) continue;
      const url = k.slice("tw:hl:".length);
      if (url === cur) continue;
      for (const h of store.all(url)) out.push({ ...h, url });
    }
  } catch {}
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function pageLabel(url) {
  const slug = (url.match(/^\/wiki\/(.+)$/) || [])[1];
  if (!slug) return url === "/" ? "Home" : url;
  const s = slug.replace(/-/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function pageTitle() {
  const h1 = root && document.querySelector("h1");
  return (h1 && h1.textContent.trim()) || document.title.replace(/\s*—\s*TimechainWiki.*$/, "");
}

// Nav-hierarchical order for the Other-pages section: same cluster as the
// current article first, then the same section, then the rest of the wiki in
// walk order; pages outside the cluster nav (thinkers, sources) come last,
// alphabetically. Rank data is generated from the sections tree at build time.
const rankOf = (url) => { const slug = (url.match(/^\/wiki\/(.+)$/) || [])[1]; return (slug && navRank[slug]) || null; };
function hierCompare() {
  const cr = rankOf(store.pageUrl());
  const groupOf = (r) => (!r || !cr) ? 3 : (r[0] === cr[0] && r[1] === cr[1]) ? 0 : r[0] === cr[0] ? 1 : 2;
  return (a, b) => {
    const ra = rankOf(a.url), rb = rankOf(b.url);
    const ga = groupOf(ra), gb = groupOf(rb);
    if (ga !== gb) return ga - gb;
    if (ra && rb) return (ra[0] - rb[0]) || (ra[1] - rb[1]) || (ra[2] - rb[2]) || ((a.anchor?.pos ?? 0) - (b.anchor?.pos ?? 0));
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  };
}

// Card status vocabulary — the ✓ marks a state that is already saved where it
// says, so nobody re-publishes looking for confirmation.
const STATUS_TEXT = { nostr: "✓ Public on Nostr", pubky: "✓ Public on Pubky", nostrp: "✓ Private · synced", pubkyp: "✓ Private · on Pubky" };
const statusTextOf = (h) => STATUS_TEXT[h.source] || "On this device";
const statusClsOf = (h) => (h.source === "nostrp" || h.source === "pubkyp") ? "priv" : (h.source === "nostr" || h.source === "pubky") ? "pub" : "loc";
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
  if (hl && (hl.source === "pubky" || hl.source === "pubkyp") && acct.hasPubky()) {
    try { const p = await plib(); await p.publish(hl, p.pageKey(store.pageUrl()), acct.crossLink(), hl.source === "pubkyp"); }
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
  if (!hl || hl.source !== "nostr" || !acct.hasNostr()) return;
  try {
    const n = await nlib();
    const newId = await n.publish(hl, store.pageUrl(), acct.crossLink());
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

  // Action strip — the panel's one contextual doing-button. Settings live
  // behind the ⚙; this is what you might actually need right now.
  if (!signedIn()) {
    const b = el("button", "tw-syncbtn ghost", "Sign in to sync across devices");
    b.addEventListener("click", openSignin);
    box.appendChild(b);
  } else {
    const unpublished = list.filter((h) => h.source === "local").length;
    if (unpublished > 0) {
      const b = el("button", "tw-syncbtn", `Publish ${unpublished} to ${destLabel()} (public)`);
      b.addEventListener("click", () => publishAll(b));
      box.appendChild(b);
    }
  }

  box.appendChild(el("div", "tw-page-h", pageTitle()));
  if (!list.length) {
    box.appendChild(el("p", "tw-empty-line", "None on this page yet — select any text in the article to highlight it."));
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
    // where the highlight lives right now, with a ✓ once it's saved somewhere.
    const isPriv = h.source === "nostrp" || h.source === "pubkyp";
    const statusCls = statusClsOf(h);
    const status = el("span", "tw-status " + statusCls);
    status.appendChild(el("i", "tw-status-dot"));
    status.appendChild(document.createTextNode(statusTextOf(h)));
    status.title = h.source === "nostrp"
      ? "Synced across your devices as encrypted data — only you can read it; never in feeds."
      : h.source === "pubkyp"
        ? "Stored in the private area of your homeserver — no other user can read it, and it is not public. Whoever operates your homeserver still can. Pubky calls this feature experimental; a copy stays on this device."
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
    if (signedIn() && (h.source === "local" || isPriv)) {
      const pub = el("button", "tw-mini", "Publish");
      pub.title = isPriv
        ? "Make THIS highlight public — publishes it to your account (visible to others)"
        : `Publish publicly to your own ${destLabel()} account`;
      pub.addEventListener("click", () => publishOne(h.id, pub));
      foot.appendChild(pub);
    }
    // "Private" is offered whenever ANY target rail can store privately —
    // Nostr's encrypted blob or Pubky's owner-only namespace.
    if (signedIn() && h.source === "local") {
      const pv = el("button", "tw-mini", "Private");
      pv.title = "Store THIS highlight privately — readable only by you, never public";
      pv.addEventListener("click", () => makePrivate(h.id));
      foot.appendChild(pv);
    }
    // Retract a public highlight into private storage. On Pubky this is a real
    // move between namespaces; on Nostr the public event can only be ASKED to be
    // deleted, which the wording has to be honest about.
    if (h.source === "nostr" || h.source === "pubky") {
      const mp = el("button", "tw-mini", "Make private");
      mp.title = h.source === "pubky"
        ? "Move this out of the public area of your homeserver into the owner-only one"
        : "Retract from public: asks relays to delete the public event and keeps the highlight in your encrypted private sync";
      mp.addEventListener("click", async () => {
        if (h.source === "pubky") {
          if (!acct.hasPubky()) { toast("Sign in with Pubky to change this highlight.", true); return; }
          try {
            const p = await plib();
            await p.setVisibility(h, p.pageKey(store.pageUrl()), true);
            store.upsert({ id: h.id, source: "pubkyp" });
            list = store.all(); renderPanel(); paint();
            toast("Moved to the owner-only area of your homeserver — nobody else can read it now.");
          } catch (e) { toast("Couldn't make it private: " + (e.message || e), true); }
          return;
        }
        if (!acct.hasNostr()) { toast("Sign in with Nostr to change this highlight.", true); return; }
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
      if (hl && (hl.source === "pubky" || hl.source === "pubkyp")) {
        try { const p = await plib(); await p.remove(hl.id, p.pageKey(store.pageUrl()), hl.source === "pubkyp"); }
        catch (e) { toast("Couldn't delete from Pubky: " + (e.message || e), true); return; }
      } else if (hl && hl.source === "nostr") {
        // Background + timeout — signing the deletion may need an extension
        // prompt; never let a stalled prompt freeze the UI.
        nlib().then((n) => Promise.race([
          n.deleteEvent(hl.id),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000)),
        ])).catch(() => toast("Deletion request may not have reached relays (check your signer) — if it reappears, delete again.", true));
      }
      store.remove(h.id); list = store.all(); if (activeId === h.id) activeId = null; renderPanel(); paint();
      if (hl && hl.source === "nostrp") queuePrivateSync();
    });
    foot.appendChild(del);
    item.appendChild(foot);

    box.appendChild(item);
    requestAnimationFrame(() => autogrow(ta));
  }

  // Everything else this device knows about, below a separator — read-only
  // cards that jump to their page (deep link re-activates the highlight there).
  // Editing stays on the owning page, where anchors resolve and saves land.
  const others = otherPages().sort(hierCompare());
  if (others.length) {
    box.appendChild(el("div", "tw-oth-sep", "Other pages"));
    for (const h of others) {
      const href = h.url + "/#twhl=" + encodeURIComponent(h.id);
      const item = el("div", "tw-item tw-oth");
      const quote = el("blockquote", "tw-quote", h.anchor?.exact || "");
      quote.addEventListener("click", () => { location.href = href; });
      item.appendChild(quote);
      if (h.note) item.appendChild(el("p", "tw-oth-note", h.note));
      const foot = el("div", "tw-item-foot");
      const pg = el("a", "tw-oth-page", pageLabel(h.url) + " →");
      pg.href = href;
      foot.appendChild(pg);
      foot.appendChild(el("span", "tw-sp"));
      const st = el("span", "tw-status " + statusClsOf(h));
      st.appendChild(el("i", "tw-status-dot"));
      st.appendChild(document.createTextNode(statusTextOf(h)));
      foot.appendChild(st);
      item.appendChild(foot);
      box.appendChild(item);
    }
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

// Show the sign-in chooser with already-connected rails marked and disabled —
// a reader adding their second identity must not be offered a re-login to the
// one they already have (completing that flow would just be discarded).
function showSigninModal() {
  for (const sect of signinModal.querySelectorAll(".tw-signin-sect")) {
    const rail = sect.querySelector('[data-m="pubky"]') ? "pubky" : "nostr";
    const on = !!acct.get(rail);
    sect.classList.toggle("tw-sect-connected", on);
    sect.querySelectorAll("button[data-m]").forEach((b) => { b.disabled = on; });
    let badge = sect.querySelector(".tw-sect-badge");
    if (on && !badge) sect.querySelector(".tw-signin-label").appendChild(el("span", "tw-sect-badge", "connected ✓"));
    else if (!on && badge) badge.remove();
  }
  signinModal.hidden = false;
}
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
    <h3 class="tw-dialog-t tw-acc-title">Your account</h3>
    <div class="tw-acc-list"></div>
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
accountModal.querySelector(".tw-acc-out").addEventListener("click", () => { closeAccount(); doLogoutAll(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !accountModal.hidden) closeAccount(); });

// Lists every connected identity, each with its own sign-out — a reader with
// both rails needs to be able to drop one without losing the other.
async function openAccount() {
  const connected = acct.rails();
  accountModal.querySelector(".tw-acc-title").textContent = connected.length > 1 ? "Your accounts" : "Your account";
  accountModal.querySelector(".tw-acc-out").textContent = connected.length > 1 ? "Sign out of all" : "Sign out";

  const box = accountModal.querySelector(".tw-acc-list");
  box.innerHTML = "";
  for (const rail of connected) {
    const u = acct.get(rail);
    const row = el("div", "tw-acc-row");
    const av = el("div", "tw-acc-av");
    av.style.backgroundImage = u.avatar ? `url("${u.avatar}")` : "";
    av.textContent = u.avatar ? "" : (acct.label(rail) || "•").slice(0, 1).toUpperCase();
    row.appendChild(av);
    const meta = el("div", "tw-acc-meta");
    meta.appendChild(el("b", null, acct.label(rail)));
    meta.appendChild(el("span", "tw-acc-id mono", rail === "pubky" ? String(u.pubky) : (u.npub || "")));
    meta.appendChild(el("span", "tw-acc-how", howLabel(rail)));
    row.appendChild(meta);
    if (connected.length > 1) {
      const out = el("button", "tw-mini", "Sign out");
      out.addEventListener("click", async () => { await doLogout(rail); if (signedIn()) openAccount(); else closeAccount(); });
      row.appendChild(out);
    }
    box.appendChild(row);
  }

  accountModal.querySelector(".tw-acc-sub").textContent = connected.length > 1
    ? `New highlights go to ${destLabel()} as you make them, and stay on this device too. Change that in the highlights panel.`
    : `New highlights publish to your account as you make them — publicly. They also stay on this device.`;

  // The second identity must be discoverable HERE — this dialog is where a
  // signed-in reader naturally looks, and the panel's button alone wasn't found.
  let add = accountModal.querySelector(".tw-acc-add");
  if (!acct.hasBoth()) {
    if (!add) {
      add = el("button", "tw-syncbtn ghost tw-acc-add", "");
      accountModal.querySelector(".tw-acc-all").before(add);
      add.addEventListener("click", () => { closeAccount(); showSigninModal(); });
    }
    add.textContent = acct.hasPubky() ? "Also connect Nostr" : "Also connect Pubky";
    add.hidden = false;
  } else if (add) {
    add.hidden = true;
  }

  accountModal.hidden = false;
  // Fetch names/avatars once, lazily — a rail whose profile we've never looked up.
  if (connected.some((r) => acct.get(r).name === undefined)) acct.loadProfiles().then(afterProfile);
}

function openSignin() { if (signedIn()) { openAccount(); return; } showSigninModal(); }

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
  // Nostr is the preferred rail (instant, with a private variant). A
  // Pubky-only reader writes the suggestion into their OWN homeserver instead
  // and the wiki's nightly sweep collects it — slower, but it works, rather
  // than a dead end telling them to go get a different identity.
  if (!signedIn()) {
    toast("Suggestions are sent signed by you — sign in first.");
    openSignin();
    return;
  }
  const viaNostr = acct.hasNostr();
  const payload = { exact: h.anchor.exact, text, path: store.pageUrl() };
  if (viaNostr) {
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
    return;
  }
  // Pubky rail
  const res = await askConfirm({
    title: "Send this to the wiki?",
    desc: "Saves to the public area of your homeserver; the editors collect suggestions overnight, so allow a day. Every one is reviewed by hand before anything changes.",
    quote: h.anchor.exact,
    note: text,
    confirmText: "Send suggestion",
  });
  if (!res || !res.ok) return;
  btn.disabled = true; btn.textContent = "Sending…";
  try {
    const p = await plib();
    const sid = await p.publishSuggestion(payload);
    store.upsert({ id, suggestedAt: Date.now(), suggestedEvent: sid, suggestedVia: "pubky" });
    list = store.all();
    renderPanel();
    toast("Suggestion saved to your homeserver — the editors collect these nightly and read every one.");
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
// Completion path for a Pubky sign-in — whichever finishes first (the in-page
// flow, a resume on return, or a resume on load). Guarded on the PUBKY rail
// only: a reader who already has Nostr connected is adding a second identity,
// not replacing one.
async function onSignedIn(u) {
  if (!u || acct.hasPubky()) return;
  acct.set("pubky", u);
  await refreshPubkyCaps();
  hidePubkyDialog();
  renderChip();
  renderAuth();
  toast(acct.hasBoth()
    ? "Pubky connected — you now have both. Choose where new highlights go in the panel."
    : "Signed in with Pubky — your highlights will sync.");
  acct.loadProfile("pubky").then(afterProfile);
  await syncRemote();
}

// Chip shows the identity new highlights are going to; a "+1" marks the second
// connected account so having both is visible at a glance rather than hidden.
function renderChip() {
  if (!chip) return;
  chip.classList.toggle("tw-in", signedIn());
  chip.classList.toggle("tw-both", acct.hasBoth());
  if (signedIn()) {
    const p = acct.primary();
    const av = p && p.user ? p.user.avatar : null;
    const initial = (userLabel() || "•").trim().slice(0, 1).toUpperCase();
    const badge = av
      ? `<span class="tw-chip-av" style="background-image:url('${av}')"></span>`
      : `<span class="tw-chip-av tw-chip-av--i">${initial}</span>`;
    const extra = acct.hasBoth() ? `<span class="tw-chip-plus">+1</span>` : "";
    chip.innerHTML = badge + `<span class="tw-chip-label">${userLabel() || "Signed in"}</span>` + extra;
    chip.title = acct.hasBoth()
      ? `Nostr + Pubky connected — new highlights go to ${destLabel()}. Click to manage.`
      : `Signed in with ${howLabel(acct.rails()[0])} — click to manage`;
  } else {
    chip.innerHTML = `<span class="dot"></span>Sign in · Nostr / Pubky`;
    chip.title = "Sign in to sync highlights";
  }
}
function howLabel(rail) {
  if (rail === "pubky") return "Pubky";
  const u = acct.nostr();
  return u && u.method === "nip46" ? "Nostr · remote signer" : "Nostr · browser extension";
}
function afterProfile() { renderChip(); if (!accountModal.hidden) openAccount(); }
function nshort(npub) { return npub ? npub.slice(0, 10) + "…" + npub.slice(-4) : ""; }

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
      if (method === "nip07") acct.set("nostr", await lib.loginNip07());
      else if (method === "bunker") {
        const s = await askInput({
          title: "Connect a remote signer",
          desc: "Paste the connect string from your signer app (in Amber: Connect → copy the bunker:// link).",
          placeholder: "bunker://…",
          confirmText: "Connect",
        });
        if (!s) return;
        acct.set("nostr", await lib.loginBunker(s));
      } else return;
    }
    renderChip();
    renderAuth();
    acct.loadProfile("nostr").then(afterProfile);   // kind-0 name + picture, async
    await syncRemote();
    toast(acct.hasBoth()
      ? "Nostr connected — you now have both. Choose where new highlights go in the panel."
      : "Signed in with Nostr — your highlights will sync.");
  } catch (e) {
    if (e.code === "no-extension" || e.message === "no-extension")
      toast("No Nostr extension found. Install Alby or nos2x, or use Amber on mobile.", true);
    else toast("Sign-in failed: " + (e.message || e), true);
  }
}

// Sign out of ONE rail, leaving the other connected.
async function doLogout(rail) {
  await acct.logout(rail);
  await refreshPubkyCaps();
  renderChip(); renderAuth();
  toast(signedIn()
    ? `Signed out of ${rail === "pubky" ? "Pubky" : "Nostr"}. Your ${destLabel()} account is still connected.`
    : "Signed out. Highlights stay saved on this device.");
}
async function doLogoutAll() {
  await acct.logoutAll();
  await refreshPubkyCaps();
  renderChip(); renderAuth();
  toast("Signed out. Highlights stay saved on this device.");
}

function renderAuth() {
  const box = panel.querySelector(".tw-auth");
  if (!box) return;
  // This renders the ⚙ settings drawer only — set-once defaults, out of the
  // way of the list. Contextual actions (sign in, publish N) live in the list.
  if (signedIn()) {
    // Always name the network(s) — with two rails in play, a bare name doesn't
    // tell the reader where their highlights actually live.
    const railNames = acct.rails().map((r) => (r === "pubky" ? "Pubky" : "Nostr")).join(" + ");
    box.innerHTML = `<div class="tw-signed"><span class="dot on"></span>Signed in · <b>${userLabel()}</b> · ${railNames}</div>`;
    box.appendChild(settingsBlock(false));
    if (acct.hasPubky()) {
      // Inline text is reserved for the one situational warning that matters.
      if (pubkyPrivateServerNo) {
        box.appendChild(el("div", "tw-pk-note", "Your homeserver doesn't offer Private yet — Private highlights stay on this device."));
      } else if (!pubkyPrivateReady) {
        box.appendChild(el("div", "tw-pk-note", "Sign out and in again to enable Private on Pubky."));
      }
    }
    // The rail they don't have yet — also offered in the account dialog.
    if (!acct.hasBoth()) {
      const add = el("button", "tw-syncbtn ghost", acct.hasPubky() ? "Also connect Nostr" : "Also connect Pubky");
      add.addEventListener("click", () => { showSigninModal(); });
      box.appendChild(add);
    }
  } else {
    box.innerHTML = "";
    box.appendChild(settingsBlock(false));
    const b = el("button", "tw-syncbtn ghost", "Sign in to sync across devices");
    b.addEventListener("click", openSignin);
    box.appendChild(b);
  }
}

async function publishOne(id, btn) {
  const h = list.find((x) => x.id === id);
  if (!h) return;
  if (btn) { btn.disabled = true; btn.textContent = "Publishing…"; }
  try {
    // Fans out to every target rail. Nostr returns a new event id, Pubky keeps
    // the id it was given — so when both are written the record is keyed by the
    // Nostr id and carries the Pubky one alongside.
    const { ids, errors } = await acct.publishHighlight(h, store.pageUrl());
    if (!ids.nostr && !ids.pubky) throw new Error(errors.map((e) => `${e.rail}: ${e.message}`).join(" · ") || "nothing published");
    // Going public from Pubky's private namespace is a MOVE — drop the old
    // owner-only copy, or the highlight would exist in both and come back as a
    // duplicate on the next sync.
    if (h.source === "pubkyp" && ids.pubky) {
      try { const p = await plib(); await p.remove(h.id, p.pageKey(store.pageUrl()), true); } catch {}
    }

    const src = ids.nostr ? "nostr" : "pubky";
    const newId = ids.nostr || ids.pubky;
    const rec = {
      source: src,
      published: true,
      pubkey: src === "nostr" ? acct.nostr().pubkey : acct.pubky().pubky,
      ...(ids.nostr && ids.pubky ? { altRail: "pubky", altId: ids.pubky } : {}),
    };
    if (newId && newId !== id) {
      store.remove(id);
      store.upsert({ ...h, ...rec, id: newId });
      if (activeId === id) activeId = newId;
    } else {
      store.upsert({ id, ...rec });
    }
    list = store.all();
    renderPanel(); paint();
    queuePrivateSync(); // if it was in the private blob, drop it there
    // One rail succeeding while the other failed is a real outcome, not a
    // success — say which one didn't land rather than showing a silent tick.
    if (errors.length) toast(`Published to ${src === "nostr" ? "Nostr" : "Pubky"}, but ${errors.map((e) => e.rail).join(" + ")} failed: ${errors[0].message}`, true);
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
  if (!signedIn()) return;
  try {
    // Pulls from every connected rail at once — a reader with both gets their
    // Nostr and Pubky highlights merged into one list.
    const { incoming, prune } = await acct.fetchPage(store.pageUrl());
    // Self-clean ghosts: a local copy of a synced highlight the source no longer
    // returns was deleted elsewhere. Only for rails that actually ANSWERED —
    // accounts.js omits a rail that failed, so a flaky connection never deletes.
    for (const p of prune) {
      for (const h of store.all().filter((x) => x.source === p.source && !p.ids.has(x.id))) store.remove(h.id);
    }
    list = store.all();
    if (incoming.length) list = store.merge(incoming);
    paint(); renderPanel();
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
  // Restores BOTH rails if both are stored. The old code read
  // `tw:pubky || tw:auth`, so a reader with both silently lost their Nostr
  // session on every page load.
  const saved = acct.stored();
  if (saved.nostr || saved.pubky) {
    await acct.restoreAll();
    await refreshPubkyCaps();
    acct.loadProfiles().then(afterProfile);
  }
  renderChip();

  // A Pubky sign-in that finished after the hand-off to Pubky Ring (tab
  // backgrounded or reloaded) is picked up here on return: resume on load, and
  // again whenever the tab becomes visible, until we're signed in.
  const pubkyPending = () => { try { return !!sessionStorage.getItem("tw:pubky-pending"); } catch { return false; } };
  const tryResume = () => { if (!acct.hasPubky() && pubkyPending()) plib().then((p) => p.resume()).then(onSignedIn).catch(() => {}); };
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
  panel.querySelector(".tw-close").addEventListener("click", (e) => { e.stopPropagation(); closePanel(); });
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

  // Other readers' public highlights — the pre-baked shared layer. The reader's
  // own layer wins a contested click, and opening one panel closes the other.
  shared.init(root, {
    ownHit: (x, y) => hitTest(root, list, x, y),
    ownIds: () => new Set(list.map((h) => h.id)),
    closeOwn: closePanel,
  }).catch(() => {});

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

  // If any session restored, pull this page's highlights from every rail.
  if (signedIn()) syncRemote();
}
