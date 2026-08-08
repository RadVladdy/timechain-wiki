#!/usr/bin/env python3
"""Pre-push gate: this repo still deploys the standard way.

The deploy standard was convention-only until 2026-08-05, enforced by nothing —
and it had already drifted in two of four site repos, which is how it was found.
A rule with no checker is a rule that decays silently, so this is the checker.

Deliberately LOCAL and offline: a pre-push hook must not need a network or a
credential. What Cloudflare actually believes (no git-connected build, the domain
still served) is the nightly sweep's job — `beef-deploy-standard.py`. This one
answers only "is this repo still wired the agreed way".

Identical in every site repo. If you change it, change it everywhere.
"""
import json
import os
import subprocess
import sys

FAILURES = []
NOTES = []


def fail(msg):
    FAILURES.append(msg)


def repo_root():
    try:
        return subprocess.run(["git", "rev-parse", "--show-toplevel"],
                              capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return os.getcwd()


ROOT = repo_root()
os.chdir(ROOT)

# 1. npm run deploy exists and goes through scripts/deploy.sh
pkg_path = os.path.join(ROOT, "package.json")
if not os.path.exists(pkg_path):
    fail("no package.json — cannot verify `npm run deploy`")
else:
    scripts = json.load(open(pkg_path)).get("scripts", {})
    deploy = scripts.get("deploy")
    if not deploy:
        fail("package.json has no `deploy` script — every site repo deploys via `npm run deploy`")
    elif "scripts/deploy.sh" not in deploy:
        fail(f"`npm run deploy` does not call scripts/deploy.sh (found: {deploy!r}) — "
             "the deploy has to live in the script, not in the package.json line")

    prepare = scripts.get("prepare", "")
    if "core.hooksPath" not in prepare:
        fail("package.json `prepare` does not set core.hooksPath — a fresh clone "
             "would land with no pre-push gate at all")

# 2. the script exists, is executable, and sources a token that is really there
sh = os.path.join(ROOT, "scripts", "deploy.sh")
if not os.path.exists(sh):
    fail("scripts/deploy.sh is missing")
else:
    if not os.access(sh, os.X_OK):
        fail("scripts/deploy.sh is not executable")
    body = open(sh).read()

    token_line = [l for l in body.splitlines() if l.strip().startswith("TOKEN_FILE=")]
    if not token_line:
        fail("scripts/deploy.sh defines no TOKEN_FILE — the credential must be named "
             "in one obvious place, not inlined at the call site")
    else:
        raw = token_line[0].split("=", 1)[1].strip().strip('"').strip("'")
        path = os.path.expandvars(raw.replace("$HOME", os.path.expanduser("~")))
        if not os.path.exists(path):
            # The exact bug this whole check exists because of: a token file that
            # is wrong or absent stays invisible while deploys run with one already
            # exported in the environment.
            fail(f"scripts/deploy.sh points at a token file that does not exist: {raw}")
        else:
            NOTES.append(f"token file present ({raw})")

    if "/home/" in body:
        fail("scripts/deploy.sh contains an absolute /home/ path — use $HOME "
             "(a committed home path publishes the author's directory layout)")

    if "CLOUDFLARE_API_TOKEN" not in body:
        fail("scripts/deploy.sh never references CLOUDFLARE_API_TOKEN")

# 3. the gate itself: TRACKED, EXECUTABLE IN THE INDEX, and actually WIRED.
#
# Three assertions, because a hook stops gating in three unrelated ways and only
# the first was checked. Section 2 above tests deploy.sh for executability, so
# this check was blind in one of the two halves of its own pattern.
#
#   tracked    — an untracked hook exists only on the box that wrote it.
#   index mode — git SILENTLY SKIPS a non-executable hook, printing a `hint:` on
#                stderr nobody reads. Demonstrated in a scratch clone: an
#                executable pre-commit exiting 1 refused the commit; `chmod -x`
#                on the identical hook and the commit SUCCEEDED, no error.
#   hooksPath  — `git config --unset core.hooksPath` turns off every hook in the
#                repo while the file stays tracked and executable. That is also
#                the state of every fresh clone until `npm install` runs
#                `prepare`, so it is the ordinary case, not a hypothetical.
#
# THE MODE IS READ FROM THE INDEX, never with os.access(). os.access reads the
# WORKING-TREE bit — whatever the checkout happens to have written — and under
# core.fileMode=false git ignores that bit entirely, so os.access would false-fail
# on a correctly committed hook. The index mode is what a fresh clone will get,
# which is the thing worth asserting.
HOOK = ".githooks/pre-push"
staged = subprocess.run(["git", "ls-files", "-s", HOOK],
                        capture_output=True, text=True).stdout.strip()
if not staged:
    fail(f"{HOOK} is not tracked — an untracked hook exists only on the "
         "box that wrote it, which is how a gate quietly stops existing")
else:
    mode = staged.split()[0]
    if mode != "100755":
        fail(f"{HOOK} is tracked with mode {mode}, not 100755. git skips a "
             "non-executable hook with only a `hint:` on stderr, so every gate in "
             "this repo would be off while the file still looks perfectly present. "
             f"Fix: git update-index --chmod=+x {HOOK}")
    else:
        NOTES.append("pre-push tracked 100755")

hooks_path = subprocess.run(["git", "config", "--get", "core.hooksPath"],
                            capture_output=True, text=True).stdout.strip()
if hooks_path != ".githooks":
    fail(f"core.hooksPath is {hooks_path or 'unset'}, not .githooks — the tracked "
         "hook is not wired to anything and NO gate runs on push. This is the "
         "default state of a fresh clone until `npm install` runs `prepare`. "
         "Fix: git config core.hooksPath .githooks")

name = os.path.basename(ROOT)
if FAILURES:
    print(f"DEPLOY WIRING — {len(FAILURES)} problem(s) in {name}:", file=sys.stderr)
    for f in FAILURES:
        print(f"  ✗ {f}", file=sys.stderr)
    print("\n  Standard: vault 40-Projects/_Standards-Projects.md "
          "§ 'How every site is managed'", file=sys.stderr)
    sys.exit(1)

print(f"clean — {name}: npm run deploy → scripts/deploy.sh, "
      f"{'; '.join(NOTES) if NOTES else 'wiring intact'}, "
      f"core.hooksPath={hooks_path}")
