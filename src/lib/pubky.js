// Pubky layer for reader highlights — Pubky Auth sign-in (approve in Pubky Ring)
// + homeserver storage. Highlights are stored under the reader's OWN homeserver
// at /pub/timechain.wiki/highlights/<pathKey>/<id>.json, so they follow the
// reader across devices. Lazy-loaded by the annotation controller: the SDK is a
// ~1.7 MB WASM bundle, kept off the page for anyone who isn't using Pubky.
import { Pubky, AuthFlowKind, Session } from "@synonymdev/pubky";
import qrcode from "qrcode-generator";

const APP = "timechain.wiki";
const CAPS = `/pub/${APP}/:rw`;          // read/write our app's dir on the homeserver
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
const dir = (k) => `/pub/${APP}/highlights/${k}/`;
const file = (k, id) => `/pub/${APP}/highlights/${k}/${id}.json`;

export function hasSession() { return !!session; }

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
  const flow = client().startAuthFlow(CAPS, AuthFlowKind.signin());
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
    const flow = client().resumeAuthFlow(url);
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
    try { session = await Session.restore(u.export); } catch {}
  }
  return u;
}

export async function logout() {
  try { if (session) await session.signout(); } catch {}
  session = null;
  try { localStorage.removeItem(AUTH_KEY); } catch {}
}

export async function publish(hl, key) {
  if (!session) throw new Error("not-signed-in");
  const rec = { id: hl.id, url: hl.url, anchor: hl.anchor, note: hl.note || "", createdAt: hl.createdAt || Date.now() };
  await session.storage.putJson(file(key, hl.id), rec);
  return hl.id;
}

export async function remove(id, key) {
  if (!session) return;
  try { await session.storage.delete(file(key, id)); } catch {}
}

// The reader's pubky.app profile (name + avatar), if they have one. Best-effort:
// many Pubky Ring users have no pubky.app profile, so null is normal.
export async function getProfile() {
  if (!session) return null;
  try {
    const prof = await session.storage.getJson("/pub/pubky.app/profile.json");
    if (!prof) return null;
    let image = null;
    const img = prof.image;
    if (typeof img === "string" && img) {
      if (/^https?:\/\//.test(img)) image = img;
      else {
        try {
          const path = img.startsWith("pubky://") ? img.replace(/^pubky:\/\/[^/]+/, "") : (img.startsWith("/pub/") ? img : null);
          if (path) { const bytes = await session.storage.getBytes(path); image = URL.createObjectURL(new Blob([bytes])); }
        } catch {}
      }
    }
    return { name: prof.name || null, image };
  } catch { return null; }
}

// Fetch this page's highlights from the homeserver.
export async function fetch(key) {
  if (!session) return [];
  let urls = [];
  try { urls = await session.storage.list(dir(key)); } catch { return []; }
  const out = [];
  for (const u of urls) {
    const path = u.replace(/^pubky:\/\/[^/]+/, ""); // list gives pubky://<user>/pub/… → session path
    try {
      const rec = await session.storage.getJson(path);
      const id = path.split("/").pop().replace(/\.json$/, "");
      out.push({ id, source: "pubky", anchor: rec.anchor, note: rec.note || "", createdAt: rec.createdAt || 0 });
    } catch {}
  }
  return out;
}
