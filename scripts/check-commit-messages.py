#!/usr/bin/env python3
"""Commit-message gate — the HISTORY surface of pseudonymity.

WHY THIS EXISTS, AND WHY IT IS A SEPARATE FILE. Pseudonymity has four surfaces:
authorship · content · history · built output. `check-pseudonymity.py` reads
`src/` and `dist/`, so it covers content and built output. Authorship has always
been clean — every commit here is `RadVladdy <…@users.noreply.github.com>` — and
authorship is the one surface a leak does not use.

On 2026-08-05 the fourth was measured for the first time: **13 of 273 commit
messages named the owner**, several quoting him directly. `check-pseudonymity.py`
exited 0 throughout, correctly, because a commit message is not a file in the
tree — and that clean exit was being cited as proof the repo was safe to make
public. A check cannot fail on a surface it never reads, so a passing gate looked
exactly like a covered one.

The rule being broken is the project's own, and it is broader than the identifier
list: *a source comment states a constraint, never a session — no person named, no
conversation quoted, no dated blow-by-blow.* A commit message is a comment that
outlives every file it describes. One of the 13 was written the same morning the
gap was found, by a session that had read that rule an hour earlier, which is the
argument for a gate rather than a habit.

WHAT IT CHECKS AND HOW. Every commit message this push would publish is piped to
`check-pseudonymity.py --stdin`, which applies THIS repo's tuned identifier list,
allowlist and narrative patterns. Delegating rather than copying is deliberate:
the identifier list lives in one untracked file shared by every site, and a second
scanner here would be a second thing to keep in step.

WHICH COMMITS. The exact set git is about to publish, computed by the pre-push
hook from the ref updates git hands it and passed in `BK_PUSH_COMMITS`. That is
the only authoritative source — the hook knows the remote's current sha and this
script does not.

  • New branch (remote sha all-zeros) → `rev-list <local> --not --remotes`, so a
    first push is judged on its own commits rather than on everything reachable.
  • Otherwise → `rev-list <remote>..<local>`.

Run standalone with no env, it falls back to `@{u}..HEAD` and then to
`HEAD --not --remotes`. THE FALLBACK IS DELIBERATELY NOT THE WHOLE HISTORY: the
13 known-bad messages are already pushed, and a gate that fails every push until
they are rewritten is a gate that gets `--no-verify`d into meaninglessness. Auditing
all of history is a different job with a different flag:

    python3 scripts/check-commit-messages.py --all

which is what to run before flipping this repo public, and what will report those
13 until they are squashed.

Usage:  python3 scripts/check-commit-messages.py            (the push range)
        python3 scripts/check-commit-messages.py --all      (every commit, audit)
        python3 scripts/check-commit-messages.py --range A..B
"""
import os
import subprocess
import sys
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
SCANNER = REPO / 'scripts' / 'check-pseudonymity.py'


def git(*args):
    """Run git in the repo and return stdout, or None if the command failed.

    A failure is expected in normal use — `@{u}` raises on a branch with no
    upstream — so it is a return value here rather than an exception.
    """
    r = subprocess.run(('git', '-C', str(REPO)) + args,
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def commits_to_check():
    """(list of shas, one-line description of where they came from)."""
    argv = sys.argv[1:]
    if '--all' in argv:
        return (git('rev-list', 'HEAD') or '').split(), 'every commit reachable from HEAD'
    for a in argv:
        if a.startswith('--range='):
            rng = a.split('=', 1)[1]
            return (git('rev-list', rng) or '').split(), rng
    if '--range' in argv:
        rng = argv[argv.index('--range') + 1]
        return (git('rev-list', rng) or '').split(), rng

    env = os.environ.get('BK_PUSH_COMMITS')
    if env is not None:
        return env.split(), 'the commits this push would publish'

    out = git('rev-list', '@{u}..HEAD')
    if out is not None:
        return out.split(), 'HEAD ahead of its upstream'
    out = git('rev-list', 'HEAD', '--not', '--remotes')
    return (out or '').split(), 'HEAD not yet on any remote'


def main():
    shas, where = commits_to_check()
    if not shas:
        print(f'clean — no commit messages to check ({where})')
        return 0

    bad, degraded = [], False
    for sha in shas:
        msg = git('show', '-s', '--format=%B', sha) or ''
        r = subprocess.run([sys.executable, str(SCANNER), '--stdin'],
                           input=msg, capture_output=True, text=True)
        if r.returncode == 2:
            degraded = True
            continue
        if r.returncode != 0:
            subject = (msg.splitlines() or [''])[0][:70]
            bad.append((sha[:8], subject, r.stdout.rstrip()))

    if degraded:
        print('!! DEGRADED: the identifier list is missing, so commit messages were')
        print('   not checked. See check-pseudonymity.py for where it lives.')
        return 2

    if bad:
        print(f'!! COMMIT-MESSAGE CHECK FAILED — {len(bad)} of {len(shas)} '
              f'message(s) in {where}\n')
        for sha, subject, detail in bad:
            print(f'  {sha}  {subject}')
            for line in detail.splitlines():
                print(f'    {line.strip()}')
            print()
        print('A commit message states the constraint, never the session. Reword it:')
        print('    git commit --amend            (the message you just wrote)')
        print('    git rebase -i <before-it>     (an earlier one)')
        return 1

    print(f'clean — {len(shas)} commit message(s) checked ({where}): '
          'no identifier, no session narration')
    return 0


if __name__ == '__main__':
    sys.exit(main())
