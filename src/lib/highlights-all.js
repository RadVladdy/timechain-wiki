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

function localRemove(url, id) {
  try {
    const k = "tw:hl:" + url;
    const cur = JSON.parse(localStorage.getItem(k) || "[]");
    localStorage.setItem(k, JSON.stringify(cur.filter((h) => h.id !== id)));
  } catch {}
}

export async function renderAllHighlights() {
  const box = document.getElementById("hl-all");
  const titles = JSON.parse(document.getElementById("wiki-titles").textContent || "{}");
  const titleFor = (url) => {
    const slug = (url.match(/\/wiki\/([a-z0-9-]+)/) || [])[1];
    return slug ? (titles[slug] || slug) : url === "/" ? "Home" : url;
  };
  let backend = null; // "nostr" | "pubky" — which session (if any) restored

  // gather: local always; remote per stored session (lazy imports keep the
  // anonymous path light — this page is only reached from signed-in UI anyway)
  const byId = new Map();
  for (const h of localAll()) byId.set(h.id, h);
  let sessionNote = "";
  try {
    const stored = JSON.parse(localStorage.getItem("tw:pubky") || localStorage.getItem("tw:auth") || "null");
    if (stored?.method === "pubky") {
      backend = "pubky";
      const p = await import("./pubky.js");
      await p.restore();
      for (const h of await p.fetchAll()) if (!byId.has(h.id)) byId.set(h.id, h);
    } else if (stored) {
      backend = "nostr";
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
      const foot = el("span", "hl-card-foot");
      const st = el("span", "tw-status " + (SRC_CLS[h.source] || "loc"));
      st.appendChild(el("i", "tw-status-dot"));
      st.appendChild(document.createTextNode(SRC_LABEL[h.source] || "On this device"));
      foot.appendChild(st);

      // two-tap delete: first tap arms ("Delete?"), second tap executes
      const del = el("button", "hl-del", "Delete");
      del.type = "button";
      del.title = "Delete this highlight everywhere it's stored";
      del.addEventListener("click", async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (!del.classList.contains("armed")) {
          del.classList.add("armed"); del.textContent = "Delete?";
          setTimeout(() => { del.classList.remove("armed"); del.textContent = "Delete"; }, 4000);
          return;
        }
        // Instant local removal; the network side (relay deletion / blob
        // rewrite / homeserver delete) runs in the background with a timeout —
        // a stalled signer prompt must never freeze the page.
        localRemove(url, h.id);
        const gi = items.indexOf(h); if (gi > -1) items.splice(gi, 1);
        card.remove();
        if (!sec.querySelector(".hl-card")) sec.remove();
        const bg = (async () => {
          if (h.source === "nostr" && backend === "nostr") {
            const n = await import("./nostr.js");
            await n.deleteEvent(h.id);
          } else if (h.source === "nostrp" && backend === "nostr") {
            const n = await import("./nostr.js");
            await n.privateSave(url, items.filter((x) => x.source === "nostrp"));
          } else if (h.source === "pubky" && backend === "pubky") {
            const p = await import("./pubky.js");
            await p.remove(h.id, p.pageKey(url));
          }
        })();
        const slowHint = setTimeout(() => alertNote(box, "Still working — your Nostr signer may be asking for approval (check the extension icon)."), 2500);
        Promise.race([bg, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000))])
          .then(() => { clearTimeout(slowHint); alertNote(box, "Deleted — including the synced copy."); })
          .catch((e) => { clearTimeout(slowHint); alertNote(box, "Removed here, but the synced copy may not be deleted yet (" + (e.message || e) + ") — approve the request in your signer, or delete again if it reappears."); });
      });
      foot.appendChild(del);
      card.appendChild(foot);
      sec.appendChild(card);
    }
    box.appendChild(sec);
  }
}

function alertNote(box, msg) {
  const n = el("p", "hl-note", msg);
  box.prepend(n);
  setTimeout(() => n.remove(), 6000);
}
