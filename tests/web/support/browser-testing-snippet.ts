// The sign-in file Code serves when a repository declares no sign-in, built the way Code builds it (core/setup-agent/browser-testing-proposal.ts `signInSnippetFor`) as a plain object (Cloud no longer carries Code's e2e-application contract schema to parse it with). The page must show exactly this text.
import { createHash } from "node:crypto";
import { canonicalJson } from "../../../packages/contracts/src/canonical-json.js";

export function signInSnippet(): { path: string; text: string; needsSeedStep: true } {
  const body = {
    schemaVersion: 1, build: [], launch: { kind: "service", start: { program: "npm", args: ["start"], cwd: ".", timeoutMs: 120_000, env: {} }, health: { path: "/", expectedStatus: 200 } },
    serviceProfileIds: [], seedProfileId: "rovara-accounts-file/v1", accountProfileIds: ["user"], allowedOrigins: ["app-origin"],
    seed: { program: "npm", args: ["run", "rovara-seed"], cwd: ".", timeoutMs: 30_000, env: {} },
  };
  const recipe = { ...body, recipeDigest: createHash("sha256").update(canonicalJson(body)).digest("hex") };
  const contract = {
    schemaVersion: "e2e-application-project/v1", recipe,
    service: { listenPort: 4317, portEnv: "PORT", originBindings: [{ originRef: "app-origin", envName: "APP_ORIGIN" }] },
    accountProfiles: [{ profileId: "user", scope: "synthetic-test", authProfileId: "rovara-form-login/v1", seedProfileId: "rovara-accounts-file/v1", tenantRef: "tenant-a", roleRef: "user", identityProbeId: "identity/v1",
      login: { kind: "form", path: "/login", usernameTestId: "email", passwordTestId: "password", submitTestId: "login-submit", successTestId: "signed-in" } }],
    targetAccounts: [],
  };
  const parsed = contract;
  return { path: "package.json", text: `${JSON.stringify({ agentx: { e2e: parsed } }, null, 2)}\n`, needsSeedStep: true };
}
