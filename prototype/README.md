# Rovara Cloud on its own: prototype

PrepLabsAI/Rovara-cloud#1, built one feature at a time. The web app (`packages/ui`, `packages/web`) runs against a
Rovara Code install instead of this repo's copy of Rovara: it signs people in through Rovara Code as a registered
sign-in client (spec 063), and `prototype/server.ts` answers the app's `/v1/web` API from Rovara Code.

| Step | Feature | State |
| --- | --- | --- |
| 1 | Sign in through Rovara Code; `/v1/app/me` from its access check | Built |
| 2 | Projects list | Next |
| 3 | Connect the orchestrator (one-time link) | |
| 4 | Start orchestration | |
| 5 | Run status | |

Everything not built yet answers `501 NOT_IN_PROTOTYPE`.

## Run it locally

1. Register the client on the Rovara Code install (an administrator, once):
   `agentx --env production admin sign-in-client add rovara-cloud --audience rovara-cloud --loopback --confidential --secret-file ./rovara-cloud-secret`
2. Build the app: `npm ci && npm run build --workspace @agentx/web`
3. Start: `ROVARA_CODE_URL=https://<api> ROVARA_CLIENT_SECRET_FILE=./rovara-cloud-secret npx tsx prototype/server.ts`
4. Open http://127.0.0.1:8787/app and sign in.

Sessions are in memory: restarting the server signs everyone out.
