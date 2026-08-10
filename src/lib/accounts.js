// Connected accounts — the reader's identities, and the fan-out over them.
//
// The wiki used to hold ONE `user` and branch on `user.method === "pubky"`
// everywhere, which meant signing in with Pubky silently replaced a Nostr
// session (the old `storedAuth()` read `tw:pubky || tw:auth`, so Pubky always
// won). A reader can legitimately hold both: a Nostr key for the social graph
// and a Pubky identity for storage they own. This module holds both at once and
// is the only place that knows which rails exist.
//
// Storage keys are UNCHANGED (`tw:auth` = Nostr, `tw:pubky` = Pubky) so sessions
// that already exist in readers' browsers survive the upgrade.
//
// Both backends stay lazy-loaded: an anonymous reader downloads neither
// (nostr-tools is heavy, the Pubky SDK is a ~1.7 MB WASM bundle).

let nostrMod = null;
let pubkyMod = null;
export async function nlib() { if (!nostrMod) nostrMod = await import("./nostr.js"); return nostrMod; }
export async function plib() { if (!pubkyMod) pubkyMod = await import("./pubky.js"); return pubkyMod; }

// { nostr: {pubkey, npub, method, name?, avatar?} | null,
//   pubky: {pubky, label, export, name?, avatar?} | null }
const acct = { nostr: null, pubky: null };

export const nostr = () => acct.nostr;
export const pubky = () => acct.pubky;
export const hasNostr = () => !!acct.nostr;
export const hasPubky = () => !!acct.pubky;
export const hasBoth = () => !!acct.nostr && !!acct.pubky;
export const any = () => !!acct.nostr || !!acct.pubky;
export const rails = () => ["nostr", "pubky"].filter((r) => !!acct[r]);

export function get(rail) { return acct[rail] || null; }
export function set(rail, u) { acct[rail] = u || null; }
export function clear(rail) { acct[rail] = null; }

// ── where new public highlights go ────────────────────────────────────────
// Only meaningful when BOTH rails are connected. Default "nostr": it is the rail
// with real encryption today, and the one with an existing audience. "both"
// writes twice — see the cross-rail pointer below for how other readers are kept
// from seeing that as two different strangers.
const PUBLISH_KEY = "tw:publishto";
export function publishTo() {
  if (!hasBoth()) return hasPubky() ? "pubky" : "nostr";
  try { return localStorage.getItem(PUBLISH_KEY) || "nostr"; } catch { return "nostr"; }
}
export function setPublishTo(v) { try { localStorage.setItem(PUBLISH_KEY, v); } catch {} }

// Rails a new public highlight should be written to, given the current setting.
export function targets() {
  const pref = publishTo();
  if (pref === "both") return rails();
  return rails().includes(pref) ? [pref] : rails().slice(0, 1);
}

// ── cross-rail identity pointer ───────────────────────────────────────────
// A reader signed into both who publishes to both produces two records of the
// same highlight. To anyone else those look like two unrelated strangers, so
// every record carries a pointer to the reader's OTHER identity.
//
// The aggregator must only merge on a MUTUAL claim — a Nostr record naming
// pubky X and a Pubky record naming that same Nostr key. A one-sided claim is
// unverified and would let anyone assert they are someone else.
export function crossLink() {
  return {
    nostrPubkey: acct.nostr ? acct.nostr.pubkey : null,
    pubkyId: acct.pubky ? String(acct.pubky.pubky).replace(/^pubky:?/, "") : null,
  };
}

// ── display ───────────────────────────────────────────────────────────────
export function label(rail) {
  const u = acct[rail];
  if (!u) return "";
  if (u.name) return u.name;
  return rail === "pubky" ? u.label : nshort(u.npub || "");
}
function nshort(npub) { return npub ? npub.slice(0, 10) + "…" + npub.slice(-4) : ""; }

// The identity shown on the chip when both are connected — the publish target,
// so the face the reader sees matches where their highlights are going.
export function primary() {
  const t = targets()[0] || rails()[0];
  return t ? { rail: t, user: acct[t] } : null;
}

export function avatar() {
  const p = primary();
  return p && p.user ? p.user.avatar : null;
}

// ── restore ───────────────────────────────────────────────────────────────
// Reads both stored sessions WITHOUT loading either heavy bundle, so we can tell
// whether there is anything to restore before paying the download.
export function stored() {
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
  return { nostr: read("tw:auth"), pubky: read("tw:pubky") };
}

export async function restoreAll() {
  const s = stored();
  const jobs = [];
  if (s.nostr) {
    acct.nostr = s.nostr;
    jobs.push(nlib().then((n) => n.restore()).catch(() => {}));
  }
  if (s.pubky) {
    acct.pubky = s.pubky;
    jobs.push(plib().then((p) => p.restore()).catch(() => {}));
  }
  await Promise.all(jobs);
  return { ...acct };
}

export async function logout(rail) {
  try {
    if (rail === "pubky") await (await plib()).logout();
    else (await nlib()).logout();
  } catch {}
  acct[rail] = null;
}

export async function logoutAll() {
  for (const r of rails()) await logout(r);
}

// ── profiles ──────────────────────────────────────────────────────────────
// Best-effort, per rail. Many Pubky Ring users have no pubky.app profile and
// many Nostr keys have no kind-0 — a null result is normal, not an error.
export async function loadProfile(rail) {
  const u = acct[rail];
  if (!u) return null;
  try {
    const prof = rail === "pubky"
      ? await (await plib()).getProfile()
      : await (await nlib()).fetchProfile(u.pubkey);
    if (!prof) return null;
    if (prof.name) u.name = prof.name;
    if (prof.image) u.avatar = prof.image;
    return prof;
  } catch { return null; }
}

export async function loadProfiles() {
  return Promise.all(rails().map((r) => loadProfile(r)));
}

// ── publish / fetch fan-out ───────────────────────────────────────────────
// Publish one highlight to every target rail. Returns
// { ids: {nostr?, pubky?}, errors: [{rail, message}] } — a rail failing does not
// stop the others, so a flaky relay can't block the homeserver write.
export async function publishHighlight(hl, path) {
  const link = crossLink();
  const ids = {};
  const errors = [];
  for (const rail of targets()) {
    try {
      if (rail === "pubky") {
        const p = await plib();
        ids.pubky = await p.publish(hl, p.pageKey(path), link);
      } else {
        ids.nostr = await (await nlib()).publish(hl, path, link);
      }
    } catch (e) {
      errors.push({ rail, message: e && e.message ? e.message : String(e) });
    }
  }
  return { ids, errors };
}

// Is at least one target rail actually able to write right now? (A restored
// session can be stale — the cookie or the signer may be gone.)
export async function ready() {
  for (const rail of targets()) {
    try {
      if (rail === "pubky" && (await plib()).hasSession()) return true;
      if (rail === "nostr" && (await nlib()).hasSigner()) return true;
    } catch {}
  }
  return false;
}

// Everything the reader has for THIS page, across every connected rail.
// Returns { incoming, prune } — `prune` lists {source, ids} sets the caller can
// use to drop local ghosts, and is omitted for a rail that did not answer (so a
// flaky connection never deletes anything).
export async function fetchPage(path) {
  const incoming = [];
  const prune = [];

  if (hasNostr()) {
    try {
      const n = await nlib();
      const pub = await n.fetch(acct.nostr.pubkey, path);
      const priv = n.canEncrypt() ? await n.privateFetch(path) : null;
      if (pub) { incoming.push(...pub); prune.push({ source: "nostr", ids: new Set(pub.map((h) => h.id)) }); }
      if (priv) { incoming.push(...priv); prune.push({ source: "nostrp", ids: new Set(priv.map((h) => h.id)) }); }
    } catch {}
  }

  if (hasPubky()) {
    try {
      const p = await plib();
      const got = await p.fetch(p.pageKey(path));
      if (got) { incoming.push(...got); prune.push({ source: "pubky", ids: new Set(got.map((h) => h.id)) }); }
    } catch {}
  }

  return { incoming, prune };
}

// Which rail a stored highlight lives on, from its `source`.
export function railOf(hl) {
  const s = hl && hl.source;
  if (s === "pubky" || s === "pubkyp") return "pubky";
  if (s === "nostr" || s === "nostrp") return "nostr";
  return null;
}

// Delete a highlight from wherever it actually lives. Nostr deletion is a
// request relays may ignore; Pubky deletion is a real delete on the reader's own
// homeserver, so a failure there must NOT be swallowed — the caller needs to
// know the record is still up.
export async function removeHighlight(hl, path) {
  const rail = railOf(hl);
  if (rail === "pubky") {
    const p = await plib();
    await p.remove(hl.id, p.pageKey(path));   // throws on failure — deliberate
  } else if (rail === "nostr" && hl.source === "nostr") {
    try { await (await nlib()).deleteEvent(hl.id); } catch {}
  }
}
