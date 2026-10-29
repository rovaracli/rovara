// Explicit native registration for old settings-only fixtures, never an authority-loss test fallback.
import { StoredProjectDefinitionSchema, projectRevisionKey, type OrgId } from "@agentx/contracts";
import type { FakeDynamoDb } from "./fake-dynamodb.js";
export function fixtureProject(db: FakeDynamoDb, orgId: OrgId, name: string): void {
  const definition = StoredProjectDefinitionSchema.parse({ name, revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Fixture project." });
  db.set({ ...projectRevisionKey(orgId, name, 1), definition });
}
