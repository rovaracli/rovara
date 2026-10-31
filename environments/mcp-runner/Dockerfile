# The MCP runner image (stdio MCP host redesign, T5): the one image the install, probe and serve tasks of a package-run MCP server use, plus the fetch step.
#
# It has no shell, no package manager and no `git`, and not one setuid or setgid file. It holds node (and npm, which only the install task runs), `setpriv` and `prlimit` (the bridge
# starts a server through them), the CA bundle, and three bundled programs. It is assembled from nothing (`FROM scratch`) out of the pinned node image: only the files named below
# and the shared libraries they need are copied, so what is not named is not there. The build proves it: it runs each program inside the assembled root, and fails if a setuid or
# setgid file, a shell or `git` is present.
#
# Users (no root anywhere in a runner task; the controller image is T6):
#   10001 controller   10002 fetch and install   10003 server (the bridge and the package)
# Base images come from ECR Public by digest: CodeBuild's shared IPs hit Docker Hub pull limits. The digest is the same one the other images pin (tests/contract/ci-images.test.ts).
FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /opt/agentx
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/model-runtime/package.json packages/model-runtime/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/verifier/package.json packages/verifier/package.json
COPY packages/audit-verifier/package.json packages/audit-verifier/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/model-proxy/package.json packages/model-proxy/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/broker/package.json packages/broker/package.json
COPY packages/slack-service/package.json packages/slack-service/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/web/package.json packages/web/package.json
COPY upstream/e2e-0.20.0.tgz upstream/e2e-0.20.0.tgz
COPY infra/package.json infra/package.json
RUN npm ci --ignore-scripts

# The programs import only @agentx/contracts and @agentx/gateway (and the MCP SDK and zod under them). Each is bundled with everything it imports into one file, so the image holds
# no node_modules at all, and no AWS SDK.
COPY packages/contracts packages/contracts
COPY packages/gateway packages/gateway
COPY packages/broker/src/mcp-runner packages/broker/src/mcp-runner
RUN npx tsc -b packages/contracts packages/gateway --pretty false
RUN set -eu; \
    for entry in serve-main:serve fetch-main:fetch install-main:install; do \
      src="${entry%%:*}"; out="${entry##*:}"; \
      npx esbuild "packages/broker/src/mcp-runner/$src.ts" --bundle --platform=node --target=node22 --format=esm --legal-comments=none \
        --banner:js="import { createRequire as __rovaraCreateRequire } from 'node:module'; const require = __rovaraCreateRequire(import.meta.url);" \
        --outfile="/opt/mcp-runner/$out.mjs"; \
    done; \
    chmod 0644 /opt/mcp-runner/*.mjs

# The root file system, assembled from the pinned node image.
FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS rootfs
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    root=/rootfs; \
    mkdir -p "$root/usr/bin" "$root/usr/local/bin" "$root/usr/local/lib/node_modules" "$root/usr/lib" "$root/etc/ssl/certs" "$root/opt/mcp-runner"; \
    ln -s usr/lib "$root/lib"; ln -s usr/bin "$root/bin"; ln -s usr/bin "$root/sbin"; \
    [ -d /usr/lib64 ] && { mkdir -p "$root/usr/lib64"; ln -s usr/lib64 "$root/lib64"; } || true; \
    add() { real="$(readlink -f "$1")"; mkdir -p "$root$(dirname "$real")"; cp -p "$real" "$root$real"; }; \
    for program in /usr/local/bin/node /usr/bin/setpriv /usr/bin/prlimit; do \
      add "$program"; \
      for library in $(ldd "$program" | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^\//) print $i }'); do add "$library"; done; \
    done; \
    for loader in /lib/ld-linux-*.so.* /lib64/ld-linux-*.so.*; do \
      [ -e "$loader" ] || continue; mkdir -p "$root$(dirname "$loader")"; [ -e "$root$loader" ] || cp -a "$loader" "$root$loader"; \
    done; \
    cp -a /usr/local/lib/node_modules/npm "$root/usr/local/lib/node_modules/npm"; \
    cp -p /etc/ssl/certs/ca-certificates.crt "$root/etc/ssl/certs/ca-certificates.crt"; \
    printf 'controller:x:10001:10001::/nonexistent:/sbin/nologin\nfetch:x:10002:10002::/work:/sbin/nologin\nserver:x:10003:10003::/home/server:/sbin/nologin\n' > "$root/etc/passwd"; \
    printf 'controller:x:10001:\nfetch:x:10002:\nserver:x:10003:\n' > "$root/etc/group"; \
    mkdir -p "$root/bundle" "$root/work" "$root/home/server" "$root/tmp"; \
    chown 10002:10002 "$root/bundle" "$root/work"; chown 10003:10003 "$root/home/server"; \
    chmod 0755 "$root/bundle" "$root/work" "$root/home/server"; chmod 1777 "$root/tmp"; \
    find "$root" -xdev \( -type f -o -type d \) -perm /6000 -exec chmod ug-s {} +
COPY --from=build /opt/mcp-runner/ /rootfs/opt/mcp-runner/
# The build fails here, not later, if the assembled root does not run, or holds what it must not.
RUN set -eu; \
    root=/rootfs; \
    test -z "$(find "$root" -xdev -perm /6000)"; \
    for banned in git sh bash dash busybox apt apt-get dpkg curl wget; do test -z "$(find "$root" -xdev \( -type f -o -type l \) -name "$banned")"; done; \
    chroot "$root" /usr/local/bin/node --version; \
    chroot "$root" /usr/bin/setpriv --no-new-privs --inh-caps=-all --bounding-set=-all -- /usr/bin/prlimit --nofile=1024 --nproc=256 --fsize=536870912 --core=0 -- /usr/local/bin/node --version; \
    chroot "$root" /usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js --version

FROM scratch
COPY --from=rootfs /rootfs/ /
ENV PATH=/usr/local/bin \
    NODE_ENV=production \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
# Each container of a task sets its own user and command: fetch and install run /opt/mcp-runner/fetch.mjs and install.mjs as 10002; the server runs serve.mjs as 10003.
USER 10003:10003
WORKDIR /home/server
CMD ["/usr/local/bin/node", "/opt/mcp-runner/serve.mjs"]
