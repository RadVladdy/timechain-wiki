// Local persistence for reader highlights, keyed by page path. This is the
// always-available layer: highlights work and survive reloads with no account,
// and act as the offline cache/outbox for the Nostr layer. A highlight:
//   { id, url, anchor:{exact,prefix,suffix,pos}, note, createdAt,
//     source:'local'|'nostr', pubkey?, published?:bool }

const KEY = (url) => "tw:hl:" + url;

export function pageUrl() {
  return location.pathname.replace(/\/$/, "") || "/";
}

function read(url) {
  try { return JSON.parse(localStorage.getItem(KEY(url)) || "[]"); }
  catch { return []; }
}
function write(url, list) {
  try { localStorage.setItem(KEY(url), JSON.stringify(list)); } catch {}
}

export function all(url = pageUrl()) {
  return read(url).sort((a, b) => (a.anchor?.pos ?? 0) - (b.anchor?.pos ?? 0));
}

export function upsert(hl, url = pageUrl()) {
  const list = read(url);
  const i = list.findIndex((h) => h.id === hl.id);
  if (i === -1) list.push(hl); else list[i] = { ...list[i], ...hl };
  write(url, list);
  return hl;
}

export function remove(id, url = pageUrl()) {
  write(url, read(url).filter((h) => h.id !== id));
}

// Merge fetched Nostr highlights in, de-duplicated by event id and by identical
// anchor text (so a locally-made highlight that was later published doesn't double).
export function merge(incoming, url = pageUrl()) {
  const list = read(url);
  const byId = new Set(list.map((h) => h.id));
  const byText = new Set(list.map((h) => (h.anchor?.exact || "") + "|" + (h.note || "")));
  for (const h of incoming) {
    if (byId.has(h.id)) continue;
    const sig = (h.anchor?.exact || "") + "|" + (h.note || "");
    const dupLocal = list.find((x) => x.source === "local" && (x.anchor?.exact || "") + "|" + (x.note || "") === sig);
    if (dupLocal) { dupLocal.id = h.id; dupLocal.source = "nostr"; dupLocal.published = true; dupLocal.pubkey = h.pubkey; continue; }
    if (byText.has(sig)) continue;
    list.push(h); byId.add(h.id); byText.add(sig);
  }
  write(url, list);
  return all(url);
}

export function uid() {
  return "l-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
