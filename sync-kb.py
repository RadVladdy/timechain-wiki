#!/usr/bin/env python3
"""Timechain Wiki — one-way sync: Bitcoin KB → Astro content collection.

Copies every published Bitcoin-KB note into src/content/wiki/<slug>.md, stripping
the internal-only '## Editor's Notes' section (exact-heading anchor → EOF). The KB
stays source-of-truth; this never writes back. A post-copy guard fails loudly if
any internal marker survives.

It also parses each sub-MOC into its cluster -> entry structure (the walk-down that
the Phase-2 section pages render) and emits src/lib/sections-data.json. Cluster
membership lives only in the sub-MOC prose (notes carry `area`, not `cluster`), so
it is parsed here in the deterministic sync layer rather than hand-maintained.
"""
import glob, os, re, shutil, sys, json

SRC = "/home/radvladdy/Obsidian/Obsidian_RadVladdy/30-Knowledge/Bitcoin"
DST = os.path.join(os.path.dirname(__file__), "src", "content", "wiki")
LIB = os.path.join(os.path.dirname(__file__), "src", "lib")

EDITOR_RE = re.compile(r"^## Editor's Notes[ \t]*$", re.M)   # exact heading, not a prefix
CALLOUT_RE = re.compile(r"(?m)^(>[ \t]*)\[!\w+\][-+]?[ \t]?")  # demote Obsidian callout markers


def demote_callouts(txt):
    return CALLOUT_RE.sub(r"\1", txt)


def slugify(name):
    s = name.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def strip_editor(txt):
    m = EDITOR_RE.search(txt)
    if not m:
        return txt, False
    body = re.sub(r"\n+---\s*$", "\n", txt[:m.start()])
    return body.rstrip() + "\n", True


# ── sub-MOC cluster parser ──────────────────────────────────────────────────
# A cluster is a `##` section that lists concept-note entries. The KB's sub-MOC
# template also uses a stable set of *structural* `##` sections (how-to-use,
# analytical voices, canonical sources, key connections, related notes, …) — those
# are not walk-down clusters and are filtered out. The filter is a keyword denylist
# keyed on the KB's own template headings (durable because the KB is internally
# consistent) plus the "The …" structural-preamble convention.

META_KEYWORDS = (
    "how to use", "voice register", "intellectual structure", "conceptual layering",
    "conceptual structure", "shape of the section", "structure of the section",
    "framing lenses", "criticism-controversy paired", "suggested reading",
    "doesn't cover", "key connections", "cross-area connections", "open questions",
    "canonical sources", "related notes", "editor's notes", "by learning level",
    "analytical voices", "pre-existing infrastructure", "source pages cross-listed",
)

# Bullet lines at/after any of these markers are placeholder/pointer chatter, not entries.
STOP_MARKERS = ("future candidate", "these are placeholder", "no entries yet")

WIKILINK = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")
LEVEL_RE = re.compile(r"\*\*Level:?\s*([^*]+?)\s*\*\*", re.I)
MEDIUM_RE = re.compile(r"_\((video|website)\)_", re.I)
HOME_RE = re.compile(r"_\(home:\s*([^)]*)\)_", re.I)
LEAD_PAREN = re.compile(r"^\([^)]*\)\s*")


def is_meta_heading(title):
    t = title.strip().lower()
    if t.startswith("the "):
        return True
    return any(k in t for k in META_KEYWORDS)


def clean_prose(s):
    """Strip wiki/markdown decoration from a fragment for card/intro text."""
    s = WIKILINK.sub(lambda m: (m.group(2) or m.group(1)).strip(), s)
    s = LEVEL_RE.sub("", s)
    s = MEDIUM_RE.sub("", s)
    s = HOME_RE.sub("", s)
    s = re.sub(r"\*\*|\*|`", "", s)
    s = re.sub(r"\s+", " ", s).strip(" —-·.\t")
    return s.strip()


def truncate(s, n):
    if len(s) <= n:
        return s
    cut = s[:n].rsplit(" ", 1)[0]
    return cut.rstrip(" ,;—-") + "…"


def _desc(s):
    s = LEAD_PAREN.sub("", clean_prose(s)).strip(" —-·.,;:\t")
    return truncate(s, 190)


def parse_entry(line, slugs):
    """A cluster bullet -> an entry dict, or None if it isn't a real entry."""
    body = line[2:].strip()  # drop leading "- "
    level_m = LEVEL_RE.search(body)
    level = level_m.group(1).strip(" .") if level_m else None
    medium_m = MEDIUM_RE.search(body)
    medium = medium_m.group(1).lower() if medium_m else None

    # A `_(home: …)_` marker means this note is homed in another area (cross-listed
    # or a no-resource-competition pointer). Pull it out first so its inner wikilink
    # isn't mistaken for the entry, and keep its prose as a description fallback.
    home_m = HOME_RE.search(body)
    home_inner = home_m.group(1).strip() if home_m else ""
    home_link = WIKILINK.search(home_inner) if home_inner else None
    home_slug = slugify(home_link.group(1).strip()) if home_link else None
    home_desc = re.sub(r"^[\w][\w'\- ]*?—\s*", "", clean_prose(home_inner))  # drop "criticisms — "
    crosslisted = bool(home_m) or "cross-list" in body.lower()
    outer = HOME_RE.sub("", body)  # body without the home marker

    link = WIKILINK.search(outer)
    if link:
        target = link.group(1).strip()
        display = (link.group(2) or link.group(1)).strip()
        slug = slugify(target)
        desc = _desc(outer[link.end():]) or truncate(home_desc, 190)
        return {
            "title": display, "slug": slug, "hasPage": slug in slugs,
            "level": level, "medium": medium, "crosslisted": crosslisted,
            "desc": desc,
        }
    # No outer wikilink → a pointer bullet (e.g. `*Podcast* … _(home: [[Thinker]])_`).
    # Title is the leading italic/plain name; it links to where the note is homed.
    if home_slug or level:
        lead = outer.split("—")[0].split(" _(")[0].strip()
        title = truncate(clean_prose(lead), 80) or "Reference"
        return {
            "title": title, "slug": home_slug,
            "hasPage": bool(home_slug) and home_slug in slugs,
            "level": level, "medium": medium, "crosslisted": True,
            "desc": _desc(outer) or truncate(home_desc, 190),
        }
    return None


def parse_submoc(txt, slugs):
    """Return (summary, [clusters]) for one sub-MOC's body text."""
    summary = ""
    m = re.search(r"^>\s*\[!summary\]\s*(.+?)(?:\n>|\n\n|\n---)", txt, re.S | re.M)
    if m:
        summary = truncate(clean_prose(m.group(1).replace("\n>", " ")), 320)

    clusters = []
    heads = list(re.finditer(r"^## (.+?)\s*$", txt, re.M))
    for i, h in enumerate(heads):
        title = h.group(1).strip()
        if is_meta_heading(title):
            continue
        seg = txt[h.end(): heads[i + 1].start() if i + 1 < len(heads) else len(txt)]

        entries, intro_lines, stop = [], [], False
        collecting_intro = True
        for raw in seg.splitlines():
            line = raw.rstrip()
            low = line.strip().lower()
            if any(mk in low for mk in STOP_MARKERS):
                stop = True
            if line.startswith("- ") and not stop:
                collecting_intro = False
                e = parse_entry(line, slugs)
                if e:
                    entries.append(e)
            elif collecting_intro:
                s = line.strip()
                if not s:
                    if intro_lines:
                        collecting_intro = False  # first paragraph ended
                    continue
                if s.startswith(("-", ">", "#", "|")) or re.match(r"^\d+\.", s) or \
                   (s.startswith("**") and s.endswith("**")) or s.startswith("*("):
                    collecting_intro = False
                    continue
                intro_lines.append(s)

        if not entries:
            continue
        clusters.append({
            "title": title,
            "intro": truncate(clean_prose(" ".join(intro_lines)), 240),
            "entries": entries,
        })
    return summary, clusters


def main():
    if os.path.isdir(DST):
        shutil.rmtree(DST)
    os.makedirs(DST)
    files = [f for f in glob.glob(os.path.join(SRC, "*.md"))
             if not os.path.basename(f).startswith("_") and os.path.basename(f) != "CLAUDE.md"]

    slugs, copied, stripped, sources = {}, 0, 0, {}
    for f in sorted(files):
        base = os.path.basename(f)[:-3]
        slug = slugify(base)
        if slug in slugs:
            print(f"SLUG COLLISION: {base!r} vs {slugs[slug]!r} → {slug}", file=sys.stderr)
        slugs[slug] = base
        txt = open(f, encoding="utf-8").read()
        sources[slug] = txt
        out, did = strip_editor(txt)
        out = demote_callouts(out)
        copied += 1; stripped += did
        open(os.path.join(DST, slug + ".md"), "w", encoding="utf-8").write(out)

    # slug/title index for wikilink resolution + nav
    os.makedirs(LIB, exist_ok=True)
    json.dump({s: t for s, t in slugs.items()},
              open(os.path.join(LIB, "wiki-index.json"), "w", encoding="utf-8"),
              indent=0, ensure_ascii=False)
    print(f"synced {copied} notes → {DST} (stripped {stripped} Editor's Notes, {len(slugs)} slugs)")

    # parse sub-MOCs → cluster/entry walk-down data (parse from source, pre-strip)
    sections, n_clusters, n_entries = {}, 0, 0
    for slug, txt in sources.items():
        fm = re.match(r"^---\n(.*?)\n---", txt, re.S)
        if not fm or "type: sub-MOC" not in fm.group(1):
            continue
        body, _ = strip_editor(txt)  # never parse the internal section
        summary, clusters = parse_submoc(body, slugs)
        sections[slug] = {"summary": summary, "clusters": clusters}
        n_clusters += len(clusters)
        n_entries += sum(len(c["entries"]) for c in clusters)
    json.dump(sections, open(os.path.join(LIB, "sections-data.json"), "w", encoding="utf-8"),
              indent=0, ensure_ascii=False)
    print(f"parsed {len(sections)} sub-MOCs → {n_clusters} clusters, {n_entries} entries")

    # leak guard
    leaks = []
    for p in glob.glob(os.path.join(DST, "*.md")):
        t = open(p, encoding="utf-8").read()
        if "## Editor's Notes" in t or "Internal-only — excluded" in t:
            leaks.append(os.path.basename(p))
    # the parsed nav data is a second leak surface — scan it too
    navtext = json.dumps(sections, ensure_ascii=False)
    if "Internal-only — excluded" in navtext or "## Editor's Notes" in navtext:
        leaks.append("sections-data.json")
    if leaks:
        print(f"LEAK GUARD FAILED — internal content survived in: {leaks}", file=sys.stderr)
        sys.exit(1)
    print("leak guard: clean (0 Editor's Notes sections in output or nav data)")


if __name__ == "__main__":
    main()
