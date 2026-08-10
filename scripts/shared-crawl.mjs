// Shared-highlights crawler — the nightly "phone book" sweep (cron 04:05, before
// the 04:25 rebuild+deploy, so tonight's aggregate ships with tonight's site).
//
// Collects PUBLIC reader highlights from both rails and bakes them into static
// JSON under public/shared/ — the site's shared layer reads those files and
// never queries a relay or homeserver from the browser.
//
//   Nostr — kind-9802 events for every wiki URL, NO author filter: public
//     highlights live on open relays and need no opt-in to be readable there.
//   Pubky — there is NO firehose (a serverwide stream is refused: "At least one
//     user must be specified"), so the crawler keeps an opt-in registry of
//     reader keys. Keys are DISCOVERED via kind-30078 hint events (#d =
//     timechain.wiki:pubky-share) but INCLUDED only when the share marker on
//     that key's OWN homeserver says so — only the key holder can write there,
//     so nobody can opt someone else in, and deleting the marker opts out no
//     matter what hints exist. Reads are anonymous: no session, just the key.
//
// Trust boundary, and why passages can auto-render: every anchor's `exact` text
// is verified to be a real substring of the built page (dist/), so the aggregate
// can only ever quote the wiki back at itself. A fabricated passage is dropped
// wholesale. NOTES are genuine user-generated content, so their text enters the
// baked output only after editorial approval — new notes are queued to the
// moderation file the cockpit reads, and until approved the highlight ships
// without its note.
//
// Cross-rail identity: one person publishing to both rails is merged only on a
// MUTUAL claim — the Nostr event names the Pubky key AND that Pubky record names
// the Nostr key back. A one-sided claim would let anyone assert they are
// someone else, so it proves nothing and merges nothing.
//
// Failure honesty (the invariant that already bit this project once): a rail
// that did not answer is UNKNOWN, never "empty". Total Nostr failure falls back
// to the last good corpus; a per-chunk failure retains last-good items for just
// those pages; a Pubky key whose marker read failed (vs. answered 404) keeps
// yesterday's records and is retried tomorrow. Opt-out happens only on positive
// evidence.
//
// State lives OUTSIDE the repo (~/dev/timechain-shared/): the registry, the
// last-good corpus, the profile cache, and the moderation queue are box state,
// not site content. Only the baked public/shared/ files are committed.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SimplePool, nip19 } from "nostr-tools";
import { Pubky } from "@synonymdev/pubky";
import { RELAYS, PROFILE_RELAYS } from "../src/lib/nostr-relays.generated.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = process.env.TW_SHARED_STATE || join(process.env.HOME, "dev/timechain-shared");
const OUT_DIR = join(ROOT, "public/shared");
const DIST = join(ROOT, "dist");

const CANON = "https://timechain.wiki";
const CANON_LEGACY = "https://timechain-astro.pages.dev";
const SHARE_HINT_D = "timechain.wiki:pubky-share";   // keep in sync with src/lib/nostr.js
const APP = "timechain.wiki";

// Keep in sync with pageKey() in src/lib/pubky.js — one directory per page.
const pageKey = (path) => path.replace(/^\/|\/$/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "home";

const EXACT_MAX = 1500, NOTE_MAX = 2000, RECORDS_PER_KEY_MAX = 300;
const PROFILE_TTL = 7 * 86400e3;

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms))]);
const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } };
const writeJsonAtomic = (f, obj) => { const tmp = f + ".tmp"; writeFileSync(tmp, JSON.stringify(obj, null, 1) + "\n"); renameSync(tmp, f); };

// ── page corpus: which paths exist, and each page's real text ─────────────
// dist/ is last night's build — required, because passage verification reads it.
// A missing dist must FAIL the run, not write an empty aggregate (the "check
// that reads nothing and reports clean" failure this fabric has already paid for).
const wikiIndex = readJson(join(ROOT, "src/lib/wiki-index.json"), null);
if (!wikiIndex) { console.error("FATAL: src/lib/wiki-index.json unreadable"); process.exit(1); }
const slugs = Object.keys(wikiIndex);
const PATHS = slugs.map((s) => `/wiki/${s}`);
if (!existsSync(DIST) || !existsSync(join(DIST, "wiki"))) {
  console.error("FATAL: dist/ missing — passage verification impossible; run the build first");
  process.exit(1);
}

// Strip a built page to comparable text. Both sides of every comparison go
// through norm(), so entity/whitespace differences can't cause false drops.
const decodeEntities = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
const norm = (s) => decodeEntities(String(s)).replace(/\s+/g, " ").trim();
const pageTextCache = new Map();
function pageText(path) {
  if (pageTextCache.has(path)) return pageTextCache.get(path);
  let txt = null;
  try {
    const html = readFileSync(join(DIST, path.replace(/^\//, ""), "index.html"), "utf8");
    txt = norm(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
  } catch {}
  pageTextCache.set(path, txt);
  return txt;
}
const passageReal = (path, exact) => {
  const t = pageText(path);
  return !!t && t.includes(norm(exact));
};

// ── validation ────────────────────────────────────────────────────────────
const KNOWN = new Set(PATHS);
const hostToPath = (r) => {
  const u = String(r || "");
  const p = u.startsWith(CANON) ? u.slice(CANON.length) : u.startsWith(CANON_LEGACY) ? u.slice(CANON_LEGACY.length) : null;
  return p === null ? null : (p.replace(/\/$/, "") || "/");
};
const Z32 = /^[a-z0-9]{52}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function cleanItem({ rail, id, path, exact, prefix, suffix, pos, note, createdAt, author }) {
  if (!KNOWN.has(path)) return null;
  if (typeof exact !== "string" || !exact.trim() || exact.length > EXACT_MAX) return null;
  if (!passageReal(path, exact)) return null;   // not the wiki's own text → gone
  return {
    rail, id, path,
    exact, prefix: String(prefix || "").slice(0, 300), suffix: String(suffix || "").slice(0, 300),
    pos: Number.isFinite(Number(pos)) ? Number(pos) : 0,
    note: typeof note === "string" ? note.slice(0, NOTE_MAX).trim() : "",
    createdAt: Number(createdAt) || 0,
    author,
  };
}

// ── state ─────────────────────────────────────────────────────────────────
mkdirSync(STATE_DIR, { recursive: true });
const stateFile = join(STATE_DIR, "state.json");
const queueFile = join(STATE_DIR, "notes-queue.json");
const state = readJson(stateFile, { v: 1, registry: {}, lastGood: { nostr: [], pubky: {} }, profiles: { nostr: {}, pubky: {} } });
// Takedown hatch: raw item ids (nostr event id, or `<z32>:<recId>`) listed in
// state.blocked never enter the baked output, whatever the rails return.
state.blocked = state.blocked || [];
const queue = readJson(queueFile, { v: 1, notes: [] });
// Suggestions arriving over the Pubky rail (written into the reader's own
// homeserver; collected here, staged onto the vault Suggestions desk by
// notes-sync). Never baked into the site — they are editorial input only.
const suggFile = join(STATE_DIR, "suggestions-queue.json");
const suggQueue = readJson(suggFile, { v: 1, items: [] });
const SUGG_PER_KEY_MAX = 10, SUGG_TEXT_MAX = 4000;

const pool = new SimplePool();

// ── Nostr sweep ───────────────────────────────────────────────────────────
async function sweepNostr() {
  const items = [];
  const failedPaths = new Set();
  const CHUNK = 24;
  let chunksOk = 0, chunksFail = 0;
  for (let i = 0; i < PATHS.length; i += CHUNK) {
    const chunk = PATHS.slice(i, i + CHUNK);
    const rs = chunk.flatMap((p) => [CANON + p, CANON_LEGACY + p]);
    let evs = null;
    try { evs = await withTimeout(pool.querySync(RELAYS, { kinds: [9802], "#r": rs }), 20000, `9802 chunk ${i / CHUNK}`); }
    catch { evs = null; }
    if (evs === null) { chunksFail++; chunk.forEach((p) => failedPaths.add(p)); continue; }
    chunksOk++;
    for (const e of evs) {
      const tag = (k) => (e.tags.find((x) => x[0] === k) || [])[1];
      const path = hostToPath(tag("r"));
      if (path === null || !HEX64.test(e.pubkey)) continue;
      const twPubky = Z32.test(String(tag("tw-pubky") || "")) ? tag("tw-pubky") : null;
      const it = cleanItem({
        rail: "nostr", id: e.id, path,
        exact: e.content, prefix: tag("tw-prefix"), suffix: tag("tw-suffix"), pos: tag("tw-pos"),
        note: tag("comment"), createdAt: e.created_at * 1000,
        author: { nostr: e.pubkey },
      });
      if (it) { it.twPubky = twPubky; items.push(it); }
    }
  }
  // De-dup across relays (same event id can arrive per relay — querySync mostly
  // handles it, but be exact) and across hosts (legacy + canon are one page).
  const byId = new Map();
  for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it);
  const fresh = [...byId.values()];
  if (chunksOk === 0) {
    log(`nostr: ALL ${chunksFail} chunks failed — rail unknown, keeping last good corpus (${state.lastGood.nostr.length} items)`);
    return { items: state.lastGood.nostr, ok: false };
  }
  if (chunksFail > 0) {
    const retained = state.lastGood.nostr.filter((it) => failedPaths.has(it.path));
    log(`nostr: ${chunksFail} chunk(s) failed — retaining ${retained.length} last-good item(s) for those pages`);
    for (const it of retained) if (!byId.has(it.id)) fresh.push(it);
  }
  // Honor NIP-09: some relays serve a deleted event forever, and a reader who
  // deleted their highlight must not live on in the aggregate. A kind-5 counts
  // only from the event's own author — anyone can PUBLISH one about any id.
  const surviving = await dropDeleted(fresh);
  log(`nostr: ${surviving.length} valid public highlight(s) from ${chunksOk}/${chunksOk + chunksFail} chunks${surviving.length !== fresh.length ? ` (${fresh.length - surviving.length} deleted by author)` : ""}`);
  return { items: surviving, ok: true };
}

async function dropDeleted(items) {
  const ids = items.map((it) => it.id);
  if (!ids.length) return items;
  const deleted = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    let evs = null;
    try { evs = await withTimeout(pool.querySync(RELAYS, { kinds: [5], "#e": chunk }), 15000, "kind-5"); } catch {}
    for (const d of evs || []) for (const t of d.tags) if (t[0] === "e") deleted.add(`${d.pubkey}|${t[1]}`);
  }
  return items.filter((it) => !deleted.has(`${it.author.nostr}|${it.id}`));
}

// ── Pubky sweep ───────────────────────────────────────────────────────────
const isAbsent = (e) => /404/.test(String(e?.message || e));

async function discoverKeys() {
  let evs = null;
  try { evs = await withTimeout(pool.querySync(RELAYS, { kinds: [30078], "#d": [SHARE_HINT_D] }), 20000, "share hints"); }
  catch { evs = null; }
  if (evs === null) { log("hints: relay query failed — using existing registry only"); return; }
  let added = 0;
  for (const e of evs) {
    const z = String(e.content || "").trim();
    if (!Z32.test(z)) continue;
    if (!state.registry[z]) { state.registry[z] = { firstSeen: Date.now() }; added++; }
  }
  log(`hints: ${evs.length} event(s), ${added} new key(s); registry now ${Object.keys(state.registry).length}`);
}

// Hints are unauthenticated, so the registry needs hygiene: a key whose
// homeserver has NEVER answered expires after 30 days (a genuine reader's
// opt-in publishes a fresh hint, which re-adds it), and the registry is capped —
// each key costs a nightly PKARR resolution + read, so unbounded hint spam
// would otherwise grow the sweep without limit. Drops are logged, never silent.
function pruneRegistry() {
  const keys = Object.keys(state.registry);
  let expired = 0;
  for (const z of keys) {
    const r = state.registry[z];
    if (!r.lastAnswered && Date.now() - (r.firstSeen || 0) > 30 * 86400e3) { delete state.registry[z]; delete state.lastGood.pubky[z]; expired++; }
  }
  if (expired) log(`registry: expired ${expired} key(s) that never answered in 30 days`);
  const over = Object.keys(state.registry).length - 2000;
  if (over > 0) {
    const drop = Object.entries(state.registry)
      .filter(([, r]) => !r.lastAnswered)
      .sort((a, b) => (a[1].firstSeen || 0) - (b[1].firstSeen || 0))
      .slice(0, over);
    for (const [z] of drop) { delete state.registry[z]; delete state.lastGood.pubky[z]; }
    log(`registry: over cap — dropped ${drop.length} oldest never-answered key(s)`);
  }
}

async function sweepPubky() {
  const anon = new Pubky();
  const pub = anon.publicStorage;
  const perKey = {};   // z32 -> items[] (only keys that ANSWERED end up here)
  for (const z of Object.keys(state.registry)) {
    const reg = state.registry[z];
    // 1. the share marker on the reader's own homeserver is the authority
    let marker = null, absent = false;
    try { marker = await withTimeout(pub.getJson(`pubky://${z}/pub/${APP}/share.json`), 20000, `marker ${z.slice(0, 8)}`); }
    catch (e) { if (isAbsent(e)) absent = true; }
    if (absent || (marker && marker.share !== true)) {
      // answered: opted out. Positive evidence — drop the key's items.
      reg.optedOut = true; delete reg.lastAnswered;
      continue;
    }
    if (!marker) {
      // did NOT answer — unknown, never "no". Keep yesterday's records, retry tomorrow.
      const kept = state.lastGood.pubky[z];
      if (kept && kept.length) { perKey[z] = kept; log(`pubky ${z.slice(0, 8)}…: marker unreachable — keeping ${kept.length} last-good item(s)`); }
      continue;
    }
    delete reg.optedOut; reg.lastAnswered = Date.now();
    // 2. list + read, anonymously
    let urls = null;
    try { urls = await withTimeout(pub.list(`pubky://${z}/pub/${APP}/highlights/`), 25000, `list ${z.slice(0, 8)}`); }
    catch (e) { if (isAbsent(e)) urls = []; }
    if (urls === null) {
      const kept = state.lastGood.pubky[z];
      if (kept && kept.length) { perKey[z] = kept; log(`pubky ${z.slice(0, 8)}…: list failed — keeping ${kept.length} last-good item(s)`); }
      continue;
    }
    const files = urls.filter((u) => u.endsWith(".json"));
    if (files.length > RECORDS_PER_KEY_MAX) log(`pubky ${z.slice(0, 8)}…: ${files.length} records, capping at ${RECORDS_PER_KEY_MAX} (dropped ${files.length - RECORDS_PER_KEY_MAX})`);
    const items = [];
    for (const u of files.slice(0, RECORDS_PER_KEY_MAX)) {
      let rec = null;
      try { rec = await withTimeout(pub.getJson(u), 15000, "record"); } catch {}
      if (!rec) continue;
      const it = cleanItem({
        rail: "pubky", id: `${z}:${String(rec.id || u.split("/").pop().replace(/\.json$/, ""))}`,
        path: (typeof rec.url === "string" ? rec.url.replace(/\/$/, "") : "") || "",
        exact: rec.anchor?.exact, prefix: rec.anchor?.prefix, suffix: rec.anchor?.suffix, pos: rec.anchor?.pos,
        note: rec.note, createdAt: rec.createdAt,
        author: { pubky: z },
      });
      if (it) { it.nostrClaim = HEX64.test(String(rec.nostrPubkey || "")) ? rec.nostrPubkey : null; items.push(it); }
    }
    perKey[z] = items;
    log(`pubky ${z.slice(0, 8)}…: ${items.length} valid item(s)`);

    // 3. suggestions this reader left in their own homeserver for the wiki
    await collectSuggestions(pub, z);
  }
  return perKey;
}

async function collectSuggestions(pub, z) {
  let urls = null;
  try { urls = await withTimeout(pub.list(`pubky://${z}/pub/${APP}/suggestions/`), 20000, `sugg ${z.slice(0, 8)}`); }
  catch (e) { if (isAbsent(e)) return; }
  if (!urls) return;   // did not answer — retry tomorrow, never assume empty
  const files = urls.filter((u) => u.endsWith(".json"));
  if (files.length > SUGG_PER_KEY_MAX) log(`pubky ${z.slice(0, 8)}…: ${files.length} suggestions, capping at ${SUGG_PER_KEY_MAX}`);
  const seen = new Set(suggQueue.items.map((s) => s.key));
  let picked = 0;
  for (const u of files.slice(0, SUGG_PER_KEY_MAX)) {
    let rec = null;
    try { rec = await withTimeout(pub.getJson(u), 15000, "sugg record"); } catch {}
    if (!rec || typeof rec.text !== "string" || !rec.text.trim()) continue;
    const path = (typeof rec.url === "string" ? rec.url.replace(/\/$/, "") : "") || "";
    if (!KNOWN.has(path)) continue;
    const key = sha1(`sugg|${z}|${rec.id || u}|${rec.text}`);
    if (seen.has(key)) continue;
    suggQueue.items.push({
      key, pubky: z, path,
      exact: String(rec.exact || "").slice(0, EXACT_MAX),
      text: rec.text.slice(0, SUGG_TEXT_MAX),
      createdAt: Number(rec.createdAt) || Date.now(),
      seenAt: Date.now(),
    });
    seen.add(key);
    picked++;
  }
  if (picked) log(`pubky ${z.slice(0, 8)}…: ${picked} new suggestion(s) queued for the desk`);
}

// ── profiles ──────────────────────────────────────────────────────────────
async function nostrProfiles(pubkeys) {
  const need = pubkeys.filter((pk) => !(state.profiles.nostr[pk] && Date.now() - state.profiles.nostr[pk].fetchedAt < PROFILE_TTL));
  for (let i = 0; i < need.length; i += 50) {
    const chunk = need.slice(i, i + 50);
    let evs = null;
    try { evs = await withTimeout(pool.querySync(PROFILE_RELAYS, { kinds: [0], authors: chunk }), 15000, "kind-0"); } catch {}
    if (!evs) continue;
    const newest = new Map();
    for (const e of evs) { const c = newest.get(e.pubkey); if (!c || e.created_at > c.created_at) newest.set(e.pubkey, e); }
    for (const pk of chunk) {
      const e = newest.get(pk);
      let name = null, picture = null;
      if (e) { try { const m = JSON.parse(e.content || "{}"); name = m.display_name || m.name || null; picture = typeof m.picture === "string" && /^https?:/.test(m.picture) ? m.picture : null; } catch {} }
      state.profiles.nostr[pk] = { name, picture, fetchedAt: Date.now() };
    }
  }
}
async function pubkyProfiles(keys) {
  const anon = new Pubky();
  for (const z of keys) {
    const c = state.profiles.pubky[z];
    if (c && Date.now() - c.fetchedAt < PROFILE_TTL) continue;
    let name = null;
    try {
      const prof = await withTimeout(anon.publicStorage.getJson(`pubky://${z}/pub/pubky.app/profile.json`), 15000, "pk profile");
      if (prof && typeof prof.name === "string") name = prof.name.slice(0, 60);
    } catch {}
    state.profiles.pubky[z] = { name, fetchedAt: Date.now() };
  }
}

// ── merge + bake ──────────────────────────────────────────────────────────
function mergeRails(nostrItems, pubkyPerKey) {
  const pubkyItems = Object.values(pubkyPerKey).flat();
  // mutual identity claims
  const nostrClaims = new Map();   // nostr pubkey -> Set(pubky z32) it claims
  for (const it of nostrItems) if (it.twPubky) (nostrClaims.get(it.author.nostr) || nostrClaims.set(it.author.nostr, new Set()).get(it.author.nostr)).add(it.twPubky);
  const pubkyClaims = new Map();   // z32 -> Set(nostr pubkey) it claims
  for (const it of pubkyItems) if (it.nostrClaim) (pubkyClaims.get(it.author.pubky) || pubkyClaims.set(it.author.pubky, new Set()).get(it.author.pubky)).add(it.nostrClaim);
  const mutual = (n, p) => !!(nostrClaims.get(n)?.has(p) && pubkyClaims.get(p)?.has(n));

  // same highlight published to both rails by one (mutually-claimed) person →
  // one item; the Nostr copy wins as primary and carries both identities.
  const merged = [...nostrItems];
  const nostrSig = new Map();  // path|exact|nostrPubkey -> item
  for (const it of nostrItems) nostrSig.set(`${it.path}|${norm(it.exact)}|${it.author.nostr}`, it);
  for (const it of pubkyItems) {
    const n = it.nostrClaim;
    const twin = n && mutual(n, it.author.pubky) ? nostrSig.get(`${it.path}|${norm(it.exact)}|${n}`) : null;
    if (twin) { twin.rail = "both"; twin.author.pubky = it.author.pubky; continue; }
    merged.push(it);
  }
  return merged;
}

function attribution(it) {
  const a = {};
  if (it.author.nostr) {
    const prof = state.profiles.nostr[it.author.nostr] || {};
    a.npub = nip19.npubEncode(it.author.nostr);
    if (prof.name) a.name = prof.name;
    if (prof.picture) a.picture = prof.picture;
  }
  if (it.author.pubky) {
    const prof = state.profiles.pubky[it.author.pubky] || {};
    a.pubky = it.author.pubky;
    if (!a.name && prof.name) a.name = prof.name;
  }
  return a;
}

function bake(items) {
  // moderation: a note's text ships only once approved. Key includes the note
  // text so an edited note re-enters review instead of inheriting approval —
  // but NOT the rail, which flips nostr→both when a mutual claim completes and
  // must not throw an approved note back into review.
  const known = new Map(queue.notes.map((n) => [n.key, n]));
  let queued = 0;
  const approvedFor = (it) => {
    if (!it.note) return false;
    const key = sha1(`${it.id}|${it.note}`);
    let entry = known.get(key);
    if (!entry) {
      entry = { key, rail: it.rail, id: it.id, path: it.path, exact: it.exact.slice(0, 200), note: it.note, author: attribution(it), seenAt: Date.now(), status: "pending" };
      queue.notes.push(entry); known.set(key, entry); queued++;
    }
    return entry.status === "approved";
  };

  const blocked = new Set(state.blocked);
  const byPath = new Map();
  for (const it of items) {
    if (blocked.has(it.id)) continue;
    const out = {
      id: `${it.rail === "pubky" ? "p" : "n"}:${it.id}`,
      rail: it.rail,
      exact: it.exact, prefix: it.prefix, suffix: it.suffix, pos: it.pos,
      createdAt: it.createdAt,
      author: attribution(it),
      ...(approvedFor(it) ? { note: it.note } : {}),
    };
    if (!byPath.has(it.path)) byPath.set(it.path, []);
    byPath.get(it.path).push(out);
  }
  for (const list of byPath.values()) list.sort((a, b) => (a.pos - b.pos) || (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1));

  // deterministic output, no timestamps — an unchanged night produces no diff
  mkdirSync(join(OUT_DIR, "p"), { recursive: true });
  const wanted = new Set();
  const index = { v: 1, pages: {} };
  for (const path of [...byPath.keys()].sort()) {
    const k = pageKey(path);
    wanted.add(k + ".json");
    index.pages[path] = byPath.get(path).length;
    writeFileSync(join(OUT_DIR, "p", k + ".json"), JSON.stringify({ v: 1, path, items: byPath.get(path) }) + "\n");
  }
  for (const f of readdirSync(join(OUT_DIR, "p"))) if (!wanted.has(f)) unlinkSync(join(OUT_DIR, "p", f));
  writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify(index) + "\n");
  return { pages: byPath.size, total: items.length, queued };
}

// ── run ───────────────────────────────────────────────────────────────────
// --bake-only: re-render the baked output from the last-good corpus + the
// CURRENT moderation queue, no network. Run after the overnight moderator so
// same-night approvals ship with the 04:25 deploy instead of waiting a day.
if (process.argv.includes("--bake-only")) {
  const merged = mergeRails(state.lastGood.nostr, Object.fromEntries(Object.entries(state.lastGood.pubky)));
  const { pages, total } = bake(merged);
  writeJsonAtomic(queueFile, queue);
  log(`bake-only: ${total} highlight(s) across ${pages} page(s) re-baked from last-good corpus`);
  process.exit(0);
}
try {
  await discoverKeys();
  pruneRegistry();
  const nostrRes = await sweepNostr();
  const pubkyPerKey = await sweepPubky();

  await nostrProfiles([...new Set(nostrRes.items.map((i) => i.author.nostr).filter(Boolean))]);
  await pubkyProfiles([...new Set([...Object.keys(pubkyPerKey), ...nostrRes.items.map((i) => i.author.pubky).filter(Boolean)])]);

  const merged = mergeRails(nostrRes.items, pubkyPerKey);
  const { pages, total, queued } = bake(merged);

  if (nostrRes.ok) state.lastGood.nostr = nostrRes.items;
  for (const [z, items] of Object.entries(pubkyPerKey)) state.lastGood.pubky[z] = items;
  for (const z of Object.keys(state.lastGood.pubky)) if (state.registry[z]?.optedOut) delete state.lastGood.pubky[z];
  writeJsonAtomic(stateFile, state);
  writeJsonAtomic(queueFile, queue);
  writeJsonAtomic(suggFile, suggQueue);

  const pending = queue.notes.filter((n) => n.status === "pending").length;
  log(`baked ${total} highlight(s) across ${pages} page(s); ${queued} new note(s) queued, ${pending} pending review`);
  pool.close([...RELAYS, ...PROFILE_RELAYS]);
  process.exit(0);
} catch (e) {
  console.error("FATAL:", e);
  process.exit(1);
}
