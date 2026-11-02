# ent-saml report: I4 SAML 2.0 sign-in (Enterprise)

Base f24cab6d2. Branch feat/ent-saml. Commits (local, nothing pushed):
- 0f15730dd build(broker): add @node-saml/node-saml 5.1.0 (exact pin)
- 14f2bb0e5 feat(sso): SAML 2.0 sign-in for Enterprise installs (I4)
- 4b45068d4, aa3c608cf, and a last commit: tests only
- aee7f47e9 (earlier): stop note, superseded by this report

Replaces: "company sign-in is OpenID Connect only". `methodAllowedByEdition`, `decideCompanySignIn`, the task-person identity checks, the browser/token method lists and the three requester `provider` enums now also accept `saml`.

## 1. Dependency (owner approved)
- `@node-saml/node-saml` **5.1.0**, exact pin, in `packages/broker/package.json` only. Chosen as the newest 5.1.x published at least two weeks ago (5.1.0 on 2025-07-21; 5.2.0 on 2026-10-26 is too new).
- Integrity: node-saml `sha512-t3cJnZ4aC7HhPZ6MGylGZULvUtBOZ6FzuUndaHGXjmIZHXnLfC/7L8a57O9Q9V7AxJGKAiRM5zu2wNm9EsvQpw==`.
- 16 new lockfile entries, nothing else added, moved or removed (the diff has 164 added lines and 0 removed; `git diff aee7f47e9 0f15730dd --stat` = 2 files, 165 insertions):
  | package | version | integrity (sha512) |
  |---|---|---|
  | @node-saml/node-saml | 5.1.0 | t3cJnZ4aC7HhPZ6MGylGZULvUtBOZ6FzuUndaHGXjmIZHXnLfC/7L8a57O9Q9V7AxJGKAiRM5zu2wNm9EsvQpw== |
  | xml-crypto | 6.4.0 | d21ModhBO/+QWWAmOjyDeQJuHNmsR/HtOxyBchiTbKfGNKuHYwQNd+SlLhwyyrwoAGLp4Qc6BQ7nAtnM47dHSQ== |
  | @xmldom/xmldom | 0.8.15 | /5NV/vDALVFDXgLmfsy9TRCBlKwO2LNBFzpzvb9iIj+jR+eSc6DLYYvVOdivT/jm7MtU6TebYuRmzEOI7w40UA== |
  | @xmldom/is-dom-node | 1.0.1 | CJDxIgE5I0FH+ttq/Fxy6nRpxP70+e2O048EPe85J2use3XKdatVM7dDVvFNjQudd9B49NPoZ+8PG49zj4Er8Q== |
  | xml-encryption | 3.1.0 | PV7qnYpoAMXbf1kvQkqMScLeQpjCMixddAKq9PtqVrho8HnYbBOWNfG0kA4R7zxQDo7w9kiYAyzS/ullAyO55Q== |
  | xml2js | 0.6.2 | T4rieHaC1EXcES0Kxxj4JWgaUQHDk+qwHcYOCFHfiwKz7tOVPLq7Hjq9dM1WCMhylqMEfP7hMcOIChvotiZegA== |
  | xmlbuilder | 15.1.1 | yMqGBqtXyeN1e3TGYvgNgDVZ3j84W4cwkOXQswghol6APgZWaff9lnbvN7MHYJOiXsvGPXtjTYJEiC9J2wv9Eg== |
  | xml2js/node_modules/xmlbuilder | 11.0.1 | fDlsI/kFEx7gLvbecc0/ohLG50fugQp8ryHzMTuW9vSa1GJ0XYWKnhsUx7oie3G98+r56aTQIUB4kht42R3JvA== |
  | xpath | 0.0.34 | FxF6+rkr1rNSQrhUNYrAFJpRXNzlDoMxeXN5qI84939ylEv3qqPFKa85Oxr6tDaJKqwW6KKyo2v26TSv3k6LeA== |
  | xml-crypto/node_modules/xpath | 0.0.33 | NNXnzrkDrAzalLhIUc01jO2mOzXGXh1JwPgkihcLLzw98c0WgYDmmjSh1Kl3wzaxSVWMuA+fe0WTWOBDWCBmNA== |
  | xml-encryption/node_modules/xpath | 0.0.32 | rxMJhSIoiO8vXcWvSifKqhvV96GjiD5wYb8/QHdoRyQvraTpp4IEv944nhGausZZ3u7dhQXteZuZbaqfpB7uYw== |
  | sax | 1.6.1 | 42tBVwLWnaQvW5zc4HbZrTuWccECCZfBi92FDuwtqxasH+JbPB3/FOKb1m222K42R4WxuxzzMsTswfzgtSu64Q== |
  | escape-html | 1.0.3 | NiSupZ4OeuGwr68lGIeym/ksIZMJodUGOSCZ/FSnTxcrekbvqrgdUxlJOMpijaKZVjAJrWrGs/6Jy8OMuyj9ow== |
  | @types/qs | 6.15.1 | GZHUBZR9hckSUhrxmp1nG6NwdpM9fCunJwyThLW1X3AyHgd9IlHb6VANpQQqDr2o/qQp6McZ3y/IA2rVzKzSbw== |
  | @types/xml2js | 0.4.14 | 4YnrRemBShWRO2QjvUin8ESA41rH+9nQGLUGZV/1IDhi3SL9OhdpNC/MrulTWuptXKwhx/aDxE7toV0f/ypIXQ== |
  | @types/xml-encryption | 1.2.4 | I69K/WW1Dv7j6O3jh13z0X8sLWJRXbu5xnHDl9yHzUNDUBtUoBY058eb5s+x/WG6yZC1h8aKdI2EoyEPjyEh+Q== |
- `npm audit` (whole repo): 13 moderate advisories, all the existing minimatch/eslint chain; **none** on node-saml, xml-crypto, @xmldom/xmldom, xpath, xml2js, xmlbuilder, xml-encryption, sax, escape-html. (The old xmldom advisories are fixed in 0.8.10+; we get 0.8.15.)
- `npm ci --dry-run --ignore-scripts` passes (lockfile and package.json agree). I did not run a real `npm ci` (it would replace the cloned node_modules); `tsc -b packages/contracts packages/broker` and the `@agentx/web` build pass.
- node-saml runs only in the broker (the sign-in Lambda and the settings routes). It is not imported by the web or the CLI.

## 2. What was built
New `packages/broker/src/developer/saml.ts`; `samlSignInProvider` in `providers.ts` (the plan said "a new function in providers.ts"); `contracts/src/sso.ts` (settings schema, keys, fixed refusal words); `saml` added to the method enum (`developer-web.ts:6`) and to the three requester `provider` enums (turns, operation, admin).

Flow: the sign-in page offers "SAML single sign-on" only when an admin saved and enabled the settings. The browser goes to the IdP with an AuthnRequest whose ID is `_` + the auth request's nonce (HTTP-Redirect, RelayState = auth request id; `fresh` sign-ins send ForceAuthn). The IdP POSTs to `/v1/auth/callback/saml`. A cross-site POST carries no SameSite=Lax cookie, so the POST handler keeps the response (single use, 2 minutes, only for an unconsumed SAML auth request) and 303-redirects to the GET callback, which carries the PKCE cookie. Then the same code path as OIDC: `decideCompanySignIn` (group mapping, ban, break-glass rules), `resolveOrgOnSignIn`, invites, session cap (8 h), audit (`sso.sign_in`, `sso.sign_in_refused`).

Checks on a response (all fail closed, fixed words only, one fixed sentence to the person):
- Before parsing: size (base64 and decoded), strict base64/UTF-8, no NUL, no declared encoding but UTF-8, **no DOCTYPE/ENTITY/ELEMENT/ATTLIST/NOTATION** (XXE and entity expansion cannot start), no SHA-1/MD5, a Signature element exists, top status is Success, at most 5000 elements.
- Unsigned root, refusals only: InResponseTo present and equal to our request, Destination equal to our ACS when present.
- Library (node-saml + xml-crypto, exclusive c14n, one reference that must be the parent element, one assertion): signature by the saved certificate on the response or the assertion; audience; Conditions times with 60 s skew; InResponseTo; max assertion age 10 min. Only the signed bytes are read after that.
- Broker, on the signed assertion: ID shape, Version 2.0, issuer equals the saved entity id, exactly one Conditions with NotOnOrAfter, audience restriction contains our entity id, exactly one Subject and NameID (not transient, 1..512 chars), a bearer SubjectConfirmation with Recipient equal to our ACS, InResponseTo equal to our request, NotOnOrAfter present and current, SessionNotOnOrAfter not passed, AuthnInstant not in the future (else not used).
- Replay: the assertion id (scoped by issuer and org) is recorded once with a conditional put; the TTL is the assertion end + 10 min. A second use, or a store that cannot answer, refuses.
- Group attributes: only attribute names in the existing group-claim allow-list reach the mapping. An attribute value that is not plain text (child elements) or too long makes the list invalid (claim_invalid), never shorter.

Settings: `GET/PUT /v1/app/org/sso/saml` (owner or admin; PUT needs a live browser session, a sign-in within the fresh window, the audit ledger, and compare-and-set on the version). The certificate must parse as X.509, be unexpired and RSA 2048+ or EC. Saved with `sso.saml_changed` (which fields changed as fixed words, and the certificate SHA-256 as a detail; no values). The GET also returns our entity id, ACS address and metadata address to give the IdP; `GET /v1/auth/saml/metadata` serves our SP metadata. Edition: `methodAllowedByEdition` allows `saml` only with the `sso` feature; the Public edition and an install with no edition refuse (routes 404, settings store throws, provider never built). Off by default: nothing is shown until settings are saved with `enabled: true`.

## 3. Tests run (all through heavy.sh, --maxWorkers 2-3)
- New: `saml-verify.test.ts` (45), `saml-sign-in.test.ts` (30), `saml-admin-routes.test.ts` (12). Fixtures make a certificate and key at run time (no key material in the repo) and sign with xml-crypto.
- Run together with company-sign-in, sso-admin-routes, audit-contracts, audit-outbox, cloud-sign-in, developer-identity-server, task-people, edition-gates, money-project-caller-identity, role-sites, task-owner-reads(+bypass), contracts-web-entry (includes web-safe-files), broker-settings, web-bundle-budget, agent-lifecycle: 19 files, 954 tests, all pass.
- Inventory gates: role-sites, task-owner-reads, contracts-web-entry/web-safe-files, broker-settings, web-bundle-budget, agent-lifecycle all pass. broker-settings, web-bundle-budget and contracts-web-entry need `packages/web/dist`; I built it (`npm run build --workspace @agentx/web` then `npx tsx scripts/web-precompress.ts`) and left it untracked. No UI change, so the 256000 budget is untouched.
- Other contract files in the same areas (119 files): 2036 tests pass; 10 files fail to load only because `@agentx/mcp`/`@agentx/orchestrator`/infra dists are not built here (environmental). `sso-cli.test.ts` is one of them.
- `tsc -b packages/contracts packages/broker`, eslint on all changed files, and strict shards pkg-contracts and pkg-broker: clean. In tests-contract-s the only TS errors are TS6305 "dist not built" ones.

## 4. Mutation checks (every assertion check), files restored byte for byte
Round 1 (75 mutations; log in scratchpad `mutation-log.txt`): 49 killed at once. 30 survived; each was read:
- Fixed by new tests, then killed in round 2: size bounds (both ends), base64 charset, strict UTF-8, NUL, assertion ID shape, Version, Subject count, NameID count, unreadable attribute value (this also exposed a bug: the marker value `\u0000` passed the group reader, so I changed it to an empty value, which the reader refuses as claim_invalid), sign-in waiting for another method.
- Redundant by design (the library and the broker make the same check), killed only when **both** are removed (round 2 "PAIR" mutations, all killed): audience (library + 2 broker checks), Conditions expiry, NotBefore, NotOnOrAfter required, subject-confirmation end and NotBefore, InResponseTo (root + library + signed confirmation), Conditions count (needed a new test: two Conditions elements).
- Still surviving after round 2, each shown to be harmless duplicates: (a) library `Referenced node is the signature's parent` and `ID unique`: the library returns only the signed bytes, so a wrapped assertion is never read even without these; with the multiple-assertions check also removed the wrapping tests do fail (killed). (b) stash handle shape (both places): an odd handle just finds no record. (c) `root is a Response`, `root InResponseTo equals ours`, nonce shape, `post-size` and `post-relay-shape`, admin `route-version-check`: each is covered by a second layer (library, signed confirmation, stash size bound, the store's compare-and-set).
- Library regressions are caught too: skipping `checkSignature`, the multiple-assertions check, the assertion-signature requirement and max assertion age each fail tests.

## 5. Decisions where the design was open (safer reading taken)
1. `saml` is a new sign-in method (as row I4 says), not "oidc with another issuer". The identity key is (IdP entity id, NameID).
2. Because accounts are keyed on the entity id, **it cannot be changed once saved**; moving IdP needs Rovara support. Cert, address and enabled can change.
3. The email in a SAML assertion counts as verified (the company's own IdP signs it), so invites written for an address work. A NameID in emailAddress format is used as the email when there is no email attribute. Say if you want this stricter.
4. Group names must come in an attribute named like an existing group claim (`groups`, `roles`, `memberOf`, `entitlements`, ...). Entra's long default claim URI is not accepted; the admin configures the IdP to send `groups`.
5. Transient NameIDs are refused. The AuthnRequest asks for no particular NameID format or authentication context (so multi-factor IdPs work).
6. Encrypted assertions are not supported (no decryption key; refused).
7. Certificate expiry is checked when saved, not at each sign-in (a rotated-but-late cert should not silently lock everyone out); a wrong cert fails the signature.
8. `methods.saml` in the broker's API configuration is `true` always; the edition check (`methodAllowedByEdition`) is what refuses SAML sessions on a Public or edition-less install. Turning SAML off (`enabled: false`) stops new sign-ins; sessions already open end at the 8 h cap, not at once.
9. `/.well-known/agentx-configuration` gains an optional `methods.saml` only when SAML is on.

## 6. Wiring pending (hot file)
None. All edits are in split modules (`aws/developer-routes/sso.ts`, `authentication.ts`, `types.ts`, `aws/developer-identity.ts`, `aws/workflow-dependencies-configuration.ts`, `aws/broker/model-access.ts`, `redirect-runtime.ts`); thin entry files untouched. No CDK change: `ANY /v1/auth/{proxy+}` already routes the POST.

## 7. Blocked on owner
Nothing blocks I4. Not built (not in the brief): web-app screen and CLI command for the SAML settings; IdP metadata XML import (the admin pastes entity id, address, certificate); SAML single logout.

## 8. Risks
- Changing the requester `provider` enums (turns, operation, admin) means older readers of newer records fail on `saml`: mixed fleet needs the usual upgrade order (broker and worker together). Only a SAML sign-in writes the new value.
- The library's time checks use the real clock (not injectable); the broker re-checks with `deps.now()`. Tests set the system date for the sign-in flow.
- Status, root InResponseTo and Destination are read from unsigned text and can only refuse; the trusted values come from the signed assertion.
- `emailVerified: true` for IdP emails (decision 3) is the one trust choice to review.

## 9. High-risk, needs an Opus review
All of I4 is authentication: `developer/saml.ts`, `samlSignInProvider`, the `server.ts` POST/GET callback and stash, `aws/developer-routes/sso.ts` (settings), `edition-methods.ts`, and the `saml` additions to the task-person identity/key-authority checks (`model-access.ts`, `task-person-identity.ts`).

## 10. Incident to tell the controller
The scratchpad directory is shared by sessions. My second mutation run started a script named `mutate2.py` that another session (model-ep) had overwritten in the shared scratchpad, so for about 4 minutes I ran THEIR mutation script against `/Users/abhishekgarg/web/Rovara-ent-model-ep-20261102`. It finished and its own restore check passed; `git status` there is clean now. I did not (and was blocked from) killing it. Their tests may have seen odd results in that window. My later scripts live in `scratchpad/ent-saml-i4/`.

## Checklist (rovara-task-checklist) how checked
1 Credentials: the response, assertion, groups and certificate are in no log or audit record (tests assert it; refusals log a fixed word). 2 Linux: no shell code, no Docker; fixtures use node:crypto only. 3 Stored data: no existing record changes; new keys `SSO_SAML_*` only. 4 Tests fail without the fix: section 4. 5 Fail closed and bounded: every refusal path above; stash 2 min, replay TTL, size and element bounds. 7 No subagents used.

---
# Fix round 1 (after the Opus review, review-opus.md)

Each fix has a test that failed first (about 45 of the new tests failed before any fix) and a mutation check that fails with the fix removed (log: scratchpad `ent-saml-i4/saml-fix1*.log`; every row killed, S5 after the test was sharpened).

- **B1** `providers.ts`: SAML identities carry issuer `saml:<entity id>`, so the account key names the method (`ownerKeyForSubject("saml:...", sub)`). The PUT also refuses an entity id equal to the sign-in issuer, the company OIDC issuer, the cloud issuer, Slack's or GitHub's (`reservedIssuers`, from the environment in `workflow-dependencies-configuration.ts`). Test: SAML saved with the OIDC issuer, NameID = an existing OIDC owner's sub, lands on a new account; the owner's account, role and sessions are untouched.
- **B2** the PUT is owner-only (an admin gets 403 and nothing is written or mailed). After the commit every owner is emailed (the sign-in notices' SES sender, `ownerNotice`, wired from `githubConnectedNotice` in `broker/handler.ts`): who changed it and what kind of change, never the values. A failed mail is logged and never undoes the save.
- **S1** new owner-only setting `trustEmail` (default off; leaving it out of a save turns it off). Off: no email at all comes from the assertion, so no Slack link, no address on the account, no invite matched by address. Decision for the owner. **Replaces: "SAML email always verified".**
- **S2** the algorithms, status and request match are read from the parsed DOM (the library's own `parseDomFromString`, via the deep import `@node-saml/node-saml/lib/xml.js`, so no new package; importing `@xmldom/xmldom` directly pulled in the DOM typings and broke the broker build). Signature algorithms must be RSA-SHA256/384/512 and digests SHA-256/384/512 (allow-list); the top status must be one Success. Tests: `rsa-sh&#x61;1`, `sh&#97;1`, an unlisted algorithm, a Success status inside a comment.
- **S3** `sessionsValidFrom` on the saved settings is set (rounded up) when SAML is turned off or the certificate or entity id changes. It is checked at every broker request (`authentication.ts`) and at refresh (`server.ts`); unreadable settings end the session. A code redeemed after the cutoff is not covered (it is minutes old at most).
- **S4** the stash is keyed by the auth request id (one conditional put per request), opened only with the random handle (stored as a hash, compared in constant time). Tests: 25 POSTs for one request keep one record; 25 POSTs for requests that do not exist keep none; another request's handle does not open it. The per-request cap is the rate cap; API Gateway's stage throttle covers the rest.
- **S5** a non-RSA certificate is refused at save with its own sentence.
- **N1** a response with no usable AuthnInstant gives `authTime: 0`: the session is never fresh. **N2** the session ends no later than the provider's `SessionNotOnOrAfter`. **N3** a NameID with surrounding whitespace is refused. **N5** a signed response must carry its Destination. **N6** the route uses `deps.now()`.
- **N4** the settings route refuses a caller whose org is not the install's single org (`singleOrgIdForEnv(env)`), the org sign-in reads.
- **N7, N8** noted: the library settings stand; the missing tests are added.
- Entity-id change stays refused (accounts are keyed on it); the cutoff also covers it if that ever changes.
- Not done: UI/CLI for the settings, as before. No new package (lockfile and package.json unchanged in this round).
