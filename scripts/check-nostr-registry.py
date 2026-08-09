#!/usr/bin/env python3
"""Fail the push if this repo's generated Nostr identity/relay copies drifted from the registry.

The single source of truth is ~/dev/nostr-publisher/nostr-registry.json. Browser
code cannot import across a repo boundary, so this repo carries GENERATED copies
(written by gen-registry-copies.mjs) — and hand-editing them is what this check
exists to catch. Regenerate with:

    cd ~/dev/nostr-publisher && node gen-registry-copies.mjs --write

The shared body below is portfolio-wide (same file in every site repo); only the
CONFIG block differs per repo. Picked up by the pre-push hook's scripts/check-*.py glob.
"""
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = os.path.join(os.path.expanduser("~"), "dev", "nostr-publisher", "nostr-registry.json")
RANK = {"ok": 0, "degraded": 1}

# ---- CONFIG (the only per-repo part) ----------------------------------------
CONFIG = {
    "modules": [
        {
            "path": "src/lib/nostr-relays.generated.js",
            "arrays": {
                "RELAYS": {"purpose": "publish"},
                "PROFILE_RELAYS": {"composite": ["discovery", "read"]},
            },
        },
    ],
    "nip05": {
        "path": "public/.well-known/nostr.json",
        "names": {"hello": "tw", "_": "tw"},
        "relay_accounts": ["tw"],
    },
}
# -----------------------------------------------------------------------------


def fail(msg):
    print(f"check-nostr-registry: {msg}")
    sys.exit(1)


def relays_for(reg, purpose, account=None):
    """Mirror registry.mjs relaysFor: usable statuses, purpose-tagged,
    per-identity exclusions, healthiest first."""
    excluded = set((reg["identities"].get(account) or {}).get("relay_exclusions") or []) if account else set()
    rows = [
        r for r in reg["relays"]
        if r.get("status") in RANK and purpose in (r.get("purposes") or []) and r["url"] not in excluded
    ]
    return [r["url"] for r in sorted(rows, key=lambda r: RANK[r["status"]])]


def want_array(reg, spec):
    if "composite" in spec:
        seen, out = set(), []
        for purpose in spec["composite"]:
            for u in relays_for(reg, purpose):
                if u not in seen:
                    seen.add(u)
                    out.append(u)
        return out
    return relays_for(reg, spec["purpose"], spec.get("account"))


def main():
    # A check that cannot read its subject must never report clean.
    if not os.path.exists(REGISTRY):
        fail(f"DEGRADED — the registry is missing at {REGISTRY}; cannot verify the generated copies")
    reg = json.load(open(REGISTRY, encoding="utf-8"))
    problems = []

    for mod in CONFIG["modules"]:
        path = os.path.join(REPO, mod["path"])
        if not os.path.exists(path):
            problems.append(f"{mod['path']} is missing — run gen-registry-copies.mjs --write")
            continue
        src = open(path, encoding="utf-8").read()
        for name, spec in (mod.get("arrays") or {}).items():
            m = re.search(rf"export const {name} = (\[[^\]]*\]);", src, re.S)
            if not m:
                problems.append(f"{mod['path']} has no parseable `export const {name} = [...]`")
                continue
            have, want = json.loads(m.group(1)), want_array(reg, spec)
            if have != want:
                problems.append(f"{mod['path']} {name} DRIFTED: file {have} vs registry {want}")
        for name, (ident, field) in (mod.get("consts") or {}).items():
            m = re.search(rf"export const {name} = '([^']*)';", src)
            want = (reg["identities"].get(ident) or {}).get(field)
            if not m:
                problems.append(f"{mod['path']} has no parseable `export const {name} = '...'`")
            elif m.group(1) != want:
                problems.append(f"{mod['path']} {name} DRIFTED: file '{m.group(1)}' vs registry '{want}'")

    nip = CONFIG.get("nip05")
    if nip:
        path = os.path.join(REPO, nip["path"])
        if not os.path.exists(path):
            problems.append(f"{nip['path']} is missing")
        else:
            doc = json.load(open(path, encoding="utf-8"))
            for name, ident in nip["names"].items():
                want = reg["identities"][ident]["pubkey"]
                have = (doc.get("names") or {}).get(name)
                if have != want:
                    problems.append(f"{nip['path']} names.{name} is '{have}', registry says '{want}' ({ident})")
            extra = set(doc.get("names") or {}) - set(nip["names"])
            if extra:
                problems.append(f"{nip['path']} carries unexpected names {sorted(extra)} — add them to CONFIG deliberately or remove them")
            for acct in nip["relay_accounts"]:
                pk = reg["identities"][acct]["pubkey"]
                have = (doc.get("relays") or {}).get(pk)
                want = relays_for(reg, "publish", acct)
                if have != want:
                    problems.append(f"{nip['path']} relays[{acct}] DRIFTED: file {have} vs registry {want}")

    if problems:
        fail(
            "generated Nostr copies DISAGREE with the registry:\n  - " + "\n  - ".join(problems)
            + "\n  regenerate: cd ~/dev/nostr-publisher && node gen-registry-copies.mjs --write"
        )
    n = len(CONFIG["modules"]) + (1 if nip else 0)
    print(f"clean — {n} generated Nostr cop{'y' if n == 1 else 'ies'} match the registry (v{reg.get('version')})")


if __name__ == "__main__":
    main()
