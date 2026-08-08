#!/usr/bin/env python3
"""Pseudonymity check — nothing that identifies the author may reach a public surface.

WHY THIS EXISTS. On 2026-07-30 the owner's real first name shipped to production on
bitcoinkeys.guide in THREE places at once, all from a single day's commenting habit,
and he found it on his own site before any check did. This runs before every push now.

Two mechanisms did it, and neither is obvious:

  1. AN HTML COMMENT IN AN .astro TEMPLATE SHIPS TO THE BROWSER. `<!-- ... -->` is
     not a build-time comment; it is output. Every internal note written that way is
     readable in view-source. Thirty-three of them were.

     SINCE 2026-07-31 THIS FAILS ON *ANY* SUCH COMMENT, not only one carrying a name.
     The identifier list catches the names someone thought to list; the broader rule
     is that internal notes have no business on a public page. A sweep found 28 in
     source producing 232 in the built output — the ones in Nav.astro and Base.astro
     multiply by every page on the site. None of those named a person, so this
     check passed while they shipped.

     Where a note belongs instead, all three verified stripped from the build:
       • explaining MARKUP           → the `---` frontmatter, as `//`
       • explaining a <style> block  → inside it, as `/* */`
       • explaining a bundled        → inside it, as `//`
         <script>                      (NOT `is:inline` — that is emitted verbatim)

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
                      identifier list, allowlist and §4 narrative patterns. Lets an
                      outside caller reuse the tuned per-site config instead of
                      keeping a second copy that drifts. Its caller in this repo is
                      scripts/check-commit-messages.py, which is the gate over the
                      fourth surface — history — that this file cannot see.

THE SURFACE THIS FILE DOES NOT COVER. Pseudonymity has four surfaces: authorship,
content, history, built output. This script reads the SOURCE and BUILT roots
configured below, so it speaks to content and built output only, and it has never
read a commit message. On
2026-08-05 that gap was measured: 13 of 273 commit messages named the owner while
this check exited 0 and was being cited as proof the repo was clean. History is
now gated by scripts/check-commit-messages.py, which delegates here via --stdin.
A clean run of THIS script is not a four-surface result and must not be reported
as one.
"""
import re
import sys
import pathlib

# ── per-site configuration ──────────────────────────────────────────────────
# The ONLY part of this file that differs between repos. Everything below is
# identical everywhere on purpose: one script, one behaviour, one thing to fix.
SITE = 'timechain.wiki'
BUILT = ['dist']        # what the public can actually fetch
SOURCE = ['.']      # the WHOLE repo: the root's own files are a public
                    # surface too (README, CLAUDE.md, package.json,
                    # wrangler.jsonc, .githooks/), and until 2026-08-07
                    # they were scanned by nothing. SOURCE_SKIP_DIRS keeps
                    # dist/ out of this pass; BUILT reads it instead.
# Strings that legitimately match an identifier and must not fail the build.
# Every entry needs a reason — an unexplained exception is how a real hit gets
# waved through later by someone who assumes it was considered.
ALLOWED = [
           r'Brett\s+\w+',  # the author of 'The Heretic's Guide to Global Finance', cited on /wiki/mt-gox — a real surname that collides with the identifier list,
           r'noreply',  # git noreply addresses
]
# Whole paths excluded from the identifier scan (vendored bundles we do not author).
EXCLUDE_PATHS = [
    'dist/pagefind/',   # a generated search index, not authored here
    # A local, untracked, gitignored (.gitignore:15) one-line pointer to this
    # machine's KB checkout. It holds a home directory path by design and it
    # cannot reach GitHub or the deploy, so it is not a public surface. It only
    # became visible on 2026-08-07 when SOURCE widened to the repo root.
    '.kb-path',
]

# ── identifiers ─────────────────────────────────────────────────────────────
# The names to look for are NOT stored in this repo — that would put the very
# string we are trying to keep out of it back into it, in the file whose whole job
# is to keep it out. They live in one untracked local file shared by every site,
# one literal identifier per line:
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
# re.escape, so the list is read as literal identifiers and cannot widen itself.
# A name is data, not a pattern: an unescaped '.' matches any character and an
# unescaped metacharacter at the edge defeats the \b anchors either side of it,
# so a single stray punctuation mark in that file silently changes what every
# repo's gate matches. Escaping makes the guarantee structural rather than a
# property of whatever happens to be listed today.
NAME_RE = re.compile('|'.join(r'\b' + re.escape(n) + r'\b' for n in names), re.I) if names else None
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

# WHICH FILES GET READ AT ALL. An extension filter is a claim that every copy of
# the thing you are hunting lives in a file with an extension, and that claim has
# been false in this codebase twice: `_headers` carries a hand-written CSP and
# `.githooks/pre-push` is a shell script, both extensionless, and a repo root full
# of `.json`/`.jsonc` config was scanned by NOTHING until 2026-08-07 because
# neither extension was listed. `''` means "no suffix" and is deliberate; the
# is_text() sniff below is what keeps it from reading binaries.
TEXT_EXT = {'.html', '.js', '.mjs', '.cjs', '.css', '.xml', '.txt', '.json',
            '.jsonc', '.md', ''}
SRC_EXT = {'.astro', '.js', '.mjs', '.cjs', '.jsx', '.tsx', '.ts', '.mts', '.cts',
           '.svelte', '.vue', '.html', '.css', '.py', '.sh', '.md', '.json',
           '.jsonc', '.yml', '.yaml', '.toml', '.txt', '.xml', '.sql', ''}
SKIP_DIRS = {'node_modules', '.git', '.wrangler', '.astro', '.cache', '__pycache__', 'venv'}

# Directory names skipped by the SOURCE pass ONLY. They cannot go in SKIP_DIRS or
# in EXCLUDE_PATHS because both apply to every walk, and dist/ is precisely what
# the BUILT pass exists to read — excluding it there would send the built-output
# scan DEGRADED. This list only matters because SOURCE is now allowed to be the
# repo root, which is what put the root's own files (package.json, wrangler.jsonc,
# .githooks/pre-push, CLAUDE.md, README.md) inside some scan for the first time.
SOURCE_SKIP_DIRS = {'dist', 'build', 'out', '.next', '.svelte-kit', 'coverage'}

# Never read, in either pass. A .env is a secret file and never a public surface,
# so scanning it buys nothing and risks printing its contents into a build log.
SKIP_NAMES = {'.env'}


def excluded(p):
    s = p.as_posix()
    return any(x in s for x in EXCLUDE_PATHS)


def is_text(p):
    """True if the file is not binary. Only consulted for extensionless files —
    they are the interesting ones (`_headers`, `pre-push`, `LICENSE`) and also the
    dangerous ones (a suffix-less binary), and sniffing for a NUL byte decides it
    generically rather than by a list of filenames someone thought of."""
    try:
        with p.open('rb') as fh:
            return b'\0' not in fh.read(4096)
    except Exception:
        return False


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


def walk(root, exts, skip_dirs=()):
    # A SOURCE/BUILT entry may name a single file (sync-kb.py) as well as a dir.
    if root.is_file():
        if not excluded(root) and root.name not in SKIP_NAMES:
            yield root
        return
    if not root.is_dir():
        return
    for p in root.rglob('*'):
        if any(d in p.parts for d in SKIP_DIRS) or any(d in p.parts for d in skip_dirs):
            continue
        if excluded(p) or p.name in SKIP_NAMES:
            continue
        if not (p.is_file() and p.suffix in exts and p.stat().st_size < 5_000_000):
            continue
        if p.suffix == '' and not is_text(p):
            continue
        yield p


# --stdin: same identifiers, same allowlist, same narrative patterns, arbitrary
# text. The caller supplies prose that is not a file in this repo — a commit
# message being the case this exists for.
#
# It applies §4 as well as the identifier scan, and that is the point rather than
# a convenience: the 13 commit messages this mode was written to catch name a
# person AND narrate a session, and several would have been caught by only one of
# the two. Prose is scanned whole here, not comment-by-comment — a commit message
# is all comment.
#
# Tiering matches the file scan exactly, so there is one policy and not two:
# an identifier or a NARRATIVE_FAIL shape exits 1; the softer shapes print and
# exit 0. Anything stricter here would be a rule that exists only for commit
# messages, and a rule that lives in one place drifts from the one it copied.
if '--stdin' in sys.argv:
    _t = sys.stdin.read()
    _hits = [f'    …{ctx(_t, s, e)}…' for _k, s, e in scan(_t)]
    _narr, _soft = [], []
    for _pat, _why in NARRATIVE:
        for _m in re.finditer(_pat, _t, re.I):
            _line = f'    [{_why}] …{ctx(_t, _m.start(), _m.end())}…'
            (_narr if FAIL_RE.search(_m.group(0)) else _soft).append(_line)
    if not NAMES_FILE.exists():
        print(f'DEGRADED: {NAMES_FILE} missing'); sys.exit(2)
    # THE REASON FOR THE FAILURE PRINTS FIRST; the advisory warnings follow it.
    # This ordering is load-bearing rather than cosmetic, because every caller
    # truncates this output — the nightly sweep files only the first lines — so
    # whatever prints first is the only thing anyone reads. It used to be the other
    # way round, and on 2026-08-05 that hid a REAL finding: the sweep correctly
    # caught the owner's first name in the commit messages of three repos, two of
    # them public, but every visible line was a soft narrative warning, so the alert
    # read as noise and was recorded as a false positive. The names were only
    # removed because someone went and looked past the truncation.
    # A truncated alert must lose the noise, never the reason it fired.
    _failed = bool(_hits or _narr)
    if _failed:
        print(f'{len(_hits)} identifier hit(s), {len(_narr)} narrative hit(s) '
              'in the supplied text:')
        print('\n'.join(_hits + _narr))
    for _line in _soft:
        print(f'  -- narrates rather than states a constraint:\n  {_line}')
    sys.exit(1 if _failed else 0)

fails, warns = [], []
repo = pathlib.Path(__file__).resolve().parent.parent
warn_only = '--warn-only' in sys.argv   # downgrade §4's hard fail while mid-cleanup

# ── 1. the built output — what the public can actually read ─────────────────
# Count what each root actually YIELDED. A configured root that is missing or
# empty scans zero files and still falls through to the affirmative "clean"
# sentence at the bottom — a clean exit from a check that read nothing, which is
# indistinguishable from a clean exit from a check that read everything. `dist/`
# is gitignored, so absent is its ordinary state on a fresh clone or after a
# `git clean`, and that is precisely why it could not be left looking green.
#
# BUILT = [] is a DIFFERENT thing and is deliberately NOT degraded: a repo with
# no public surface configures no roots on purpose. The failure being caught here
# is a root that was configured and then read nothing.
#
# THE SAME COUNT IS KEPT FOR THE SOURCE ROOTS BELOW, and for a while it was not.
# Until 2026-08-07 only the BUILT loop counted, so deleting src/ made this script
# print its full affirmative "clean — … none in source, no HTML comment in template
# position …" sentence and exit 0 having read ZERO source files. A guard that
# covers one of two root lists is not a guard; it is a guard-shaped hole in the
# other one. Both lists feed this one list so there is a single place to look for
# "the run was blind".
blind = []
for d in BUILT:
    found = 0
    for f in walk(repo / d, TEXT_EXT):
        found += 1
        try:
            text = f.read_text(errors='replace')
        except Exception:
            continue
        for kind, s, e in scan(text):
            fails.append(f'{kind} IN BUILT OUTPUT  {f.relative_to(repo)}\n    …{ctx(text, s, e)}…')
    if found == 0:
        blind.append(('built output', d))

# ── 2/3. the two mechanisms, so the next one is caught before it ships ──────
for d in SOURCE:
    found = 0
    for f in walk(repo / d, SRC_EXT, SOURCE_SKIP_DIRS):
        found += 1
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
        #
        # ANY such comment fails, not just one carrying an identifier. The identifier
        # list only catches the names someone thought to list, and the wider rule is
        # that internal notes do not belong on a public page at all — 28 of these in
        # source became 232 in the built output, because the ones in Nav and Base
        # render on all 43 pages. Where each note belongs instead:
        #   • explaining MARKUP        → the `---` frontmatter, as `//` (compiled away)
        #   • explaining a <style>     → inside it as `/* */` (CSS comments are stripped)
        #   • explaining a bundled     → inside it as `//` (the bundler strips them)
        #     <script>                   — but NOT `is:inline`, which is emitted verbatim
        if f.suffix in ('.astro', '.html', '.svelte', '.vue'):
            body = text.split('---', 2)[-1] if (f.suffix == '.astro' and text.startswith('---')) else text
            for m in re.finditer(r'<!--.*?-->', body, re.S):
                inner = m.group(0)[4:-3].strip()
                if not inner:
                    continue          # <!-- --> spacers carry nothing
                kind = ('IDENTIFIER IN AN HTML COMMENT' if any(scan(m.group(0)))
                        else 'HTML COMMENT IN TEMPLATE POSITION')
                fails.append(f'{kind} (these SHIP to the reader)  {rel}'
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
        #
        # WHAT THIS SKIP DOES AND DOES NOT COST, measured 2026-08-06 across all six
        # repos, because it reads like a hole and is not one. The skip is §4 ONLY.
        # A .md file is still read for identifiers a few lines above — a name or a
        # home path in a card body FAILS the push, verified by planting one. What
        # escapes is the narrow case of a §4 shape that names nobody.
        #
        # DO NOT "FIX" THIS BY DELETING THE SKIP. Removing it was tested against
        # every .md file in all six repos: it catches nothing true and fires on nine
        # pieces of correct published prose, because in these repos markdown is the
        # PRODUCT, not commentary about it. §4 hunts session narrative in code
        # comments; the same shapes in a published surface are the writing. A
        # first-person essay legitimately says "I chose"; an encyclopedia entry
        # legitimately says "what he said". The only hard hits anywhere were four
        # possessives naming nobody, three of them a surface quoting an editorial
        # decision and one a card's re-home rationale, where the convention already
        # prescribes the impersonal form the text uses.
        #
        # A check that fires on the thing it is meant to protect is a check that
        # gets commented out, which is the reasoning the softer §4 patterns are
        # already warnings for.
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

    if found == 0:
        blind.append(('source', d))

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

# Same shape, same exit code, for the other way this check can read nothing and
# report clean. Kept beside its sibling so there is one place to look for "the
# run was blind" rather than two.
if blind:
    _roots = ', '.join(f'{d} ({which})' for which, d in blind)
    print(f'!! DEGRADED: {len(blind)} configured root(s) read ZERO files — {_roots} '
          f'{"is" if len(blind) == 1 else "are"} missing or empty.')
    print('   NOTHING here checked that surface. A clean exit from a scan that read')
    print('   nothing is indistinguishable from a clean exit from a scan that read')
    print('   everything, so it exits non-zero rather than print a pass it did not')
    print('   earn. A BUILT root missing usually means the build has not run — build')
    print('   first, then re-run. A SOURCE root missing means the path was renamed or')
    print('   removed and the per-site config above is now pointing at nothing.')
    sys.exit(2)

if fails:
    print(f'!! PSEUDONYMITY CHECK FAILED — {SITE}\n')
    for f in fails:
        print('  ' + f + '\n')
    print(f'{len(fails)} finding(s). Move internal notes into the vault; in .astro, a '
          'build-time note goes in the --- frontmatter as a // comment.')
    sys.exit(1)

print(f'clean — {SITE}: no identifying content in the built output, none in source, '
      'no HTML comment in template position, no JSX comment inside a template literal'
      + (', no narrative comments' if not warns else ''))
