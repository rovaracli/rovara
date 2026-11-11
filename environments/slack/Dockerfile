# Hosted Slack orchestrator for ECS Fargate (linux/arm64). It consumes the Slack request queue and runs the
# Pi orchestrator with AgentX tools and approved MCP tools; coding still runs in the EC2 worker.
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
# in the lockfile); tsc -b builds Code's contracts through the project references of the packages that import them.
COPY vendor/rovara-code-shims vendor/rovara-code-shims
RUN npm ci --ignore-scripts

COPY packages/model-runtime packages/model-runtime
COPY packages/audit-verifier packages/audit-verifier
COPY vendor/rovara-code/tsconfig.base.json vendor/rovara-code/tsconfig.base.json
COPY vendor/rovara-code/packages/contracts vendor/rovara-code/packages/contracts
COPY packages/orchestrator packages/orchestrator
COPY packages/slack-service packages/slack-service
RUN npx tsc -b packages/orchestrator packages/slack-service --pretty false
RUN npm prune --omit=dev --workspaces

FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/agentx
COPY --from=build /opt/agentx/node_modules ./node_modules
COPY --from=build /opt/agentx/packages/model-runtime ./packages/model-runtime
COPY --from=build /opt/agentx/packages/audit-verifier ./packages/audit-verifier
COPY --from=build /opt/agentx/vendor/rovara-code/packages/contracts ./vendor/rovara-code/packages/contracts
COPY --from=build /opt/agentx/vendor/rovara-code-shims ./vendor/rovara-code-shims
COPY --from=build /opt/agentx/packages/orchestrator ./packages/orchestrator
COPY --from=build /opt/agentx/packages/slack-service ./packages/slack-service

ENV NODE_ENV=production \
    STATE_DIRECTORY=/tmp/agentx-slack
USER node
CMD ["node", "packages/slack-service/dist/main.js"]
