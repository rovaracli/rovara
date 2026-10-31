#!/bin/sh
# Checks a built MCP runner image against what the design promises (stdio MCP host redesign, T5; run by the Linux CI job `mcp-runner-linux`, T11).
#
#   check-image.sh <image>
#
# It exports the image's file system and reads the listing, so the checks need nothing inside the image (it has no shell). Every check prints one line; the script exits 1 if any fails.
#   1. not one setuid or setgid file (the mode shows `s` or `S` in the owner or group execute position);
#   2. no `git`, no shell, no package manager, no downloader;
#   3. the programs that must be there are: node, setpriv, prlimit, the three bundles, the CA file, npm;
#   4. the image's user is 10003:10003, and it has a command;
#   5. the image runs the way ECS runs it: read-only root, all capabilities dropped, a non-root user: node works, CapBnd is 0, and setpriv (as that unprivileged user) and prlimit start node.
# Step 5 needs a container runtime. `CHECK_IMAGE_SKIP_RUN=1` skips it (a machine that can export but not run).
set -eu

image="${1:?usage: check-image.sh <image>}"
docker_bin="${DOCKER:-docker}"
work="$(mktemp -d)"
cid=""
cleanup() { [ -z "$cid" ] || "$docker_bin" rm -f "$cid" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
failed=0
ok() { printf 'ok    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; failed=1; }

cid="$("$docker_bin" create "$image")"
"$docker_bin" export "$cid" | tar -tvf - > "$work/listing"

# 1. tar -tv prints `-rwsr-xr-x` for setuid: a letter `s` or `S` in the third or sixth place of the mode.
if awk '{ mode = $1; if (substr(mode, 4, 1) ~ /[sS]/ || substr(mode, 7, 1) ~ /[sS]/) { print; found = 1 } } END { exit found ? 0 : 1 }' "$work/listing" > "$work/setuid"; then
  bad "setuid or setgid files:"; sed 's/^/        /' "$work/setuid"
else ok "no setuid or setgid file"; fi

# 2. Names that must not be in the image, whatever the folder. A link counts as the file (its own name, not its target).
for banned in git sh bash dash busybox apt apt-get dpkg curl wget; do
  if awk -v name="$banned" '{ line = $0; sub(/ -> .*/, "", line); count = split(line, words, " "); path = words[count]; n = split(path, parts, "/"); if (parts[n] == name) { print; found = 1 } } END { exit found ? 0 : 1 }' "$work/listing" > "$work/found"; then
    bad "$banned is in the image:"; sed 's/^/        /' "$work/found"
  else ok "no $banned"; fi
done

# 3. What must be there.
for path in usr/local/bin/node usr/bin/setpriv usr/bin/prlimit opt/mcp-runner/serve.mjs opt/mcp-runner/fetch.mjs opt/mcp-runner/install.mjs etc/ssl/certs/ca-certificates.crt usr/local/lib/node_modules/npm/bin/npm-cli.js; do
  if awk -v want="$path" '{ line = $0; sub(/ -> .*/, "", line); count = split(line, words, " "); p = words[count]; sub(/^\.\//, "", p); if (p == want) found = 1 } END { exit found ? 0 : 1 }' "$work/listing"; then ok "has $path"; else bad "missing $path"; fi
done

# 4. The image's user and command.
user="$("$docker_bin" inspect -f '{{.Config.User}}' "$image")"
[ "$user" = "10003:10003" ] && ok "user is 10003:10003" || bad "user is '$user', not 10003:10003"
command_line="$("$docker_bin" inspect -f '{{json .Config.Cmd}}' "$image")"
[ "$command_line" != "null" ] && [ "$command_line" != "[]" ] && ok "has a command" || bad "has no command"

# 5. As ECS runs it.
if [ "${CHECK_IMAGE_SKIP_RUN:-0}" != "1" ]; then
  if "$docker_bin" run --rm --read-only --cap-drop ALL --user 10003:10003 --network none --entrypoint /usr/local/bin/node "$image" --version >/dev/null; then ok "node runs read-only, non-root, with no capabilities"; else bad "node does not run read-only, non-root, with no capabilities"; fi
  # With every capability dropped the bounding set is empty already; setpriv is NOT asked to drop it (that needs CAP_SETPCAP).
  capbnd="$("$docker_bin" run --rm --read-only --cap-drop ALL --user 10003:10003 --network none --entrypoint /usr/local/bin/node "$image" -e "console.log(require('fs').readFileSync('/proc/self/status', 'utf8').match(/CapBnd:\\s*([0-9a-f]+)/)[1])" 2>/dev/null || echo unreadable)"
  [ "$capbnd" = "0000000000000000" ] && ok "CapBnd is 0 with all capabilities dropped" || bad "CapBnd is '$capbnd', not 0000000000000000"
  if "$docker_bin" run --rm --read-only --cap-drop ALL --user 10003:10003 --network none --entrypoint /usr/bin/setpriv "$image" --no-new-privs --inh-caps=-all -- /usr/bin/prlimit --nofile=1024 --nproc=256 --fsize=536870912 --core=0 -- /usr/local/bin/node --version >/dev/null; then ok "setpriv and prlimit start node"; else bad "setpriv and prlimit do not start node"; fi
fi

exit "$failed"
