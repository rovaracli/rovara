// Enterprise foundations P10: the names a change request is filed under are the host's own. GitHub keeps `owner/name` exactly as before; any other host is `<kind>:<address>`. The merge
// observation of a change request on another host is read through the port and the neutral link; its feedback is not available there yet (refused, never read as GitHub's).
import { describe, expect, it } from "vitest";
import { changeRequestRepositoryKey } from "../../packages/broker/src/aws/broker/repository-hosts.js";
import { reconcileTaskPullRequestFeedback, type ReconcileTaskPullRequestFeedbackInput } from "../../packages/broker/src/aws/github-webhooks.js";

describe("the key a change request is filed under", () => {
  it("is GitHub's owner/name for a GitHub repository, as it always was, and a GitHub address that is not one is refused as before", () => {
    expect(changeRequestRepositoryKey({ kind: "github" }, "https://github.com/Acme/Web.git")).toBe("Acme/Web");
    expect(() => changeRequestRepositoryKey({ kind: "github" }, "https://git.example.test/acme/web")).toThrow(/GitHub/);
  });

  it("is <kind>:<address> for any other host, from the address the install registered", () => {
    expect(changeRequestRepositoryKey({ kind: "fake" }, "https://Git.Example.test/acme/demo.git")).toBe("fake:https://git.example.test/acme/demo");
    expect(changeRequestRepositoryKey({ kind: "fake" }, "https://git.example.test/acme/demo/")).toBe("fake:https://git.example.test/acme/demo");
  });

  it("is refused, with a fixed sentence that does not echo the address, when the host's address cannot be keyed", () => {
    for (const address of ["not a url", "ssh://git.example.test/acme/demo", "https://user:pw@git.example.test/acme/demo"]) {
      let failure: { code?: string; message: string } | undefined;
      try { changeRequestRepositoryKey({ kind: "fake" }, address); } catch (error) { failure = error as { code?: string; message: string }; }
      expect(failure?.code, address).toBe("CONFIG_INVALID");
      expect(failure?.message).not.toContain("pw");
    }
  });
});

describe("a change request on another host is followed for its merge only", () => {
  const input = (over: Partial<ReconcileTaskPullRequestFeedbackInput>): ReconcileTaskPullRequestFeedbackInput => ({
    documentClient: { send: async () => { throw new Error("nothing is read before the refusal"); } }, tableName: "state", repositoryFullName: "fake:https://git.example.test/acme/demo", number: 7, deliveryId: "d-1",
    neutralHost: { kind: "fake", repositoryAddress: "https://git.example.test/acme/demo" },
    loadTask: async () => undefined, repositoryUrl: async () => undefined, getCurrentFeedback: async () => { throw new Error("no read"); },
    persistBundle: async () => "k", saveWorkflow: async () => undefined, now: "2026-11-02T10:00:00.000Z", ...over,
  });

  it("refuses a feedback read for it before reading anything (fail closed), whether the mode is the default or feedback", async () => {
    for (const observationMode of [undefined, "feedback" as const]) {
      await expect(reconcileTaskPullRequestFeedback(input(observationMode === undefined ? {} : { observationMode }))).rejects.toThrow(/not available for this code host/);
    }
  });

  it("refuses a merge observation of a change request that no task is linked to", async () => {
    await expect(reconcileTaskPullRequestFeedback(input({ observationMode: "merge", documentClient: { send: async () => ({ Item: undefined }) } }))).rejects.toThrow(/not linked/);
  });
});
