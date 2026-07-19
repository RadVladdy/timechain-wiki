// Text anchoring for reader highlights. A highlight is stored as a robust
// text-quote descriptor (exact text + a little surrounding context + an
// approximate character position) so it can be re-found later even if the
// surrounding markup shifts. Anchors are resolved to a DOM Range and painted
// with the CSS Custom Highlight API — no DOM surgery, so the article markup is
// never mutated. Pure module, no dependencies.

const CTX = 40; // chars of prefix/suffix context stored for disambiguation

// Walk the visible text nodes of `root`, building one concatenated string and a
// map from global character offset back to (node, offset).
function textMap(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest("script,style,.tw-skip")) return NodeFilter.FILTER_REJECT;
      return n.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let text = "";
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) {
    nodes.push({ node: n, start: text.length });
    text += n.nodeValue;
  }
  return { text, nodes };
}

// (node, offset) for a global character index.
function locate(nodes, index) {
  let lo = 0, hi = nodes.length - 1, hit = nodes[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid].start <= index) { hit = nodes[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return { node: hit.node, offset: index - hit.start };
}

function rangeFor(nodes, start, end) {
  const a = locate(nodes, start), b = locate(nodes, end);
  const r = document.createRange();
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  return r;
}

// Build a stored descriptor from a live selection Range inside `root`.
export function describe(root, range) {
  const { text, nodes } = textMap(root);
  const exact = range.toString();
  if (!exact.trim()) return null;
  // Find where this range starts in the concatenated text.
  const pre = document.createRange();
  pre.setStart(nodes[0].node, 0);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const end = start + exact.length;
  return {
    exact,
    prefix: text.slice(Math.max(0, start - CTX), start),
    suffix: text.slice(end, end + CTX),
    pos: start,
  };
}

// Re-find a stored descriptor as a DOM Range, or null if the text is gone.
// Prefers the prefix+exact+suffix match, then the exact occurrence nearest the
// stored position, so repeated phrases resolve to the right one.
export function resolve(root, d) {
  if (!d || !d.exact) return null;
  const { text, nodes } = textMap(root);
  if (!nodes.length) return null;

  const withCtx = (d.prefix || "") + d.exact + (d.suffix || "");
  let i = text.indexOf(withCtx);
  if (i !== -1) {
    const s = i + (d.prefix ? d.prefix.length : 0);
    return rangeFor(nodes, s, s + d.exact.length);
  }
  // Fall back to the exact occurrence closest to the remembered position.
  let best = -1, bestDist = Infinity, from = 0;
  while ((i = text.indexOf(d.exact, from)) !== -1) {
    const dist = Math.abs(i - (d.pos ?? 0));
    if (dist < bestDist) { bestDist = dist; best = i; }
    from = i + 1;
  }
  if (best === -1) return null;
  return rangeFor(nodes, best, best + d.exact.length);
}

// Which stored highlight (if any) sits under a click point — for click-to-open.
// Uses the caret at the point and tests containment against each resolved range.
export function hitTest(root, highlights, x, y) {
  let caret = null;
  if (document.caretPositionFromPoint) {
    const c = document.caretPositionFromPoint(x, y);
    if (c) { caret = document.createRange(); caret.setStart(c.offsetNode, c.offset); caret.collapse(true); }
  } else if (document.caretRangeFromPoint) {
    caret = document.caretRangeFromPoint(x, y);
  }
  if (!caret) return null;
  for (const h of highlights) {
    const r = resolve(root, h.anchor);
    if (r && r.isPointInRange(caret.startContainer, caret.startOffset)) return h;
  }
  return null;
}
