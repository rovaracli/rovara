import { useState } from "react";
import type { AppProjectDetail } from "@agentx/cloud-contracts/web";
import { useOnboardingApi } from "../../../api/onboarding.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";

const STATUS_WORDS = { proven: "Proven", checking: "Checking", unproven: "Unproven" } as const;
const HELD_WORDS = {
  checking: "A change made with an API key is being checked on a fresh machine. It is not in the settings yet; tasks keep using the commands saved now.",
  failed: "A change made with an API key did not pass its check, so it was not saved. Tasks keep using the commands saved now.",
  stale: "A change made with an API key was not saved because the settings changed while it was being checked. Send it again.",
  refused: "A change made with an API key passed its check but could not be saved, so nothing was changed.",
  not_started: "The check of a change made with an API key did not start, so it was not saved. Send it again.",
} as const;

/**
 * TE-4: whether the setup and test commands and the dev container now in the settings were proved on a fresh machine (Proven, Checking or Unproven), the change an API key asked for that is waiting for its
 * check, and, when a saved change failed its check, the one-click way back to the last setup that passed. Going back needs a maintainer, a browser and a sign-in within the last ten minutes; the server decides.
 */
export function SettingsProofSection({ project, onProject }: { project: AppProjectDetail; onProject: (project: AppProjectDetail) => void }) {
  const api = useOnboardingApi();
  const host = useAppHost();
  const proof = project.settingsProof;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; reauth: boolean }>();
  const [intent, setIntent] = useState(() => crypto.randomUUID());
  if (proof === undefined) return null;
  async function undo() {
    setBusy(true);
    setError(undefined);
    try {
      const done = await api.undoSettings(project.name, { requestId: intent, expectedRevision: project.latestRevision });
      setIntent(crypto.randomUUID());
      onProject(done.project);
    } catch (caught) {
      setError(caught instanceof ApiError ? { message: caught.message, reauth: caught.code === "REAUTH_REQUIRED" } : { message: "Couldn't go back to the last proven setup.", reauth: false });
    } finally {
      setBusy(false);
    }
  }
  return <section aria-label="Proof of the commands">
    <h3>Are these commands proven?</h3>
    <p role="status"><strong>{STATUS_WORDS[proof.status]}</strong>{proof.status === "proven" ? " on a fresh machine." : proof.status === "checking" ? ": Rovara is running these commands on a fresh machine." : "."}{proof.reason && <> <VisibleText text={proof.reason} /></>}</p>
    {proof.notice && <aside role="alert"><p><VisibleText text={proof.notice.message} /></p>{proof.canUndo && project.myRole === "maintainer" && <Button variant="primary" busy={busy} onClick={() => { void undo(); }}>Undo to the last proven setup</Button>}</aside>}
    {!proof.notice && proof.canUndo && proof.status !== "proven" && project.myRole === "maintainer" && <Button busy={busy} onClick={() => { void undo(); }}>Undo to the last proven setup</Button>}
    {proof.held && <aside role="status"><p>{HELD_WORDS[proof.held.status]}</p>{proof.held.reason && <p><VisibleText text={proof.held.reason} /></p>}</aside>}
    {error && <p role="alert"><VisibleText text={error.message} />{error.reauth && <> <Button onClick={() => host.signIn(host.currentPath())}>Sign in again</Button></>}</p>}
  </section>;
}
export default SettingsProofSection;
