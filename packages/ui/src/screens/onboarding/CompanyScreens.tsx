// DEC 253z onboarding screens: a person Code names no company for ("You're not in a company yet"), creating a company with an operator's
// invite code (DEC 254a), and joining one from an invite link. None needs the app's navigation (the person has no company yet).
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { z } from "zod";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { TextField } from "../../design/TextField.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import "./onboarding.css";

export const JOIN_UNUSABLE = "This invite can't be used. Ask your company admin for a new one.";
const CreatedSchema = z.object({ companyId: z.string().regex(/^org_[0-9a-z]{20}$/u), signInAgain: z.literal(true) }).strict();

export function NoCompanyScreen() {
  const host = useAppHost();
  return <main className="rv-entry rv-onboarding-entry" data-testid="no-company"><p className="rv-eyebrow">Rovara</p><PageHeader title="You're not in a company yet" description="Rovara works inside a company: its people, projects and rules." focusOnMount /><Button variant="primary" data-testid="no-company-create" onClick={() => host.navigate("/app/create-company")}>Create your company</Button><p className="rv-muted" data-testid="no-company-invite">Have an invite? Open the link you were sent.</p></main>;
}

export function CreateCompanyScreen() {
  const host = useAppHost(), [name, setName] = useState(""), [code, setCode] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  async function create() {
    setBusy(true); setError(undefined);
    try {
      const result = await createApiClient(host).send("POST", "/v1/app/companies", { name: name.trim(), inviteCode: code.trim() }, CreatedSchema, { retry: "never" });
      if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "Your company couldn't be created right now. Try again in a moment.");
      // The sign-in Cloud holds names no company yet: sign in again, then the first-day flow.
      host.signIn("/app/onboard");
    } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Your company couldn't be created right now. Try again in a moment."); }
    finally { setBusy(false); }
  }
  return <main className="rv-entry rv-onboarding-entry" data-testid="create-company"><p className="rv-eyebrow">Rovara</p><PageHeader title="Create your company" description="Name your company and enter the invite code the Rovara team gave you." focusOnMount /><form onSubmit={event => { event.preventDefault(); void create(); }}><TextField label="Company name" data-testid="create-company-name" value={name} maxLength={80} autoComplete="organization" onChange={event => setName(event.target.value)} /><TextField label="Invite code" data-testid="create-company-code" value={code} maxLength={128} autoComplete="off" spellCheck={false} onChange={event => setCode(event.target.value)} /><Button type="submit" variant="primary" data-testid="create-company-submit" busy={busy} disabled={!name.trim() || !code.trim()}>Create</Button></form>{error !== undefined && <p role="alert" data-testid="create-company-error"><VisibleText text={error} /></p>}</main>;
}

export function JoinScreen() {
  const host = useAppHost(), [params] = useSearchParams(), [state, setState] = useState<{ kind: "loading" } | { kind: "ready"; company: string } | { kind: "unusable" } | { kind: "email-refused"; reason: "mismatch" | "unverified" }>(() => {
    const emailErrors = params.getAll("email");
    const emailError = emailErrors.length === 1 && (emailErrors[0] === "mismatch" || emailErrors[0] === "unverified") ? emailErrors[0] : undefined;
    return emailError === undefined ? (params.get("unusable") === "1" || host.lookUpInvite === undefined ? { kind: "unusable" } : { kind: "loading" }) : { kind: "email-refused", reason: emailError };
  });
  useEffect(() => {
    if (state.kind !== "loading" || host.lookUpInvite === undefined) return;
    let live = true;
    host.lookUpInvite().then(found => { if (live) setState(found === undefined ? { kind: "unusable" } : { kind: "ready", company: found.companyName }); }, () => { if (live) setState({ kind: "unusable" }); });
    return () => { live = false; };
  }, [host, state.kind]);
  if (state.kind === "loading") return <main className="rv-entry rv-onboarding-entry"><Skeleton label="Opening your invite" /></main>;
  if (state.kind === "unusable") return <main className="rv-entry rv-onboarding-entry" data-testid="join"><p className="rv-eyebrow">Rovara</p><PageHeader title="This invite can't be used" focusOnMount /><p data-testid="join-unusable">{JOIN_UNUSABLE}</p></main>;
  if (state.kind === "email-refused") return <main className="rv-entry rv-onboarding-entry" data-testid="join"><p className="rv-eyebrow">Rovara</p><PageHeader title={state.reason === "mismatch" ? "This invite is for another email" : "This sign-in has no verified email"} focusOnMount /><p data-testid="join-email-refused">Reopen the original invite link and sign in with the invited email.</p><p>Slack and GitHub may need you to choose the account that carries that email.</p></main>;
  return <main className="rv-entry rv-onboarding-entry" data-testid="join"><p className="rv-eyebrow">Rovara</p><PageHeader title={`Join ${state.company} on Rovara`} focusOnMount /><Button variant="primary" data-testid="join-sign-in" onClick={() => host.signIn("/app", { join: true })}>Sign in to join</Button></main>;
}
