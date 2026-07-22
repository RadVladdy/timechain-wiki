// Nostr layer for reader highlights — NIP-84 "highlights" (kind 9802).
// Sign-in via NIP-07 (browser extension) or NIP-46 (remote signer / Amber
// bunker string). Publishes and reads highlight events over a small relay set.
// Lazy-loaded by the annotation controller so nostr-tools stays out of the
// initial page bundle.
import { SimplePool, nip19, generateSecretKey, getPublicKey } from "nostr-tools";

// Read/write relays. Kept small and mainstream; a launch-time setting later.
export const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
];
// Profile (kind-0) lookups — include purplepag.es, the profile-metadata relay
// that aggregates kind-0 across the network, so avatars resolve reliably.
const PROFILE_RELAYS = ["wss://purplepag.es", "wss://relay.nostr.band", "wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

const toHex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/.{1,2}/g).map((x) => parseInt(x, 16)));
const onAuth = (url) => { try { window.open(url, "_blank", "noopener"); } catch {} };

// Canonical host so highlight `r` tags match across preview deploy-hash
// subdomains and (eventually) the real domain — read-back stays self-consistent.
const CANON = "https://timechain-astro.pages.dev";
const AUTH_KEY = "tw:auth";
const pool = new SimplePool();
let signer = null; // { pubkey, signEvent(evt) }

export function canonUrl(path) { return CANON + path; }

export function storedUser() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); } catch { return null; }
}
function store(u) { try { localStorage.setItem(AUTH_KEY, JSON.stringify(u)); } catch {} }

export function npubShort(pubkey) {
  try { const n = nip19.npubEncode(pubkey); return n.slice(0, 10) + "…" + n.slice(-4); }
  catch { return pubkey.slice(0, 8) + "…"; }
}

// Re-establish a signer for an already-stored session. Extension = re-wrap
// window.nostr. Bunker = rebuild from the SAME stored local key WITHOUT calling
// connect() again (Amber already approved this key — a fresh connect() would be
// rejected "already connected"); fromBunker sets up the subscription, so
// signEvent works directly.
export async function restore() {
  const u = storedUser();
  if (!u) return null;
  if (u.method === "nip07" && globalThis.nostr) {
    signer = nip07Signer(u.pubkey);
  } else if (u.method === "nip46") {
    try { await reconnectBunker(u); } catch {}
  }
  return u;
}

async function reconnectBunker(u) {
  if (!u || !u.local || !u.bunker) return false;
  const { BunkerSigner, parseBunkerInput } = await import("nostr-tools/nip46");
  const bp = await parseBunkerInput(u.bunker);
  if (!bp) return false;
  const bunker = BunkerSigner.fromBunker(fromHex(u.local), bp, { pool, onauth: onAuth });
  signer = bunkerSigner(u.pubkey, bunker);
  return true;
}

// Signer wrappers — signEvent plus NIP-44 encrypt/decrypt when the underlying
// signer supports it (needed for the private modes; absent → private disabled).
function nip07Signer(pubkey) {
  const n = globalThis.nostr;
  const s = { pubkey, signEvent: (e) => n.signEvent(e) };
  if (n.nip44?.encrypt) {
    s.enc44 = (pk, txt) => n.nip44.encrypt(pk, txt);
    s.dec44 = (pk, txt) => n.nip44.decrypt(pk, txt);
  }
  return s;
}
function bunkerSigner(pubkey, bunker) {
  return {
    pubkey,
    signEvent: (e) => bunker.signEvent(e),
    enc44: (pk, txt) => bunker.nip44Encrypt(pk, txt),
    dec44: (pk, txt) => bunker.nip44Decrypt(pk, txt),
  };
}

export function canEncrypt() { return !!(signer && signer.enc44); }

export async function loginNip07() {
  if (!globalThis.nostr) {
    const err = new Error("no-extension");
    err.code = "no-extension";
    throw err;
  }
  const pubkey = await globalThis.nostr.getPublicKey();
  signer = nip07Signer(pubkey);
  const u = { pubkey, npub: nip19.npubEncode(pubkey), method: "nip07" };
  store(u);
  return u;
}

// NIP-46: connect to a remote signer from a `bunker://…` string (e.g. Amber).
export async function loginBunker(connectString) {
  const { BunkerSigner, parseBunkerInput } = await import("nostr-tools/nip46");
  const bp = await parseBunkerInput(connectString.trim());
  if (!bp) throw new Error("bad-bunker-string");
  const local = generateSecretKey();
  // fromBunker is the current factory — the constructor is private (calling `new`
  // left `bp` unset → "this.bp is undefined"). connect() once for first-time
  // approval; we persist the local key so later loads reconnect WITHOUT re-connecting.
  const bunker = BunkerSigner.fromBunker(local, bp, { pool, onauth: onAuth });
  await bunker.connect();
  const pubkey = await bunker.getPublicKey();
  signer = bunkerSigner(pubkey, bunker);
  const u = { pubkey, npub: nip19.npubEncode(pubkey), method: "nip46", bunker: connectString.trim(), local: toHex(local) };
  store(u);
  return u;
}

export function logout() {
  signer = null;
  try { localStorage.removeItem(AUTH_KEY); } catch {}
}

export function hasSigner() { return !!signer; }

// Build + sign + publish a kind-9802 highlight. Returns the event id.
export async function publish(hl, path) {
  if (!signer) {
    const u = storedUser();
    if (u?.method === "nip46") await reconnectBunker(u);
    if (!signer) throw new Error("not-signed-in");
  }
  const a = hl.anchor || {};
  const ctx = (a.prefix || "") + a.exact + (a.suffix || "");
  const tmpl = {
    kind: 9802,
    created_at: Math.floor(Date.now() / 1000),
    content: a.exact,
    tags: [
      ["r", canonUrl(path)],
      ["context", ctx],
      ["tw-prefix", a.prefix || ""],
      ["tw-suffix", a.suffix || ""],
      ["tw-pos", String(a.pos ?? 0)],
      ...(hl.note ? [["comment", hl.note]] : []),
      ["alt", "Highlight on Timechain Wiki"],
    ],
    pubkey: signer.pubkey,
  };
  const signed = await signer.signEvent(tmpl);
  await Promise.any(pool.publish(RELAYS, signed)).catch(() => {});
  return signed.id;
}

// The wiki's Suggestions inbox identity — reader edit-suggestions are sent as
// public addressed kind-1 events p-tagging this pubkey (receive-only; a box
// poller reads the feed and stages suggestions for editorial review).
export const SUGGESTIONS_PUBKEY = "87c1f3e383550571b2cb5283e6352d2d5ddc7abf97415f94f9f26dda6c92f0fa";

// Build + sign + publish a reader suggestion (public kind-1, signed by the
// reader, addressed to the Suggestions inbox). Returns the event id.
export async function publishSuggestion({ exact, text, path }) {
  if (!signer) {
    const u = storedUser();
    if (u?.method === "nip46") await reconnectBunker(u);
    if (!signer) throw new Error("not-signed-in");
  }
  const tmpl = {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    content: `Suggested edit for ${canonUrl(path)}\n\nPassage:\n"${exact}"\n\nSuggestion:\n${text}`,
    tags: [
      ["p", SUGGESTIONS_PUBKEY],
      ["r", canonUrl(path)],
      ["t", "timechain-wiki-suggestion"],
      ["alt", "Reader edit-suggestion for Timechain Wiki"],
    ],
    pubkey: signer.pubkey,
  };
  const signed = await signer.signEvent(tmpl);
  await Promise.any(pool.publish(RELAYS, signed)).catch(() => {});
  return signed.id;
}

// ── private modes ─────────────────────────────────────────────────────────
// Private cross-device sync: ONE replaceable app-data event per page (NIP-78,
// kind 30078), content NIP-44-encrypted to the reader themself. Relays carry
// only ciphertext; feed clients never render kind 30078.
const APPD_KIND = 30078;
const dTag = (path) => "timechain.wiki:hl:" + canonUrl(path);

async function ensureSigner() {
  if (!signer) {
    const u = storedUser();
    if (u?.method === "nip46") await reconnectBunker(u);
    if (!signer) throw new Error("not-signed-in");
  }
}

export async function privateSave(path, highlights) {
  await ensureSigner();
  if (!signer.enc44) throw new Error("signer-cant-encrypt");
  const payload = JSON.stringify(highlights.map((h) => ({
    id: h.id, anchor: h.anchor, note: h.note || "", createdAt: h.createdAt,
  })));
  const tmpl = {
    kind: APPD_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: await signer.enc44(signer.pubkey, payload),
    tags: [["d", dTag(path)]],
    pubkey: signer.pubkey,
  };
  const signed = await signer.signEvent(tmpl);
  await Promise.any(pool.publish(RELAYS, signed)).catch(() => {});
  return signed.id;
}

export async function privateFetch(path, ms = 3500) {
  if (!signer?.dec44) return [];
  const evs = await Promise.race([
    pool.querySync(RELAYS, { kinds: [APPD_KIND], authors: [signer.pubkey], "#d": [dTag(path)] }),
    new Promise((res) => setTimeout(() => res([]), ms)),
  ]).catch(() => []);
  if (!evs || !evs.length) return [];
  const newest = evs.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  try {
    const list = JSON.parse(await signer.dec44(signer.pubkey, newest.content));
    return list.map((h) => ({ ...h, source: "nostrp", published: true, pubkey: signer.pubkey }));
  } catch { return []; }
}

// Everything the signed-in reader has on Nostr for THIS wiki, across all pages —
// public highlights (9802, r on our host) + private blobs (30078, d-prefix).
export async function fetchAllMine(ms = 6000) {
  if (!signer) return { pub: [], priv: [] };
  const [pubEvs, privEvs] = await Promise.race([
    Promise.all([
      pool.querySync(RELAYS, { kinds: [9802], authors: [signer.pubkey] }),
      pool.querySync(RELAYS, { kinds: [APPD_KIND], authors: [signer.pubkey] }),
    ]),
    new Promise((res) => setTimeout(() => res([[], []]), ms)),
  ]).catch(() => [[], []]);
  const pub = (pubEvs || [])
    .filter((e) => ((e.tags.find((x) => x[0] === "r") || [])[1] || "").startsWith(CANON))
    .map((e) => {
      const tag = (k) => (e.tags.find((x) => x[0] === k) || [])[1];
      return {
        id: e.id, source: "nostr",
        url: (tag("r") || "").slice(CANON.length) || "/",
        note: tag("comment") || "",
        anchor: { exact: e.content, prefix: tag("tw-prefix") || "", suffix: tag("tw-suffix") || "", pos: Number(tag("tw-pos") || 0) },
        createdAt: e.created_at * 1000,
      };
    });
  const priv = [];
  if (signer.dec44) {
    const prefix = "timechain.wiki:hl:" + CANON;
    // newest blob per d-tag wins (replaceable events; relays may return stale copies)
    const byD = new Map();
    for (const e of privEvs || []) {
      const d = (e.tags.find((x) => x[0] === "d") || [])[1] || "";
      if (!d.startsWith(prefix)) continue;
      const cur = byD.get(d);
      if (!cur || e.created_at > cur.created_at) byD.set(d, e);
    }
    for (const [d, e] of byD) {
      try {
        const list = JSON.parse(await signer.dec44(signer.pubkey, e.content));
        const path = d.slice(prefix.length) || "/";
        for (const h of list) priv.push({ ...h, source: "nostrp", url: path });
      } catch {}
    }
  }
  return { pub, priv };
}

// Private suggestion: a NIP-17 gift-wrapped DM to the Suggestions inbox. The
// rumor (kind 14, unsigned) is sealed by the reader's signer (kind 13) and
// wrapped by a throwaway key (kind 1059) — relays see only the wrap; nothing
// appears on any feed, and outsiders can't even tell who sent it.
export async function publishSuggestionPrivate({ exact, text, path }) {
  await ensureSigner();
  if (!signer.enc44) throw new Error("signer-cant-encrypt");
  const { nip44 } = await import("nostr-tools");
  const { finalizeEvent, getEventHash } = await import("nostr-tools/pure");
  const now = Math.floor(Date.now() / 1000);
  const rumor = {
    kind: 14, created_at: now, pubkey: signer.pubkey,
    tags: [["p", SUGGESTIONS_PUBKEY], ["r", canonUrl(path)], ["subject", "TimechainWiki suggestion"]],
    content: `Suggested edit for ${canonUrl(path)}\n\nPassage:\n"${exact}"\n\nSuggestion:\n${text}`,
  };
  rumor.id = getEventHash(rumor);
  const seal = await signer.signEvent({
    kind: 13,
    created_at: now - Math.floor(Math.random() * 172800),
    content: await signer.enc44(SUGGESTIONS_PUBKEY, JSON.stringify(rumor)),
    tags: [],
    pubkey: signer.pubkey,
  });
  const wrapSk = generateSecretKey();
  const convKey = nip44.getConversationKey(wrapSk, SUGGESTIONS_PUBKEY);
  const wrap = finalizeEvent({
    kind: 1059,
    created_at: now - Math.floor(Math.random() * 172800),
    tags: [["p", SUGGESTIONS_PUBKEY]],
    content: nip44.encrypt(JSON.stringify(seal), convKey),
  }, wrapSk);
  await Promise.any(pool.publish(RELAYS, wrap)).catch(() => {});
  return wrap.id;
}

// Request deletion of a highlight event (NIP-09 kind-5). Best-effort — relays
// may or may not honor it; the highlight is removed locally regardless.
export async function deleteEvent(id) {
  if (!signer) {
    const u = storedUser();
    if (u?.method === "nip46") await reconnectBunker(u);
    if (!signer) return;
  }
  const tmpl = {
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [["e", id], ["k", "9802"]],
    pubkey: signer.pubkey,
  };
  const signed = await signer.signEvent(tmpl);
  await Promise.any(pool.publish(RELAYS, signed)).catch(() => {});
}

// The reader's Nostr profile (kind-0 metadata) — name + picture, best-effort.
// Uses querySync (collects until EOSE) with an 8s ceiling — the pattern that
// works on bitcoinkeys.guide; the old subscribe + 2.5s cutoff closed too early.
export async function fetchProfile(pubkey, ms = 8000) {
  try {
    const events = await Promise.race([
      pool.querySync(PROFILE_RELAYS, { kinds: [0], authors: [pubkey] }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("profile-timeout")), ms)),
    ]);
    if (!events || !events.length) return null;
    const newest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    const m = JSON.parse(newest.content || "{}");
    return { name: m.display_name || m.name || null, image: m.picture || null };
  } catch { return null; }
}

// Fetch this reader's highlights for one page. querySync collects until EOSE
// (the old fixed 2.5s subscribe window silently missed events on slow starts —
// the same flaw fetchProfile had).
export async function fetch(pubkey, path, ms = 8000) {
  const filter = { kinds: [9802], authors: [pubkey], "#r": [canonUrl(path)] };
  const events = await Promise.race([
    pool.querySync(RELAYS, filter),
    new Promise((res) => setTimeout(() => res([]), ms)),
  ]).catch(() => []);
  return events.map((e) => {
    const t = (k) => (e.tags.find((x) => x[0] === k) || [])[1];
    return {
      id: e.id,
      source: "nostr",
      published: true,
      pubkey: e.pubkey,
      createdAt: e.created_at * 1000,
      note: t("comment") || "",
      anchor: {
        exact: e.content,
        prefix: t("tw-prefix") || "",
        suffix: t("tw-suffix") || "",
        pos: Number(t("tw-pos") || 0),
      },
    };
  });
}
