#!/usr/bin/env python3
"""Timechain Wiki — one-way sync: Bitcoin KB → Astro content collection.

Copies every published Bitcoin-KB note into src/content/wiki/<slug>.md, stripping
the internal-only '## Editor's Notes' section (exact-heading anchor → EOF). The KB
stays source-of-truth; this never writes back. A post-copy guard fails loudly if
any internal marker survives.
"""
import glob, os, re, shutil, sys

SRC = "/home/radvladdy/Obsidian/Obsidian_RadVladdy/30-Knowledge/Bitcoin"
DST = os.path.join(os.path.dirname(__file__), "src", "content", "wiki")

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

def main():
    if os.path.isdir(DST):
        shutil.rmtree(DST)
    os.makedirs(DST)
    files = [f for f in glob.glob(os.path.join(SRC, "*.md"))
             if not os.path.basename(f).startswith("_") and os.path.basename(f) != "CLAUDE.md"]
    slugs, copied, stripped = {}, 0, 0
    for f in sorted(files):
        base = os.path.basename(f)[:-3]
        slug = slugify(base)
        if slug in slugs:
            print(f"SLUG COLLISION: {base!r} vs {slugs[slug]!r} → {slug}", file=sys.stderr)
        slugs[slug] = base
        txt = open(f, encoding="utf-8").read()
        out, did = strip_editor(txt)
        out = demote_callouts(out)
        copied += 1; stripped += did
        open(os.path.join(DST, slug + ".md"), "w", encoding="utf-8").write(out)
    # write a slug/title index for wikilink resolution + nav
    idx = os.path.join(os.path.dirname(__file__), "src", "lib", "wiki-index.json")
    import json
    os.makedirs(os.path.dirname(idx), exist_ok=True)
    json.dump({s: t for s, t in slugs.items()}, open(idx, "w", encoding="utf-8"), indent=0, ensure_ascii=False)
    print(f"synced {copied} notes → {DST} (stripped {stripped} Editor's Notes, {len(slugs)} slugs)")

    # leak guard
    leaks = []
    for p in glob.glob(os.path.join(DST, "*.md")):
        t = open(p, encoding="utf-8").read()
        if "## Editor's Notes" in t or "Internal-only — excluded" in t:
            leaks.append(os.path.basename(p))
    if leaks:
        print(f"LEAK GUARD FAILED — internal content survived in: {leaks}", file=sys.stderr)
        sys.exit(1)
    print("leak guard: clean (0 Editor's Notes sections in output)")

if __name__ == "__main__":
    main()
