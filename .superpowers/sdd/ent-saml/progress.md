# ent-saml progress

## I4 SAML 2.0 sign-in: STOPPED before code (needs a controller decision on a dependency)

Checked at f24cab6d2: `package-lock.json` has no SAML, XML-DSig, XML C14N or runtime XML parser package.
- Only XML parsers present: `saxes` 6.0.0 and `xmlchars` (dev-only, pulled in by `jsdom`), and `@aws-sdk/xml-builder` (a builder, no parser).
- `jose` is present but covers JWT/JWS only, not XML signatures.
- Rolling our own XML parser plus exclusive canonicalisation plus XML-DSig reference checks is the highest-risk part of the task (signature wrapping, XXE, entity expansion). The brief forbids it without a library, so nothing was written.

No code, tests or lockfile changes were made. No commit other than this note.

## Library to add (proposal)
`@node-saml/node-saml` 5.2.0 (MIT, last published 2026-10-26), which depends on `xml-crypto` ^6.4.0 (MIT, 2026-10-14), `@xmldom/xmldom` ^0.8.15, `xpath`, `xml2js`, `xmlbuilder`, `xml-encryption`.
- Why: maintained, widely used (Passport-SAML core), validates signed response or assertion against a configured IdP cert, audience, destination/recipient, conditions with clock skew, InResponseTo with a pluggable cache, and has a pluggable replay hook. It is the successor of passport-saml.
- Alternative with a smaller surface: `xml-crypto` 6.4.0 + `@xmldom/xmldom` only, and we write the Response checks ourselves (more of our own code on the auth path).
- Not recommended: `samlify` (heavier, weaker track record on signature-wrapping fixes).
- Notes for the controller: node-saml's own assertion checks must be wrapped by our code so that (a) only the verified element's content is read, (b) DOCTYPE/ENTITY is rejected before parsing (reject any `<!DOCTYPE` in the raw bytes), (c) IdP-initiated (no InResponseTo) is refused, (d) one-time assertion-ID store with TTL, (e) response size bound. These need tests either way: unsigned, wrong audience, wrong recipient/destination, expired, not-yet-valid, InResponseTo mismatch, replay, wrapping, DOCTYPE/XXE.

## Planned shape once approved (not started)
- `packages/broker/src/developer/saml-sign-in.ts` (verify + normalise to `ProviderIdentity` with `claims` from SAML attributes), new `samlSignInProvider` in `providers.ts`, `DeveloperSignInMethod` extended in `contracts/src/developer-web.ts`, reuse `decideCompanySignIn` (`sso-sign-in.ts`), `resolveOrgOnSignIn`, group mapping, ban checks, invite rules and audit as OIDC does in `developer/server.ts` (~lines 590-735).
- Settings: IdP entity id, SSO URL, cert (public) via the settings change path as high-risk (fresh sign-in, audited); Public edition refuses.
- Gates to run afterwards: role-sites, task-owner-reads, contracts-web-entry, web-safe-files, broker-settings, web-bundle-budget; mutation checks on every assertion check.
