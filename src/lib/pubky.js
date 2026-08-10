// Pubky layer for reader highlights — Pubky Auth sign-in (approve in Pubky Ring)
// + homeserver storage. Highlights are stored under the reader's OWN homeserver
// at /pub/timechain.wiki/highlights/<pathKey>/<id>.json, so they follow the
// reader across devices. Lazy-loaded by the annotation controller: the SDK is a
// ~1.7 MB WASM bundle, kept off the page for anyone who isn't using Pubky.
import { Pubky, AuthFlowKind } from "@synonymdev/pubky";
import qrcode from "qrcode-generator";

const APP = "timechain.wiki";
// Two namespaces, both requested at sign-in: `/pub/` is world-readable (the
// social model), `/priv/` is readable ONLY by the owner — verified against our
// own homeserver 2026-08-10: an anonymous HTTP read gets 401, the public storage
// API refuses it, and a DIFFERENT signed-in user is refused too.
const CAPS = `/pub/${APP}/:rw,/priv/${APP}/:rw`;
const AUTH_KEY = "tw:pubky";

let pubky = null;   // Pubky facade client
let session = null; // active Session

function client() { if (!pubky) pubky = new Pubky(); return pubky; }

export function storedUser() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); } catch { return null; }
}
function store(u) { try { localStorage.setItem(AUTH_KEY, JSON.stringify(u)); } catch {} }

export function shortId(pk) {
  const s = pk.replace(/^pubky:?/, "");
  return s.length > 14 ? s.slice(0, 6) + "…" + s.slice(-4) : s;
}

// One directory per page so read-back lists just this page's highlights.
export function pageKey(path) {
  return path.replace(/^\/|\/$/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "home";
}
const dir = (k, priv) => `${priv ? "/priv" : "/pub"}/${APP}/highlights/${k}/`;
const file = (k, id, priv) => dir(k, priv) + id + ".json";

export function hasSession() { return !!session; }

// Whether THIS session may use the private namespace. Two independent gates,
// both learned the hard way:
//   • the SESSION — sign-ins from before private storage existed hold `/pub/`
//     only, and the reader re-approves in Pubky Ring to upgrade;
//   • the HOMESERVER — Pubky Ring can grant `/priv/` while the reader's
//     homeserver still refuses it (Synonym's production homeserver 403s with
//     "Writing to directories other than '/pub/' is forbidden" — the feature is
//     ALPHA and they sensibly keep it off in production; verified on a real
//     RadVladdy sign-in 2026-08-10). That refusal is remembered per identity so
//     the UI stops promising a Private that can never succeed.
export function canPrivate() {
  if (!session) return false;
  if (privUnsupported()) return false;
  try {
    return (session.info.capabilities || []).some((c) => c.startsWith("/priv/") && c.includes("w"));
  } catch { return false; }
}

// Keyed off the stored identity, not the live session — the "your homeserver
// doesn't do this" fact stays true across a lapsed cookie, and the panel must
// not fall back to blaming the sign-in when the session merely needs restoring.
const privId = () => userId() || String((storedUser() || {}).pubky || "").replace(/^pubky:?/, "");
export function privUnsupported() {
  try { const id = privId(); return !!id && localStorage.getItem("tw:pkpriv-unsup:" + id) === "1"; } catch { return false; }
}
function markPrivUnsupported() { try { const id = privId(); if (id) localStorage.setItem("tw:pkpriv-unsup:" + id, "1"); } catch {} }
const isPrivRefusal = (e) => /other than '\/pub\/'/i.test(String(e?.message || e));

// The in-flight flow's authorization URL is stashed here so a sign-in that
// completes after an app-switch to Pubky Ring (which backgrounds or reloads this
// tab) can be RESUMED on return — the relay message lives ~5 min. sessionStorage,
// per the SDK's own guidance, and it holds a short-lived secret.
const PENDING_KEY = "tw:pubky-pending";
export function hasPending() { try { return !!sessionStorage.getItem(PENDING_KEY); } catch { return false; } }
function savePending(url) { try { sessionStorage.setItem(PENDING_KEY, url); } catch {} }
export function cancelPending() { try { sessionStorage.removeItem(PENDING_KEY); } catch {} }

async function sessionToUser(s) {
  session = s;
  let exported = "";
  try { exported = s.export(); } catch {}
  const pk = s.info.publicKey.toString();
  const u = { method: "pubky", pubky: pk, label: shortId(pk), export: exported };
  store(u);
  cancelPending();
  return u;
}

// Begin a sign-in flow. Returns the pubkyauth:// URL (deep link) + a QR SVG to
// show, and a promise that resolves to the user once approved in Pubky Ring
// (this resolves in-page — desktop QR scan, or mobile if the tab stays alive).
export function startLogin() {
  // SDK 0.10 renamed startAuthFlow → startCookieAuthFlow. (There is also a newer
  // grant-backed flow with self-refreshing sessions, which would remove the
  // "sign in again when the cookie lapses" friction — a deliberate follow-up, not
  // folded into this upgrade.)
  const flow = client().startCookieAuthFlow(CAPS, AuthFlowKind.signin());
  const url = flow.authorizationUrl;
  savePending(url);
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const qrSvg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  const approved = flow.awaitApproval().then(sessionToUser);
  return { url, qrSvg, approved };
}

// Pick up an approval that landed while the tab was backgrounded/reloaded during
// the hand-off to Pubky Ring. Returns the user, or null if nothing's pending / it
// expired. Clears the pending marker on a terminal failure so it won't retry.
export async function resume() {
  let url;
  try { url = sessionStorage.getItem(PENDING_KEY); } catch {}
  if (!url) return null;
  try {
    const flow = client().resumeCookieAuthFlow(url);
    return await flow.awaitApproval().then(sessionToUser);
  } catch { cancelPending(); return null; }
}

// Re-establish a saved session (needs the homeserver cookie still present). Keeps
// the user shown as signed-in even if the session can't be restored — a write
// will surface the need to re-approve.
export async function restore() {
  const u = storedUser();
  if (!u) return null;
  if (u.export) {
    // 0.10 moved restore onto the facade (was the static `Session.restore`).
    try { session = await client().restoreSession(u.export); } catch {}
  }
  return u;
}

export async function logout() {
  try { if (session) await session.signout(); } catch {}
  session = null;
  try { localStorage.removeItem(AUTH_KEY); } catch {}
}

// `link` optionally carries the reader's Nostr key (see accounts.js § cross-rail
// identity pointer), so the aggregator can tell that a highlight published to
// both rails came from one person rather than two strangers. Only honoured when
// the Nostr event names this Pubky id back — a one-sided claim proves nothing.
// `priv` writes to the owner-only namespace instead of the public one. The
// cross-rail pointer is deliberately OMITTED from private records: it names the
// reader's Nostr key, and a private highlight should not carry a second identity
// even in storage only the owner can read.
export async function publish(hl, key, link, priv) {
  if (!session) throw new Error("not-signed-in");
  if (priv && !canPrivate()) {
    throw new Error(privUnsupported()
      ? "your homeserver doesn't offer private storage yet"
      : "this Pubky session predates private storage — sign in again to enable it");
  }
  const rec = {
    id: hl.id,
    url: hl.url,
    anchor: hl.anchor,
    note: hl.note || "",
    createdAt: hl.createdAt || Date.now(),
    ...(!priv && link && link.nostrPubkey ? { nostrPubkey: link.nostrPubkey } : {}),
  };
  try {
    await session.storage.putJson(file(key, hl.id, priv), rec);
  } catch (e) {
    if (priv && isPrivRefusal(e)) {
      markPrivUnsupported();
      throw new Error("your homeserver doesn't offer private storage yet — the highlight stays on this device");
    }
    throw e;
  }
  if (!priv) ensureSharedMarker().catch(() => {});
  return hl.id;
}

// Deletes from whichever namespace the highlight lives in. Unlike the public
// case this must NOT swallow errors — a failed delete leaves the record up, and
// the caller blocks the local delete so the reader can retry.
export async function remove(id, key, priv) {
  if (!session) return;
  await session.storage.delete(file(key, id, priv));
}

// Move a highlight between namespaces (public ⇄ private). Writes the new copy
// BEFORE deleting the old one, so a failure midway leaves the highlight present
// rather than destroyed.
export async function setVisibility(hl, key, toPrivate) {
  if (!session) throw new Error("not-signed-in");
  await publish(hl, key, null, toPrivate);
  try { await remove(hl.id, key, !toPrivate); } catch {}
  return hl.id;
}

// ── shared-layer opt-in ───────────────────────────────────────────────────
// The site's shared-highlights layer is built by a nightly crawl, and Pubky has
// no firehose — the crawler can only read users it KNOWS about. Opting in
// writes a marker to the reader's OWN homeserver: only the key holder can write
// there, so the marker is unforgeable, and the crawler includes a key only when
// the marker is present. (A relay hint tells the crawler the key exists at all —
// see nostr.js publishPubkyShareHint — but the marker is the authority; deleting
// it opts back out no matter who hints what.)
const SHARE_FILE = `/pub/${APP}/share.json`;

export async function getShared() {
  if (!session) return null; // unknown
  try { const m = await session.storage.getJson(SHARE_FILE); return !!(m && m.share); }
  catch (e) { return /404/.test(String(e?.message || e)) ? false : null; }
}

export async function setShared(on) {
  if (!session) throw new Error("not-signed-in");
  if (on) await session.storage.putJson(SHARE_FILE, { v: 1, share: true, since: Date.now() });
  else await session.storage.delete(SHARE_FILE);
  return on;
}

// Publishing a PUBLIC highlight through this site is the opt-in (the UI says
// so): the phone-book marker and the relay hint ride along automatically, once
// per identity rather than per highlight. The flag is set only after both
// landed, so a failure retries on the next public publish. Withdrawing =
// making highlights private again: the crawler lists actual public records,
// so an empty public folder shows nothing regardless of the marker.
async function ensureSharedMarker() {
  const id = userId();
  if (!id) return;
  const K = "tw:pkshared:" + id;
  try { if (localStorage.getItem(K) === "1") return; } catch {}
  await session.storage.putJson(SHARE_FILE, { v: 1, share: true, since: Date.now() });
  await (await import("./nostr.js")).publishPubkyShareHint(id);
  try { localStorage.setItem(K, "1"); } catch {}
}

export function userId() {
  return session ? session.info.publicKey.toString().replace(/^pubky:?/, "") : null;
}

// Suggestions over the Pubky rail. Pubky has no way to SEND anyone a message,
// so the suggestion is written into the reader's OWN homeserver and the wiki's
// nightly sweep collects it from registered keys — same phone book, same
// consent mechanics as shared highlights (the marker+hint ride along). The
// honest trade-off vs the Nostr path: nightly latency instead of hourly, and
// no private variant (a record we can read is by definition not private).
export async function publishSuggestion({ exact, text, path }) {
  if (!session) throw new Error("not-signed-in");
  const id = "s-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  await session.storage.putJson(`/pub/${APP}/suggestions/${id}.json`, {
    id, url: path, exact: String(exact || ""), text: String(text || ""), createdAt: Date.now(),
  });
  ensureSharedMarker().catch(() => {});
  return id;
}

const toPath = (u) => (u.startsWith("pubky://") ? u.replace(/^pubky:\/\/[^/]+/, "") : (u.startsWith("/pub/") ? u : null));

// Resolve a pubky.app profile `image` value to a displayable URL. In pubky.app an
// avatar is a two-step chain: profile.image → a /files/<id> record (JSON) whose
// `src` points at the actual /blobs/<id> bytes, tagged with a content_type.
async function resolveImage(img) {
  if (!img || typeof img !== "string") return null;
  if (/^(https?:|data:)/.test(img)) return img;
  let path = toPath(img);
  if (!path) return null;
  let contentType = "";
  try {
    if (/\/files\//.test(path)) {
      const rec = await session.storage.getJson(path);            // file record → blob
      if (rec && rec.src) { contentType = rec.content_type || ""; path = toPath(rec.src) || path; }
    }
    const bytes = await session.storage.getBytes(path);
    return URL.createObjectURL(new Blob([bytes], contentType ? { type: contentType } : undefined));
  } catch { return null; }
}

// The reader's pubky.app profile (name + avatar), if they have one. Best-effort:
// many Pubky Ring users have no pubky.app profile, so null is normal.
export async function getProfile() {
  if (!session) return null;
  try {
    const prof = await session.storage.getJson("/pub/pubky.app/profile.json");
    if (!prof) return null;
    return { name: prof.name || null, image: await resolveImage(prof.image) };
  } catch { return null; }
}

// list() gives `pubky://<user>/pub/…` URLs; storage calls want the bare path.
const toStoragePath = (u) => u.replace(/^pubky:\/\/[^/]+/, "");

// Read every .json record under a directory, tagged with the namespace it came
// from. `pubky` = public on the homeserver, `pubkyp` = owner-only — mirroring
// the nostr/nostrp pair so the rest of the app treats them uniformly.
// Returns NULL when the listing could not be obtained — deliberately distinct
// from an empty array. The caller prunes local copies of records the server no
// longer returns, so "the request failed" must never be mistaken for "you have
// none": that would delete the reader's own highlights off their device. This
// matters most for /priv/, which upstream ships as ALPHA and warns may "change
// or disappear" — the exact scenario where list() starts failing.
async function readDir(path, priv, withUrl) {
  let urls = [];
  try { urls = await session.storage.list(path); } catch { return null; }
  const files = [];
  for (const u of urls) {
    const p = toStoragePath(u);
    if (p.endsWith(".json")) files.push(p);
    else {
      // A recursive list may return per-page directories instead of files.
      try { (await session.storage.list(p)).forEach((v) => { const q = toStoragePath(v); if (q.endsWith(".json")) files.push(q); }); } catch {}
    }
  }
  const out = [];
  for (const p of files) {
    try {
      const rec = await session.storage.getJson(p);
      out.push({
        id: p.split("/").pop().replace(/\.json$/, ""),
        source: priv ? "pubkyp" : "pubky",
        ...(withUrl ? { url: rec.url || "/" } : {}),
        anchor: rec.anchor,
        note: rec.note || "",
        createdAt: rec.createdAt || 0,
        nostrPubkey: rec.nostrPubkey || null,
      });
    } catch {}
  }
  return out;
}

// Everything under the wiki's highlights tree, across all pages and BOTH
// namespaces.
export async function fetchAll() {
  if (!session) return [];
  const pub = await readDir(`/pub/${APP}/highlights/`, false, true);
  const priv = canPrivate() ? await readDir(`/priv/${APP}/highlights/`, true, true) : [];
  return [...(pub || []), ...(priv || [])];
}

// Fetch this page's highlights from the homeserver — public and private.
// `answered` reports which namespaces actually responded; only those may be
// used to prune local copies (see readDir).
export async function fetch(key) {
  if (!session) return { items: [], answered: {} };
  const pub = await readDir(dir(key, false), false, false);
  const priv = canPrivate() ? await readDir(dir(key, true), true, false) : null;
  return {
    items: [...(pub || []), ...(priv || [])],
    answered: { pubky: pub !== null, pubkyp: priv !== null },
  };
}
