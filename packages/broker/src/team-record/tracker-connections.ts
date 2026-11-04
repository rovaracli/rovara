// The org's connected Linear and Jira connections as the tracker directory reads them (lane team-record-links). Built on the connection store the app already uses: a connection is offered only when it is
// Linear or Jira and has a saved secret, in THIS org; its secret is read when a page is read and goes nowhere but the tool's own address (Linear's fixed GraphQL address, the Jira site the connection names).
import type { OrgId } from "@agentx/contracts";
import { LINEAR_GRAPHQL, OrgConnectionStore, readConnection, readConnectionSecret, type OrgConnectionDeps, type OrgConnectionRecord } from "../connections/store.js";
import { atlassianManagedAccountsReader, jiraPlaceNamesReader, jiraPlacesReader, jiraUsersReader, linearPlaceNamesReader, linearPlacesReader, linearUsersReader, type ConnectedTracker, type ConnectedTrackersPort, type ManagedAccounts } from "./tracker-directory.js";

export function connectedTrackersOf(input: { deps: OrgConnectionDeps; fetch?: typeof fetch }): ConnectedTrackersPort {
  const fetchImplementation = input.fetch ?? fetch;
  function trackerOf(orgId: OrgId, record: OrgConnectionRecord & { secretVersion?: string }): ConnectedTracker | undefined {
    if (record.orgId !== orgId || record.hasSecret !== true) return undefined;
    const ref = { connectionId: record.connectionId, type: record.type, ...(record.secretVersion === undefined ? {} : { secretVersion: record.secretVersion }) };
    if (record.type === "linear") {
      return {
        connectionId: record.connectionId, system: "linear", kind: "linear",
        async readUsers(page) {
          const secret = await readConnectionSecret(input.deps, orgId, ref);
          if (secret === undefined || !("apiKey" in secret)) throw new Error("the saved secret could not be read");
          return linearUsersReader({ fetch: fetchImplementation, graphqlUrl: LINEAR_GRAPHQL, apiKey: secret.apiKey })(page);
        },
        async readPlaces(page) {
          const secret = await readConnectionSecret(input.deps, orgId, ref);
          if (secret === undefined || !("apiKey" in secret)) throw new Error("the saved secret could not be read");
          return linearPlacesReader({ fetch: fetchImplementation, graphqlUrl: LINEAR_GRAPHQL, apiKey: secret.apiKey })(page);
        },
        async readPlaceNames(page) {
          const secret = await readConnectionSecret(input.deps, orgId, ref);
          if (secret === undefined || !("apiKey" in secret)) throw new Error("the saved secret could not be read");
          return linearPlaceNamesReader({ fetch: fetchImplementation, graphqlUrl: LINEAR_GRAPHQL, apiKey: secret.apiKey })(page);
        },
      };
    }
    if (record.type === "jira") {
      const siteUrl = record.siteUrl;
      // The managed accounts are read once per tracker object (one run), and only when the connection holds an organization admin key; the key is read with the rest of the secret and goes to Atlassian's admin host only.
      let managed: Promise<ManagedAccounts | undefined> | undefined;
      return {
        connectionId: record.connectionId, system: `jira:${new URL(siteUrl).hostname}`, kind: "jira",
        async readUsers(page) {
          const secret = await readConnectionSecret(input.deps, orgId, ref);
          if (secret === undefined || !("apiToken" in secret) || !("email" in secret)) throw new Error("the saved secret could not be read");
          const adminKey = "orgAdminKey" in secret && "atlassianOrgId" in secret && typeof secret.orgAdminKey === "string" && typeof secret.atlassianOrgId === "string" ? { apiKey: secret.orgAdminKey, atlassianOrgId: secret.atlassianOrgId } : undefined;
          return jiraUsersReader({
            fetch: fetchImplementation, siteUrl, email: secret.email, apiToken: secret.apiToken,
            ...(adminKey === undefined ? {} : { managed: () => (managed ??= atlassianManagedAccountsReader({ fetch: fetchImplementation, ...adminKey })()) }),
          })(page);
        },
        async readPlaces(page) {
          const secret = await readConnectionSecret(input.deps, orgId, ref);
          if (secret === undefined || !("apiToken" in secret) || !("email" in secret)) throw new Error("the saved secret could not be read");
          return jiraPlacesReader({ fetch: fetchImplementation, siteUrl, email: secret.email, apiToken: secret.apiToken })(page);
        },
        async readPlaceNames(page) {
          const secret = await readConnectionSecret(input.deps, orgId, ref);
          if (secret === undefined || !("apiToken" in secret) || !("email" in secret)) throw new Error("the saved secret could not be read");
          return jiraPlaceNamesReader({ fetch: fetchImplementation, siteUrl, email: secret.email, apiToken: secret.apiToken })(page);
        },
      };
    }
    return undefined;
  }
  return {
    async list(orgId) {
      const store = new OrgConnectionStore({ ...input.deps });
      const out: ConnectedTracker[] = [];
      for (const listed of await store.list(orgId)) {
        if (listed.type !== "linear" && listed.type !== "jira") continue;
        const record = await readConnection(input.deps, orgId, listed.connectionId);
        const tracker = record === undefined ? undefined : trackerOf(orgId, record);
        if (tracker !== undefined) out.push(tracker);
      }
      return out;
    },
    async get(orgId, connectionId) {
      const record = await readConnection(input.deps, orgId, connectionId);
      return record === undefined ? undefined : trackerOf(orgId, record);
    },
  };
}
