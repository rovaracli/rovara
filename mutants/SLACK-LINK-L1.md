# SLACK-LINK-L1: "You're not in a company yet" says how to connect Slack to a GitHub account (2026-11-25)

Words only (packages/ui/src/screens/onboarding/CompanyScreens.tsx `NO_COMPANY_GITHUB_WORDS`), run against tests/web/no-company-words.test.ts (jsdom, the real route `/app/no-company`).

| Mutant / production location | Mutation | Result |
|---|---|---|
| CompanyScreens.tsx `NoCompanyScreen` | the sentence is not rendered (the screen before this change) | killed: red before the change, `getByTestId("no-company-github")` finds nothing; green with it |

The "true words only" assertion (no "any Slack workspace", "same email", "automatically", "merge" in the sentence) was run green against the real sentence only; no mutant was run against it.
