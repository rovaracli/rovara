# The EC2 worker image is built with --platform linux/arm64.
# The production Instances profile controls architecture through its capacity provider.
# Base images come from ECR Public by digest: CodeBuild's shared IPs hit Docker Hub pull limits.
FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /opt/agentx
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/model-runtime/package.json packages/model-runtime/package.json
COPY packages/cloud-contracts/package.json packages/cloud-contracts/package.json
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
# Rovara Code's contracts (convergence W0-3): the pinned copy under vendor/ and the @rovara-code/* workspace shims over it. npm ci links the shims (they are workspace members
# in the lockfile); tsc -b builds Code's contracts through the project reference of packages/cloud-contracts.
COPY vendor/rovara-code-shims vendor/rovara-code-shims
RUN npm ci --ignore-scripts

COPY packages/model-runtime packages/model-runtime
COPY packages/audit-verifier packages/audit-verifier
COPY packages/cloud-contracts packages/cloud-contracts
COPY vendor/rovara-code/tsconfig.base.json vendor/rovara-code/tsconfig.base.json
COPY vendor/rovara-code/packages/contracts vendor/rovara-code/packages/contracts
COPY packages/verifier packages/verifier
COPY packages/worker packages/worker
# The catalog flavor (test services slice 1): the image's flavor is this build argument, never whatever the checkout says. "release" (the default, for every public and Enterprise release) generates the staging-only catalog
# signing key list EMPTY, so the key is not in the compiled code at all; only the staging build path passes CATALOG_FLAVOR=staging (scripts/test-deploy.ts). The image is labelled with it below, and every release path refuses an
# image that is not labelled release (scripts/release/image-flavor.ts).
ARG CATALOG_FLAVOR=release
# The whole catalog directory, build stage only (the staging signing key file may not exist, and a COPY of a glob that matches nothing fails the build; a directory always exists).
COPY environments/service-catalog environments/service-catalog
RUN case "$CATALOG_FLAVOR" in release|staging) ;; *) echo "CATALOG_FLAVOR is release or staging" >&2; exit 1 ;; esac \
    && node packages/cloud-contracts/tools/catalog-flavor.ts "$CATALOG_FLAVOR" --root /opt/agentx
RUN npx tsc -b packages/cloud-contracts packages/verifier packages/worker --pretty false \
    && grep -q "CATALOG_BUILD_FLAVOR = \"$CATALOG_FLAVOR\";" packages/cloud-contracts/dist/catalog-build-flavor.js \
    && { [ "$CATALOG_FLAVOR" != release ] || grep -q "CATALOG_STAGING_ONLY_SIGNING_KEYS = \[\];" packages/cloud-contracts/dist/catalog-staging-keys.js; }
# The TS-L checks, for the worker boot's opt-in self-test (packages/worker/ec2/boot-stage2.sh `run_tsl_selftest`): the checker script (a byte-for-byte mirror of scripts/linux-check-test-services.sh, held equal by a test) and its live
# driver (a mirror of scripts/linux-check-test-services-live.ts, kept as .txt so no tool reads it as part of the worker's own sources) already came in with packages/worker above. In a STAGING build the driver is built here to one
# JavaScript file (types stripped, imports left as they are: it loads the contracts and the compiled worker from this image's own node_modules and dist, as it does on CI), before the prune removes esbuild. Any other flavor (every release
# image) carries neither file: the self-test also refuses an image that is not a staging build, and there is nothing for it to run. Nothing here runs unless a staging launch opts in.
RUN if [ "$CATALOG_FLAVOR" = staging ]; then \
      node_modules/.bin/esbuild --loader:.txt=ts --format=esm --platform=node --target=node22 --log-level=warning --outfile=packages/worker/ec2/tsl/live.mjs packages/worker/ec2/tsl/live-driver.ts.txt \
      && test -s packages/worker/ec2/tsl/live.mjs; \
    else rm -rf packages/worker/ec2/tsl; fi
RUN npm prune --omit=dev --workspaces

# The Docker CLI and Compose plugin, which run a project's devcontainer through the EC2 host's
# Docker (#121). Pinned by checksum; Docker publishes none for its static builds, so those two were
# computed from the downloads.
FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS tools
ARG TARGETARCH
ARG DOCKER_VERSION=29.8.1
ARG COMPOSE_VERSION=v5.5.1
ARG UV_VERSION=0.12.20
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) arch=aarch64; docker_sha=667395fbffab52901b80181dfbb39ea76da2fbd7642c4fbddd24e42146b07b48; compose_sha=732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7 ;; \
      amd64) arch=x86_64; docker_sha=d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70; compose_sha=db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576 ;; \
      *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/docker.tgz "https://download.docker.com/linux/static/stable/$arch/docker-$DOCKER_VERSION.tgz"; \
    echo "$docker_sha  /tmp/docker.tgz" | sha256sum -c -; \
    tar -xzf /tmp/docker.tgz -C /tmp docker/docker; \
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker; \
    curl -fsSL -o /tmp/docker-compose "https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-$arch"; \
    echo "$compose_sha  /tmp/docker-compose" | sha256sum -c -; \
    install -D -m 0755 /tmp/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
# uv, which runs a Python repository's setup and tests. Pinned by the release's published SHA-256,
# checked against the downloads (2026-09-29).
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) uv_arch=aarch64; uv_sha=8a7aad7bc76a2fae5151566ff3e43eacce0b2a113d5e4de3e4afe3e58fa2441e ;; \
      amd64) uv_arch=x86_64; uv_sha=6590717592ace991ff83a63fef799e3ad9d33ecc8f96c5d6bdd732496e79337f ;; \
      *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/uv.tgz "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$uv_arch-unknown-linux-gnu.tar.gz"; \
    echo "$uv_sha  /tmp/uv.tgz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tgz -C /tmp; \
    install -m 0755 "/tmp/uv-$uv_arch-unknown-linux-gnu/uv" /usr/local/bin/uv; \
    install -m 0755 "/tmp/uv-$uv_arch-unknown-linux-gnu/uvx" /usr/local/bin/uvx

FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

# Python 3, pip and venv (Debian bookworm) so a Python repository's tests run; a project's
# devcontainer (#121) is the route for anything else. tini, pinned, runs as PID 1 and reaps the
# processes a command leaves behind: commands run in their own process group (#170).
# This image is also the task sandbox (R56) a project without a devcontainer runs in, so it carries
# the tools such a project's commands reach for: curl, git, python3, bash and a POSIX shell (dash).
# iptables (TS-SEAL-5): the sealed check round starts one short-lived helper container of this image, with NET_ADMIN alone, joined to the check sandbox's network namespace, to drop its traffic to Docker's embedded
# resolver (127.0.0.11) before any command runs (packages/worker/src/check-sandbox.ts `resolverGuardRunArgs`). It is run as `iptables-nft`, which talks netlink and needs no other capability. The sandbox itself has
# no capability, so the binary does nothing there.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git iptables openssh-client python3 python3-pip python3-venv tini=0.19.0-1+b3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tools /usr/local/bin/docker /usr/local/bin/docker
COPY --from=tools /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
COPY --from=tools /usr/local/bin/uv /usr/local/bin/uv
COPY --from=tools /usr/local/bin/uvx /usr/local/bin/uvx
WORKDIR /opt/agentx
COPY --from=build /opt/agentx/package-lock.json ./package-lock.json
COPY --from=build /opt/agentx/node_modules ./node_modules
COPY --from=build /opt/agentx/packages/model-runtime ./packages/model-runtime
COPY --from=build /opt/agentx/packages/audit-verifier ./packages/audit-verifier
COPY --from=build /opt/agentx/packages/cloud-contracts ./packages/cloud-contracts
COPY --from=build /opt/agentx/vendor/rovara-code/packages/contracts ./vendor/rovara-code/packages/contracts
COPY --from=build /opt/agentx/vendor/rovara-code-shims ./vendor/rovara-code-shims
COPY --from=build /opt/agentx/packages/verifier ./packages/verifier
COPY --from=build /opt/agentx/packages/worker ./packages/worker
# The signed service catalog beside the worker's pre-pull list (test services slice 1): catalog.json is always there, catalog.sig.json once the catalog is built, so the glob always matches.
COPY --from=build /opt/agentx/environments/service-catalog/catalog*.json ./packages/worker/service-catalog/
# The flavor this image was built with, read by scripts/release/image-flavor.ts before a release, a bundle or a production deploy takes the image.
ARG CATALOG_FLAVOR=release
LABEL ai.rovara.catalog-flavor="${CATALOG_FLAVOR}"
# Stage 2 of the EC2 boot (Task 10): boot.sh reads this file out of the image it pulled by digest and runs it only if its SHA-256 is the one
# the control plane launched the worker with. Read-only, owned by root, and the same bytes the release records the hash of.
COPY --chown=root:root --chmod=0444 packages/worker/ec2/boot-stage2.sh /opt/agentx/boot/stage2.sh

# Empty, read-only git directories (one per object format) for the worker's verified base read (packages/worker/src/trusted-base-objects.ts).
# Git runs in one of these with GIT_OBJECT_DIRECTORY pointed at a scratch objects directory, so no process that can write the workspace can give
# Git a config to read. Root-owned, nothing writable, outside the workspace and every mount a dev container is given.
RUN set -eu; \
    install -d -o root -g root -m 0755 /usr/share/agentx; \
    for format in sha1 sha256; do \
      git init --bare --quiet --template= "--object-format=$format" "/usr/share/agentx/empty-$format.git"; \
    done; \
    chown -R root:root /usr/share/agentx; \
    find /usr/share/agentx -type d -exec chmod 0555 {} +; \
    find /usr/share/agentx -type f -exec chmod 0444 {} +

# AGENTX_WORKER_PROCESS_SCOPE: this container is the worker's own process namespace, so before a push every other
# process of the worker's user in it is stopped (packages/worker/src/workspace-processes.ts).
ENV AGENTX_WORKSPACE_ROOT=/mnt/workspace \
    AGENTX_WORKER_PROCESS_SCOPE=container \
    NODE_ENV=production \
    PORT=8080
EXPOSE 8080
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/worker/dist/main.js"]
