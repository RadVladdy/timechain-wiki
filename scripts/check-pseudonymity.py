#!/usr/bin/env python3
"""Pseudonymity check — nothing that identifies the author may reach a public surface.

WHY THIS EXISTS. On 2026-07-30 the owner's real first name shipped to production on
bitcoinkeys.guide in THREE places at once, all from a single day's commenting habit,
and he found it on his own site before any check did. This runs before every push now.

Two mechanisms did it, and neither is obvious:

  1. AN HTML COMMENT IN AN .astro TEMPLATE SHIPS TO THE BROWSER. `<!-- ... -->` is
     not a build-time comment; it is output. Every internal note written that way is
     readable in view-source. Thirty-three of them were.

  2. `{/* ... */}` INSIDE A JAVASCRIPT TEMPLATE LITERAL IS NOT A COMMENT — it is
     literal text, and it RENDERS ON THE PAGE. That one was visible to any reader,
     mid-card, in the middle of a recommendation. Same family as the
     `${...}`-in-a-plain-quoted-attribute trap: template syntax inside a string is
     just characters.

The root cause behind both was writing session narrative and decision attribution
into source comments — "X's call", "X caught it", quoted chat, dated blow-by-blow.
That does not belong in a code repository at all, correctly formatted or not.
Internal reasoning lives in the Obsidian vault. A comment in a site repo states the
technical constraint it protects, never who asked or when. This script also greps
for that shape (§4) and warns, because the identifier list only catches the names
you thought to list.

The safe place for a build-time note in an .astro file is the `---` frontmatter
block, as `//` comments. Those are compiled away and never ship.

Usage:  python3 scripts/check-pseudonymity.py     (exits non-zero on a finding)
        --warn-only   report §4 narrative hits without failing the build
        --stdin       scan text on stdin instead of the repo, using THIS repo's
                      identifier list and allowlist. Lets an outside caller (the
                      nightly sweep, checking commit messages) reuse the tuned
                      per-site config instead of keeping a second copy that drifts.
"""
import re
import sys
import pathlib

# ── per-site configuration ──────────────────────────────────────────────────
# The ONLY part of this file that differs between repos. Everything below is
# identical everywhere on purpose: one script, one behaviour, one thing to fix.
SITE = 'timechain.wiki'
BUILT = ['dist']        # what the public can actually fetch
SOURCE = ['src', 'sync-kb.py']      # what gets scanned for the two mechanisms
# Strings that legitimately match an identifier and must not fail the build.
# Every entry needs a reason — an unexplained exception is how a real hit gets
# waved through later by someone who assumes it was considered.
ALLOWED = [
           r'Brett\s+\w+',  # the author of 'The Heretic's Guide to Global Finance', cited on /wiki/mt-gox — a real surname that collides with the identifier list,
           r'noreply',  # git noreply addresses
]
# Whole paths excluded from the identifier scan (vendored bundles we do not author).
EXCLUDE_PATHS = ['dist/pagefind/']

# ── identifiers ─────────────────────────────────────────────────────────────
# The names to look for are NOT stored in this repo — that would put the very
# string we are trying to keep out of it back into it, in the file whose whole job
# is to keep it out. They live in one untracked local file shared by every site,
# one pattern per line:
#
#     ~/.config/pseudonymity-identifiers.txt
#
# One list, not one per repo: a name added once must start failing everywhere, and
# six copies drift.
#
# Structural identifiers that name nobody (home paths, personal mail hosts) are
# built in, so the check still does useful work if that file is missing — but it
# says loudly that it is running degraded rather than printing a clean pass.
STRUCTURAL = [
    r'/Users/[a-z]+',                  # a Mac home directory (case-sensitive: an
                                       # /api/users/ route is not a home directory)
    r'/home/(?!runner\b)[a-z]+/',      # a Linux home directory (runner = CI)
    r'[a-z0-9._%+-]+@gmail\.com',
]
NAMES_FILE = pathlib.Path.home() / '.config' / 'pseudonymity-identifiers.txt'
names = []
if NAMES_FILE.exists():
    names = [l.strip() for l in NAMES_FILE.read_text().splitlines()
             if l.strip() and not l.startswith('#')]

STRUCT_RE = re.compile('|'.join(STRUCTURAL))
NAME_RE = re.compile('|'.join(r'\b' + n + r'\b' for n in names), re.I) if names else None
ALLOWED_RE = re.compile('|'.join(ALLOWED), re.I) if ALLOWED else None

# Comments that narrate a session or attribute a decision to a person, rather than
# stating the constraint they protect. These are the ROOT CAUSE, and they are not
# caught by the identifier list — "he wanted this" names nobody and is still wrong.
#
# Only the first of these is unambiguous enough to fail a push. The rest are
# warnings on purpose: this script cannot tell "he wanted the tight crop" from
# "old callers get what they asked for", and a check that fails on ordinary
# technical English is a check that gets commented out. Warnings are printed
# every push and are meant to be read, not accumulated.
NARRATIVE_FAIL = [
    (r"\b\w+'s call\b", 'a decision attributed to a person'),
]
NARRATIVE = NARRATIVE_FAIL + [
    (r'\b(he|she|they)\s+(wanted|said|caught|decided|objected|prefers)\b',
                                                          'third-person narration'),
    (r'\b(asked|caught|flagged|spotted|noticed)\s+(me|this)\b',
                                                          'session narration'),
    (r'\b(I|we)\s+(decided|chose|reverted|renamed|caught)\b',
                                                          'first-person session log'),
    (r'\b20\d\d-\d\d-\d\d\b.{0,40}\b(said|asked|wanted|objected|caught)\b',
                                                          'dated blow-by-blow'),
]
FAIL_RE = re.compile('|'.join(p for p, _ in NARRATIVE_FAIL), re.I)

TEXT_EXT = {'.html', '.js', '.mjs', '.cjs', '.css', '.xml', '.txt', '.json', '.md'}
SRC_EXT = {'.astro', '.js', '.mjs', '.cjs', '.jsx', '.tsx', '.ts', '.svelte', '.vue',
           '.html', '.css', '.py', '.md'}
SKIP_DIRS = {'node_modules', '.git', '.wrangler', '.astro', '.cache', '__pycache__', 'venv'}


def excluded(p):
    s = p.as_posix()
    return any(x in s for x in EXCLUDE_PATHS)


def scan(text):
    """Yield (kind, start, end) for every identifier hit that is not allowlisted."""
    for rx, kind in ((NAME_RE, 'NAME'), (STRUCT_RE, 'PATH/MAIL')):
        if rx is None:
            continue
        for m in rx.finditer(text):
            window = text[max(0, m.start() - 40):m.end() + 40]
            if ALLOWED_RE and ALLOWED_RE.search(window):
                continue
            yield kind, m.start(), m.end()


def ctx(text, s, e):
    return re.sub(r'\s+', ' ', text[max(0, s - 90):e + 70])


def walk(root, exts):
    # A SOURCE/BUILT entry may name a single file (sync-kb.py) as well as a dir.
    if root.is_file():
        if not excluded(root):
            yield root
        return
    if not root.is_dir():
        return
    for p in root.rglob('*'):
        if any(d in p.parts for d in SKIP_DIRS) or excluded(p):
            continue
        if p.is_file() and p.suffix in exts and p.stat().st_size < 5_000_000:
            yield p


# --stdin: same identifiers, same allowlist, arbitrary text. Report and exit.
if '--stdin' in sys.argv:
    _t = sys.stdin.read()
    _hits = [f'    {_t[max(0, s - 80):e + 60].strip()}' for _k, s, e in scan(_t)]
    if not NAMES_FILE.exists():
        print(f'DEGRADED: {NAMES_FILE} missing'); sys.exit(2)
    if _hits:
        print(f'{len(_hits)} identifier hit(s) in the supplied text:')
        print('\n'.join(_hits))
        sys.exit(1)
    sys.exit(0)

fails, warns = [], []
repo = pathlib.Path(__file__).resolve().parent.parent
warn_only = '--warn-only' in sys.argv   # downgrade §4's hard fail while mid-cleanup

# ── 1. the built output — what the public can actually read ─────────────────
for d in BUILT:
    for f in walk(repo / d, TEXT_EXT):
        try:
            text = f.read_text(errors='replace')
        except Exception:
            continue
        for kind, s, e in scan(text):
            fails.append(f'{kind} IN BUILT OUTPUT  {f.relative_to(repo)}\n    …{ctx(text, s, e)}…')

# ── 2/3. the two mechanisms, so the next one is caught before it ships ──────
for d in SOURCE:
    for f in walk(repo / d, SRC_EXT):
        try:
            text = f.read_text(errors='replace')
        except Exception:
            continue
        rel = f.relative_to(repo)
        for kind, s, e in scan(text):
            fails.append(f'{kind} IN SOURCE  {rel}:{text[:s].count(chr(10)) + 1}'
                         f'\n    …{ctx(text, s, e)}…')

        # An HTML comment in template position SHIPS. In .astro the frontmatter
        # block is compiled away, so only the body counts.
        if f.suffix in ('.astro', '.html', '.svelte', '.vue'):
            body = text.split('---', 2)[-1] if (f.suffix == '.astro' and text.startswith('---')) else text
            for m in re.finditer(r'<!--.*?-->', body, re.S):
                if any(scan(m.group(0))):
                    fails.append(f'IDENTIFIER IN AN HTML COMMENT (these SHIP)  {rel}'
                                 f'\n    {re.sub(chr(10), " ", m.group(0))[:140]}')

        # A {/* */} inside a template literal is not a comment — it renders as text.
        # Only meaningful where template literals build markup; in .jsx/.tsx a
        # {/* */} is an ordinary, correct JSX comment, so those are not scanned.
        if f.suffix in ('.astro', '.js', '.mjs', '.cjs'):
            for m in re.finditer(r'\{/\*.*?\*/\}', text, re.S):
                if text[:m.start()].count('`') % 2 == 1:
                    fails.append(
                        f'JSX COMMENT INSIDE A TEMPLATE LITERAL — RENDERS AS TEXT  {rel}'
                        f'\n    {re.sub(chr(10), " ", m.group(0))[:140]}')

        # ── 4. the root cause: comments that narrate instead of constrain ────
        # Markdown is prose, not code — `//` inside a URL is not a comment, and
        # this file's own docstring quotes the patterns it hunts for.
        if f.suffix == '.md' or f.name == 'check-pseudonymity.py':
            continue
        cmts = (list(re.finditer(r'#.*', text)) if f.suffix == '.py'
                else list(re.finditer(r'(?<![:/])//.*', text))
                + list(re.finditer(r'/\*[\s\S]*?\*/', text))
                + list(re.finditer(r'<!--[\s\S]*?-->', text)))
        for c in cmts:
            for pat, why in NARRATIVE:
                if re.search(pat, c.group(0), re.I):
                    line = f'{rel}:{text[:c.start()].count(chr(10)) + 1}  [{why}]' \
                           f'\n    {re.sub(chr(10), " ", c.group(0))[:140]}'
                    (fails if FAIL_RE.search(c.group(0)) and not warn_only else warns).append(line)
                    break

# ── report ──────────────────────────────────────────────────────────────────
if warns:
    print(f'-- {len(warns)} comment(s) narrate a session rather than state a constraint.')
    print('   Internal reasoning belongs in the vault, not in this repo:\n')
    for w in warns[:20]:
        print('  ' + w + '\n')
    if len(warns) > 20:
        print(f'  … +{len(warns) - 20} more\n')

if not NAMES_FILE.exists():
    print(f'!! DEGRADED: {NAMES_FILE} is missing, so only structural identifiers were')
    print('   checked. Recreate it (one name per line) before trusting a clean result.')
    sys.exit(2)

if fails:
    print(f'!! PSEUDONYMITY CHECK FAILED — {SITE}\n')
    for f in fails:
        print('  ' + f + '\n')
    print(f'{len(fails)} finding(s). Move internal notes into the vault; in .astro, a '
          'build-time note goes in the --- frontmatter as a // comment.')
    sys.exit(1)

print(f'clean — {SITE}: no identifying content in the built output, none in source, '
      'no HTML comment carrying one, no JSX comment inside a template literal'
      + (', no narrative comments' if not warns else ''))
