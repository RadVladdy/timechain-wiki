// The /highlights page: every highlight the reader has, across all pages and
// all storage modes — local (this browser), private sync (encrypted Nostr app
// data), public (NIP-84), and Pubky homeserver. Grouped by entry, deep-linked
// (#twhl=<id> scrolls to and activates the highlight on the article page).
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

const SRC_LABEL = { local: "On this device", nostrp: "Private · synced", nostr: "Public on Nostr", pubky: "Public on Pubky" };
const SRC_CLS = { local: "loc", nostrp: "priv", nostr: "pub", pubky: "pub" };

function localAll() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("tw:hl:")) continue;
      const url = k.slice("tw:hl:".length);
      try { JSON.parse(localStorage.getItem(k) || "[]").forEach((h) => out.push({ ...h, url })); } catch {}
    }
  } catch {}
  return out;
}

export async function renderAllHighlights() {
  const box = document.getElementById("hl-all");
  const titles = JSON.parse(document.getElementById("wiki-titles").textContent || "{}");
  const titleFor = (url) => {
    const slug = (url.match(/\/wiki\/([a-z0-9-]+)/) || [])[1];
    return slug ? (titles[slug] || slug) : url === "/" ? "Home" : url;
  };

  // gather: local always; remote per stored session (lazy imports keep the
  // anonymous path light — this page is only reached from signed-in UI anyway)
  const byId = new Map();
  for (const h of localAll()) byId.set(h.id, h);
  let sessionNote = "";
  try {
    const stored = JSON.parse(localStorage.getItem("tw:pubky") || localStorage.getItem("tw:auth") || "null");
    if (stored?.method === "pubky") {
      const p = await import("./pubky.js");
      await p.restore();
      for (const h of await p.fetchAll()) if (!byId.has(h.id)) byId.set(h.id, h);
    } else if (stored) {
      const n = await import("./nostr.js");
      await n.restore();
      const { pub, priv } = await n.fetchAllMine();
      for (const h of [...pub, ...priv]) if (!byId.has(h.id)) byId.set(h.id, h);
    } else {
      sessionNote = "Showing this device only — sign in on any article to include your synced highlights.";
    }
  } catch { sessionNote = "Couldn't reach your synced highlights just now — showing this device."; }

  const all = [...byId.values()].filter((h) => h.anchor && h.anchor.exact);
  box.innerHTML = "";
  if (sessionNote) box.appendChild(el("p", "hl-note", sessionNote));
  if (!all.length) {
    box.appendChild(el("p", "tw-empty", "No highlights yet. Select any text in an article to make your first one."));
    return;
  }

  // group by page, newest activity first
  const groups = new Map();
  for (const h of all) {
    const key = h.url || "/";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  const ordered = [...groups.entries()].sort((a, b) =>
    Math.max(...b[1].map((h) => h.createdAt || 0)) - Math.max(...a[1].map((h) => h.createdAt || 0)));

  const count = el("p", "hl-note", `${all.length} highlight${all.length === 1 ? "" : "s"} across ${ordered.length} entr${ordered.length === 1 ? "y" : "ies"}.`);
  box.appendChild(count);

  for (const [url, items] of ordered) {
    const sec = el("section", "hl-group");
    const h2 = el("h2");
    const a = el("a", null, titleFor(url));
    a.href = url;
    h2.appendChild(a);
    sec.appendChild(h2);
    for (const h of items.sort((a, b) => (a.anchor?.pos ?? 0) - (b.anchor?.pos ?? 0))) {
      const card = el("a", "hl-card");
      card.href = `${url}#twhl=${encodeURIComponent(h.id)}`;
      card.appendChild(el("blockquote", "tw-quote", h.anchor.exact));
      if (h.note) card.appendChild(el("p", "hl-card-note", h.note));
      const st = el("span", "tw-status " + (SRC_CLS[h.source] || "loc"));
      st.appendChild(el("i", "tw-status-dot"));
      st.appendChild(document.createTextNode(SRC_LABEL[h.source] || "On this device"));
      card.appendChild(st);
      sec.appendChild(card);
    }
    box.appendChild(sec);
  }
}
