# ent-saml progress

- DONE: dependency (0f15730dd), I4 SAML sign-in (14f2bb0e5), tests and test follow-ups (4b45068d4, aa3c608cf, and the final test commit). Mutation checks run twice (see report.md).
- Not done (out of the brief): a web-app screen and CLI command for the SAML settings (the routes exist: GET/PUT /v1/app/org/sso/saml); a CDK change (none needed, `ANY /v1/auth/{proxy+}` already routes the POST).
- Resume: read report.md. Tests: tests/contract/saml-verify.test.ts, saml-sign-in.test.ts, saml-admin-routes.test.ts; fixtures tests/support/saml-fixtures.ts.
