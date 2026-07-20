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

// Begin a sign-in flow. Returns the pubkyauth:// URL (deep link) + a QR SVG to
// show, and a promise that resolves to the user once approved in Pubky Ring.
export function startLogin() {
  const flow = client().startAuthFlow(CAPS, AuthFlowKind.signin());
  const url = flow.authorizationUrl;
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const qrSvg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  const approved = flow.awaitApproval().then((s) => {
    session = s;
    const pk = s.info.publicKey.toString();
    const u = { method: "pubky", pubky: pk, label: shortId(pk), export: s.export() };
    store(u);
    return u;
  });
  return { url, qrSvg, approved };
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
