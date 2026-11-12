// Lane A9: the world Cloud's GitHub adapters (the GitHub App code host, the GitHub Actions check runner) run Code's suites in. Code's own host model and Code's own fixture of GitHub's
// REST and GraphQL API (both vendored, byte for byte the pin) serve Cloud's real `GitHubAppCredentialProvider` (`packages/broker/src/github-app.ts`), so Cloud's request choreography
// and parsing run for real against the GitHub that Code's suites were written for. Nothing here is Code's: only how Cloud's provider is built over the fixture.
import { generateKeyPairSync } from "node:crypto";
import { FakeHostModel } from "../../../vendor/rovara-code/packages/broker/src/plugins/fake/model.js";
import { GITHUB_ORG_SCOPE, GITHUB_OTHER_URL, GITHUB_REPO_URL, GitHubFixtureApi } from "../../../vendor/rovara-code/tests/support/ports/github-fixture-api.js";
import { GitHubAppCredentialProvider } from "../../../packages/broker/src/github-app.js";

export { GITHUB_ORG_SCOPE, GITHUB_OTHER_URL, GITHUB_REPO_URL, GitHubFixtureApi };

/** The clock Cloud's provider and the adapters read in these worlds. */
export const GITHUB_NOW = Date.parse("2026-10-30T10:00:00.000Z");

/** Cloud's provider reads Rovara's own working branches only (`agentx/<uuid>`), so the suites' working branches carry that name. */
export const workingBranch = (n: number): string => `agentx/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * A fresh host model of one repository on github.com. Its clock starts a minute before the provider's: the model ticks one second per event and the fixture mints each token for an hour from
 * the model's clock, so a token minted after a few events must still expire within the hour the suite allows from the adapter's clock (as GitHub's own tokens do).
 */
export function githubModel(): FakeHostModel {
  const model = new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app", webBase: "https://github.com" });
  model.setNow(new Date(GITHUB_NOW - 60_000).toISOString());
  return model;
}

/** Cloud's real GitHub App provider, talking only to the fixture (a throwaway key made here; nothing leaves the process). Every installation counts as bound, as a Cloud install's are. */
export function cloudProviderOver(api: GitHubFixtureApi): GitHubAppCredentialProvider {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return new GitHubAppCredentialProvider({
    credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fetchImplementation: api.fetch, now: () => GITHUB_NOW,
    requireInstallationBound: async () => undefined,
  });
}
