#!/bin/bash
# Controller check before the public CI-only build of the AWS Emulator engine image (owner decision, like decision 33): is the public snapshot exactly the private commit, minus src/ and .superpowers/?
#
#   scripts/verify-local-aws-snapshot.sh <PRIVATE_CHECKOUT> <PRIVATE_SHA> <PUBLIC_CHECKOUT> <PUBLIC_SHA>
#
# PRIVATE_CHECKOUT is a clone of PrepLabsAI/rovara-local-aws that holds PRIVATE_SHA (a commit of `rovara/front`); PUBLIC_CHECKOUT is a clone of rovaracli/rovara-local-aws that holds PUBLIC_SHA (its `main`, one no-history
# snapshot commit). It fails (non-zero, one reason on stderr) unless ALL of these hold:
#   1. both shas are full 40-character commit ids that exist in their checkout;
#   2. the public commit has no parent (a snapshot, no history);
#   3. the file listing of the public commit (mode, type, blob id and path of every entry, from `git ls-tree -r`) is IDENTICAL to the private commit's listing with every path under `src/` or `.superpowers/` removed.
#      Blob ids are hashes of the content, so equal listings mean byte-identical files with the same modes, whatever the history; an extra, missing, changed or re-moded file is a refusal.
# It reads the two repositories only (no network, no write). On success it prints the two shas on one line: copy that line into the sources entry's `provenance` (`privateSourceSha`, `publicSnapshotSha`) and the evidence README.
set -u
export LC_ALL=C
PRIVATE_DIR="${1:-}"; PRIVATE_SHA="${2:-}"; PUBLIC_DIR="${3:-}"; PUBLIC_SHA="${4:-}"
GIT="${GIT:-git}"
fail() { echo "REFUSED: $1" >&2; exit 1; }
[[ -n "$PRIVATE_DIR" && -d "$PRIVATE_DIR" && -n "$PUBLIC_DIR" && -d "$PUBLIC_DIR" ]] || fail "the first and third arguments are the private and the public checkout folders."
[[ "$PRIVATE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "the second argument is the private commit's full 40-character sha."
[[ "$PUBLIC_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "the fourth argument is the public snapshot's full 40-character sha."
"$GIT" -C "$PRIVATE_DIR" cat-file -e "$PRIVATE_SHA^{commit}" 2>/dev/null || fail "the private checkout has no commit $PRIVATE_SHA."
"$GIT" -C "$PUBLIC_DIR" cat-file -e "$PUBLIC_SHA^{commit}" 2>/dev/null || fail "the public checkout has no commit $PUBLIC_SHA."
parents=$("$GIT" -C "$PUBLIC_DIR" rev-list --parents -n 1 "$PUBLIC_SHA" 2>/dev/null) || fail "git could not read the public commit."
[[ "$parents" == "$PUBLIC_SHA" ]] || fail "the public commit has a parent: it must be a single no-history snapshot."
tmp=$(mktemp -d) || fail "no scratch folder."
trap 'rm -rf "$tmp"' EXIT
"$GIT" -C "$PRIVATE_DIR" ls-tree -r -z --full-tree "$PRIVATE_SHA" >"$tmp/private.raw" 2>/dev/null || fail "git could not list the private commit."
"$GIT" -C "$PUBLIC_DIR" ls-tree -r -z --full-tree "$PUBLIC_SHA" >"$tmp/public.raw" 2>/dev/null || fail "git could not list the public commit."
# Entries are "<mode> <type> <id>\t<path>" separated by NUL. Drop src/ and .superpowers/ from the private listing; sort both.
python3 -I - "$tmp/private.raw" "$tmp/public.raw" "$tmp" <<'PY' || exit 1
import sys
private_raw, public_raw, out = sys.argv[1:4]
def entries(path):
    data = open(path, "rb").read().split(b"\0")
    return [e for e in data if e]
def pathof(entry):
    return entry.split(b"\t", 1)[1]
excluded = (b"src/", b".superpowers/")
private = sorted(e for e in entries(private_raw) if not pathof(e).startswith(excluded))
public = sorted(entries(public_raw))
if not private:
    sys.stderr.write("REFUSED: the private commit has nothing left after removing src/ and .superpowers/.\n"); sys.exit(1)
if private != public:
    only_private = sorted(set(private) - set(public))
    only_public = sorted(set(public) - set(private))
    sample = (only_private[:1] + only_public[:1])
    sys.stderr.write("REFUSED: the snapshot is not the private commit minus src/ and .superpowers/ (%d entries differ, %d only in private, %d only in public; first: %s).\n" % (len(set(private) ^ set(public)), len(only_private), len(only_public), (sample[0].decode("utf-8", "replace").replace("\t", " ") if sample else "?")))
    sys.exit(1)
open(out + "/count", "w").write(str(len(private)))
PY
echo "OK snapshot: $(cat "$tmp/count") files; privateSourceSha=$PRIVATE_SHA publicSnapshotSha=$PUBLIC_SHA (the public tree is the private tree minus src/ and .superpowers/)"
