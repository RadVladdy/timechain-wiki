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

// Re-establish a signer for an already-stored session (extension only; a bunker
// session needs an explicit reconnect, handled at publish time).
export async function restore() {
  const u = storedUser();
  if (!u) return null;
  if (u.method === "nip07" && globalThis.nostr) {
    signer = { pubkey: u.pubkey, signEvent: (e) => globalThis.nostr.signEvent(e) };
  }
  return u;
}

export async function loginNip07() {
  if (!globalThis.nostr) {
    const err = new Error("no-extension");
    err.code = "no-extension";
    throw err;
  }
  const pubkey = await globalThis.nostr.getPublicKey();
  signer = { pubkey, signEvent: (e) => globalThis.nostr.signEvent(e) };
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
  // left `bp` unset → "this.bp is undefined"). onauth opens the approval URL some
  // signers hand back (Amber usually approves via its own prompt instead).
  const bunker = BunkerSigner.fromBunker(local, bp, {
    pool,
    onauth: (url) => { try { window.open(url, "_blank", "noopener"); } catch {} },
  });
  await bunker.connect();
  const pubkey = await bunker.getPublicKey();
  signer = { pubkey, signEvent: (e) => bunker.signEvent(e) };
  const u = { pubkey, npub: nip19.npubEncode(pubkey), method: "nip46", bunker: connectString.trim() };
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
    // A stored bunker session that hasn't reconnected this load.
    const u = storedUser();
    if (u?.method === "nip46" && u.bunker) await loginBunker(u.bunker);
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

// Request deletion of a highlight event (NIP-09 kind-5). Best-effort — relays
// may or may not honor it; the highlight is removed locally regardless.
export async function deleteEvent(id) {
  if (!signer) {
    const u = storedUser();
    if (u?.method === "nip46" && u.bunker) await loginBunker(u.bunker);
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
export async function fetchProfile(pubkey, ms = 2500) {
  const events = await new Promise((resolve) => {
    const found = [];
    const sub = pool.subscribeMany(RELAYS, [{ kinds: [0], authors: [pubkey], limit: 1 }], {
      onevent: (e) => found.push(e),
      oneose: () => {},
    });
    setTimeout(() => { try { sub.close(); } catch {} resolve(found); }, ms);
  });
  if (!events.length) return null;
  events.sort((a, b) => b.created_at - a.created_at);
  try {
    const m = JSON.parse(events[0].content);
    return { name: m.display_name || m.name || null, image: m.picture || null };
  } catch { return null; }
}

// Fetch this reader's highlights for one page. Resolves after a short window.
export async function fetch(pubkey, path, ms = 2500) {
  const filter = { kinds: [9802], authors: [pubkey], "#r": [canonUrl(path)] };
  const events = await new Promise((resolve) => {
    const found = new Map();
    const sub = pool.subscribeMany(RELAYS, [filter], {
      onevent: (e) => found.set(e.id, e),
      oneose: () => {},
    });
    setTimeout(() => { try { sub.close(); } catch {} resolve([...found.values()]); }, ms);
  });
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
