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

# 3. the gate itself is tracked, not a local-only hook
tracked = subprocess.run(["git", "ls-files", ".githooks/pre-push"],
                         capture_output=True, text=True).stdout.strip()
if not tracked:
    fail(".githooks/pre-push is not tracked — an untracked hook exists only on the "
         "box that wrote it, which is how a gate quietly stops existing")

name = os.path.basename(ROOT)
if FAILURES:
    print(f"DEPLOY WIRING — {len(FAILURES)} problem(s) in {name}:", file=sys.stderr)
    for f in FAILURES:
        print(f"  ✗ {f}", file=sys.stderr)
    print("\n  Standard: vault 40-Projects/_Standards-Projects.md "
          "§ 'How every site is managed'", file=sys.stderr)
    sys.exit(1)

print(f"clean — {name}: npm run deploy → scripts/deploy.sh, "
      f"{'; '.join(NOTES) if NOTES else 'wiring intact'}, pre-push tracked")
