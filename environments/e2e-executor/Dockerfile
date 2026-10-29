# The browser executor for Rovara's real-Chromium E2E checks (linux/arm64). It runs the pinned e2e
# runner (e2e@0.20.0, @e2e-dev/web@0.14.0) against an application that sits on the same internal
# network; the entrypoint and the smoke check live in packages/verifier/src/executor.
# It never holds credentials: the runtime starts it with every capability dropped and no AWS_*, AGENTX_*,
# PI_*, GIT_* or token variables. The command is a default, so the CI smoke check can replace it.
# Chromium runs with its own sandbox (no --no-sandbox), which needs the pinned seccomp profile
# packages/verifier/assets/executor-seccomp.json: the runtime starts this image with it, and without it Chromium does not start.
# Base images come from ECR Public by digest: CodeBuild's shared IPs hit Docker Hub pull limits.
FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /opt/agentx
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/model-runtime/package.json packages/model-runtime/package.json
COPY packages/audit-verifier/package.json packages/audit-verifier/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/verifier/package.json packages/verifier/package.json
COPY packages/gateway/package.json packages/gateway/package.json
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

COPY packages/audit-verifier packages/audit-verifier
COPY packages/contracts packages/contracts
COPY packages/verifier packages/verifier
RUN npx tsc -b packages/contracts packages/verifier --pretty false
RUN npm prune --omit=dev --workspaces

FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

WORKDIR /opt/agentx
COPY --from=build /opt/agentx/package-lock.json ./package-lock.json
COPY --from=build /opt/agentx/node_modules ./node_modules
COPY --from=build /opt/agentx/packages/audit-verifier ./packages/audit-verifier
COPY --from=build /opt/agentx/packages/contracts ./packages/contracts
COPY --from=build /opt/agentx/packages/verifier ./packages/verifier

# Chromium and the system libraries it needs, as root. `npm ci --ignore-scripts` ran no install script of
# playwright-core, so the browser comes from this explicit step. The root package.json also holds playwright-core
# 1.64.0 as a dev dependency (the web end-to-end tests), which npm hoists to node_modules/playwright-core and
# `npm prune --omit=dev` then removes; the verifier's own 1.63.0 stays nested in packages/verifier/node_modules,
# and that is the copy the executor imports. So there is no node_modules/.bin/playwright-core, and
# `npx playwright-core@1.63.0` died with "playwright-core: not found" (exit 127). This step runs the cli.js of the
# very copy the executor resolves (Node resolution from packages/verifier) and fails the build if it is not 1.63.0, so the
# browser build always matches the library. The browsers live outside any home directory so the unprivileged user
# below reads them.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN PLAYWRIGHT_PACKAGE="$(node -p "require.resolve('playwright-core/package.json', { paths: ['/opt/agentx/packages/verifier'] })")" \
    && PLAYWRIGHT_DIR="$(dirname "$PLAYWRIGHT_PACKAGE")" \
    && [ "$(node -p "require('$PLAYWRIGHT_PACKAGE').version")" = "1.63.0" ] \
    && node "$PLAYWRIGHT_DIR/cli.js" install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# This image's model channel client syncs the browser's session values before every model call (MIDSTEPCOOKIE). The worker lists task.workflowE2EMidStepSync.v1 only while its image has this label.
LABEL io.rovara.e2e.session-sync="v1"
USER node
CMD ["node", "/opt/agentx/packages/verifier/dist/executor/entry.js"]
