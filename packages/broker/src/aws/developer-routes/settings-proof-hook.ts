// TE-4: the broker tells the settings proof when a project's setup check has reported (terminal-result.ts), so a held API change is written or dropped, and a failed save's message is sent, without waiting for
// someone to read the project. The handler installs the settler (it alone can build the developer API's dependencies); where none is installed nothing happens and the read-time settle is the backstop.
let settler: ((workspaceId: string) => Promise<void>) | undefined;

export function installSettingsProofSettler(settle: (workspaceId: string) => Promise<void>): void {
  settler = settle;
}

/** Called after a check's prepare reported and its workspace was closed. Never throws: the check's result is never failed for this. */
export async function settleAfterCheckReported(workspaceId: string): Promise<void> {
  try {
    await settler?.(workspaceId);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "developer.settings_proof_settle_hook_failed", workspaceId, error: error instanceof Error ? error.name : "unknown" }));
  }
}
