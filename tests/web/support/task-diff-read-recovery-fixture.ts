import { SessionDiffReaderSchema } from "@agentx/contracts/web";

export function taskDiffReadRecoveryCachedDiff() {
 return SessionDiffReaderSchema.parse({
  files: [{ path: "cached-secret.ts", status: "modified", additions: 1, deletions: 0, patch: "+cached text" }],
  pullRequest: { repository: "acme/payments", number: 42, url: "https://github.com/acme/payments/pull/42" },
 });
}
