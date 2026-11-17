# @rovara/cloud-server

Rovara Cloud's server for its web app, on a Rovara Code install's API ([Rovara-cloud#1](https://github.com/PrepLabsAI/Rovara-cloud/issues/1)).

- **Sign-in:** people sign in through Code. Cloud is Code's sign-in client `rovara-cloud` (Code specs 063, 065, 066, with full access), using PKCE and its own secret. Their Code tokens stay on the server; the browser holds only an opaque, HttpOnly session cookie.
- **The app's API** (`/v1/app/*`, which the browser calls as `/v1/web/*`): each route in `src/routes.ts` answers from Code as the signed-in person, in the reader shape the app expects. A changing request needs the session's CSRF token (`x-rovara-csrf`). A route not on Code yet answers 501 `NOT_ON_CODE_YET`.
- **Tokens:** a call that Code answers 401 refreshes the token once and tries again (calls made together share one refresh, since Code's refresh tokens work once); when the sign-in has ended, the session is removed and the app asks the person to sign in again.
- **Stored logins** (migration plan v3.2, 7.2 change 4): one record per login under a hash of the cookie, never the cookie. Deployed, records are in DynamoDB (TTL on `expiresAt`) and sealed by envelope encryption with Cloud's KMS key, bound to the row. A login ends 12 hours unused or 7 days after sign-in. A refresh takes a short hold on the record (a conditional write), so only one server refreshes at a time and the others pick up its tokens; the new tokens are saved before the call is retried. Sign-out deletes the record and calls Code's `/v1/auth/revoke`. The client secret is read from Secrets Manager at run time (`client-secret.ts`). `LocalSessionStore` (memory or a file, tokens unsealed) refuses to run anywhere deployed.
- **Sessions (phase 2):** a Cloud session (`ses_…`) points at the Code task doing the work. Home's cards come from the person's newest sessions, each read from Code: a plan waiting for its owner, a failed run, an open pull request.
- **Sharing, following, viewing (phase 2c):** a session is shared with a person through Code's task readers (Rovara spec 067): Code keeps who may read the task and checks it on every read, so Cloud keeps no share list. Someone it is shared with reads the session at `view` and only watches. Cloud keeps followers on the session record, and who is looking at a session now in memory (`src/presence.ts`; a deployed Cloud with several servers needs a shared store).
- **Company data** (plan v3.2 2.2, 2.4, decision 17): Cloud keeps each company's settings and rules, profile, plan, budgets and invites (`COMPANY_TABLE`); members, roles and pre-approved emails live in Code. The company and the person's company role come only from Code's access check made on each request (`company-caller.ts`, DEC 253z); a person Code names no company for is refused ("You're not in a company yet."). A company admin is a company owner or admin, never Code's install `administrator`. Changing settings, approving a change and inviting an admin need a fresh step-up (`/v1/auth/browser/authorize?step_up=1` asks Code for one); a change that loosens anything waits for a second admin while the company's rules say `{ what: "setting.loosen", secondPerson: true }` (the default). An invite tells Code the email is pre-approved, as the admin, before it is kept; until Code serves that route, inviting answers 501.
- **Company audit** (plan v3.2 7.5): `GET /v1/app/company/audit` lists Cloud's own audit records (company rules, invites, budgets, sign-in clients, and each policy hook answer) and Code's engine records (`GET /v1/dev/client/company/audit/records`, read as the signed-in person) as one list, newest first, filtered by `from`, `to`, `person`, `project`, `action`, paged by `limit` and `cursor`. Only a company administrator (Code's access check, made on each call) reads it, and only this Cloud's company. Code has no time index for its records yet, so a page reads at most 8 pages of Code's records and says `incomplete` when there are more; a Code that does not serve the route answers `not_connected` and the list is Cloud's own records. A route that changes something at company level records it with `recordCloudAction(context.audit, ...)`; the policy hook records each answer and gives none it could not record.
- **Open a task by its Code id (K2):** `POST /v1/app/tasks/{taskId}/open` answers `{ sessionId, sessionUrl }`: the task's Cloud session, made on the first open by anyone Code lets read the task (a People co-owner, commenter or viewer). Code's own task read, as the caller, comes first; its refusal (any 4xx) answers the fixed 404 `SESSION_NOT_FOUND` of a missing session and writes nothing. The owner comes from Code's People read, the project from Code's task, the company from Code's access check; one session per task (a conditional write under `REQUEST#task-<taskId>`). The app's link is `/t/<taskId>`, which opens the task and goes to `/s/<session>` (`src/open-task.ts`).
- **Plan approval:** `/v1/app/approve/plan-<session>` is a small server page (no scripts, strict policy) where the session's owner approves the plan or asks for changes. The form carries the CSRF token, must come from Cloud's own origin, and is bound to the workflow revision and plan digest it showed; Code checks both again. The app shows the link only on HTTPS, so on `cloud:local` open it from the Home card.

| File | What it holds |
| --- | --- |
| `src/code-client.ts` | Sign-in, token refresh, JSON calls to Code as the person |
| `src/sessions.ts` | The session store interface; `SessionKeeper` (limits, refresh hold, sealing); `LocalSessionStore` (memory, or a private file; this computer only) |
| `src/session-table.ts` | Where records live: `DynamoSessionTable`, `LocalSessionTable` |
| `src/session-crypto.ts` | Envelope sealing: `EnvelopeSealer`, `KmsKeyService`, `localKeyService` |
| `src/client-secret.ts` | The client secret from Secrets Manager at run time |
| `src/routes.ts` | The route table: one entry per `/v1/app` route answered from Code |
| `src/handler.ts` | Sign-in, sign-out, the session cookie, CSRF and route dispatch, framework-neutral |
| `src/work-reads.ts` | The Work page's reads (the split inbox): the task list, and for one task its plan, proof index, events and plan comments, each one call to Code as the person, kept to the fields the page draws |
| `src/lessons-routes.ts` | The lessons screens (DEC 231) on Code's lessons API (#713, contract v0 `lessons.*`): the inbox batch (`GET /v1/app/lessons/inbox`, one batch per project of the proposed lessons the person may decide, theirs first), the lists, Keep, Edit and Drop (one or a batch), retire and retire requests, the learning mode, Lessons used and not helpful. Only fixed words are forwarded; Code's "Lessons are off." (404 `LESSONS_SWITCHED_OFF`) passes through for the screens' calm off state |
| `src/work-sessions.ts` | Cloud's sessions: the store interface; `LocalWorkSessionStore` |
| `src/session-view.ts` | A session as the app reads it, from the session and Code's task; the waiting plan |
| `src/approve.ts` | The plan approval page and the decision it sends to Code |
| `src/audit-log.ts` | Cloud's own audit records (plan v3.2 7.5): the action list, `recordCloudAction`, `LocalCloudAuditStore`; append-only, company-scoped. `DynamoCloudAuditStore` is in `dynamo-stores.ts` |
| `src/company-audit.ts` | The company audit list: Cloud's records and Code's engine records merged, newest first, with a stable cursor; `GET /v1/app/company/audit` (admin only) |
| `src/presence.ts` | Who is looking at a session now: `LocalPresenceBoard` (this server's memory) |
| `src/company-settings.ts` | A company's settings and rules (feature gates, website ceiling, instructions, eval budget, step-up window, starts, decision rules, Code locks, budgets): validation, the "does this loosen anything" check, what the policy hook answers from |
| `src/company-store.ts` | Cloud's company data: settings, a change waiting for a second admin, profile, invites, the hook's install allow-list; `LocalCompanyStore`; the hook's `StoreCompanyRules` and `StoreHookInstalls` |
| `src/company-dynamo.ts` | `DynamoCompanyStore`, in the stack's `Companies` table |
| `src/company-routes.ts` | The app's company routes on that data (settings, budgets, profile, invites); members stay on Code (501 until Code serves them) |
| `src/step-up.ts` | The admin's step-up, as Code's access token states it (`step_up_at`, `step_up_amr`) |

The migration tracker lists every route the app calls and where it is answered from: https://claude.ai/artifact/5dgtmptEHv1sfZNNZqefUw

## Run it on this computer

```sh
npm run build:web
ROVARA_CODE_URL=https://<code api> ROVARA_CLIENT_SECRET_FILE=<file> npm run cloud:local
```

Then open http://127.0.0.1:8787/app. Optional: `ROVARA_CLIENT_ID` (default `rovara-cloud`), `PORT` (8787), `ROVARA_SCOPES`, `CLOUD_SESSIONS_FILE` (keeps people signed in across restarts, mode 600; refused when deployed), `CLOUD_WORK_SESSIONS_FILE` (keeps Cloud's sessions, mode 600), `CLOUD_ORG_NAME`. Code takes a loopback redirect only at exactly `http://127.0.0.1:<port>/callback`.

## Adding a route

1. Check the route on the tracker; for a Code route, Code's API must be able to do it (if not, open a Rovara Code issue first).
2. Add an entry to `ROUTES` in `src/routes.ts`, shaped to the app's reader schema, and a case in `tests/unit/cloud-server.test.ts`.
3. Remove the route's old handler from Cloud's copy of Code, and tick it on the tracker and in #1.
