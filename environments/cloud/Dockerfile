# Rovara Cloud for ECS Fargate (linux/arm64): the web app and Cloud's server (scripts/cloud-server.ts) in one Node
# process, signing people in through a Rovara Code install. infra/lib/cloud-app.ts runs it.
# Base images come from ECR Public by digest: CodeBuild's shared IPs hit Docker Hub pull limits.
FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /opt/rovara
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
COPY packages/cloud-server/package.json packages/cloud-server/package.json
COPY upstream/e2e-0.20.0.tgz upstream/e2e-0.20.0.tgz
COPY infra/package.json infra/package.json
RUN npm ci --ignore-scripts

COPY packages/audit-verifier packages/audit-verifier
COPY packages/contracts packages/contracts
COPY packages/design-tokens packages/design-tokens
COPY packages/ui packages/ui
COPY packages/web packages/web
COPY packages/cloud-server packages/cloud-server
COPY scripts/cloud-server.ts scripts/web-precompress.ts scripts/ui-copy-assets.mjs scripts/
RUN npx tsc -b packages/contracts packages/cloud-server --pretty false && npm run build:web
# One file with everything the server imports, so the image carries no node_modules.
RUN npx esbuild scripts/cloud-server.ts --bundle --platform=node --target=node22 --format=esm --outfile=/opt/cloud/server.mjs \
      --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"

FROM public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

WORKDIR /opt/cloud
COPY --from=build /opt/cloud/server.mjs ./server.mjs
COPY --from=build /opt/rovara/packages/web/dist/app ./app
ENV NODE_ENV=production \
    CLOUD_APP_DIRECTORY=/opt/cloud/app \
    HOST=0.0.0.0 \
    PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
