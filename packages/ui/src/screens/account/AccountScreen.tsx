// Your account (Hybrid 1, DEC 223): your name, how the app looks, and the two things a fresh sign-in uses: your confirmation email and your passkeys.
// The email is set by a company admin (Sign-in factors); a passkey is yours to list and remove. Removing one is sensitive, so it shows the fresh sign-in step first.
// Cloud passes these reads through once Code's sign-in service serves them; until then each part says "not connected yet" (proposed routes in api/admin-company.ts).
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isPlaceholderDisplayName } from "@agentx/contracts/web";
import { MY_FACTORS_PATH, isNotConnected, needsStepUp, passkeyPath, readMyFactors, type Passkey } from "../../api/admin-company.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { useTheme, type ThemePreference } from "../../theme.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { NameForm } from "../../shell/NameForm.js";
import { AdminSection, FreshSignIn, NotConnected, forgetConfirmed, useJustConfirmed } from "../admin/parts.js";
import { ConnectedSignIns } from "./ConnectedSignIns.js";
import { useNav } from "./use-nav.js";
import "../admin/admin.css";

const when = (value: string) => new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

export function AccountScreen() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient(), theme = useTheme(), nav = useNav();
 const [params, setParams] = useSearchParams(), confirmed = useJustConfirmed(nav?.me.developerId), removing = params.get("remove");
 const [busy, setBusy] = useState(false), [result, setResult] = useState<{ kind: "ok" | "failed" | "step_up" | "not_connected"; text: string }>(), [removed, setRemoved] = useState(false), [stale, setStale] = useState(false);
 const factors = useQuery({ queryKey: ["account", "factors"], queryFn: () => api.get(MY_FACTORS_PATH, { parse: readMyFactors }), retry: false, gcTime: 0 });
 const target: Passkey | undefined = factors.data?.passkeys.find(key => key.credentialId === removing);
 async function remove() {
  if (target === undefined) return;
  setBusy(true); setResult(undefined);
  try { await api.sendAnswer("DELETE", passkeyPath(target.credentialId), {}, { parse: body => body }, { retry: "never" }); setResult(undefined); setRemoved(true); setParams({}, { replace: true }); await query.invalidateQueries({ queryKey: ["account", "factors"] }); }
  catch (error) {
   if (needsStepUp(error)) { setStale(true); if (nav !== undefined) forgetConfirmed(host.storage, nav.me.developerId); setResult({ kind: "step_up", text: "" }); }
   else if (isNotConnected(error)) setResult({ kind: "not_connected", text: "" });
   else setResult({ kind: "failed", text: error instanceof ApiError ? error.message : "Couldn't remove the passkey. Try again." });
  } finally { setBusy(false); }
 }
 const ready = confirmed && !stale;
 return <section aria-label="Your account" className="rv-account">
  <PageHeader focusOnMount title="Your account" {...(nav === undefined ? {} : { description: `${nav.me.name} · ${nav.org.name}` })} />
  <AdminSection title="You">
   {nav !== undefined && <NameForm key={nav.me.name} label="Your name" initial={isPlaceholderDisplayName(nav.me.name) ? "" : nav.me.name} submit="Save name" />}
   <fieldset className="rv-theme-options"><legend>Appearance</legend>{(["system", "light", "dark"] as const).map((value: ThemePreference) => <label key={value}><input type="radio" name="appearance" value={value} checked={theme.preference === value} onChange={() => theme.setPreference(value)} />{value === "system" ? "System" : value === "light" ? "Light" : "Dark"}</label>)}</fieldset>
  </AdminSection>
  <AdminSection title="Confirmation email" note="Where your sign-in codes go">
   {factors.isPending ? <Skeleton label="Loading your sign-in factors" /> : factors.isError ? (isNotConnected(factors.error) ? <NotConnected what="Your confirmation email and passkeys" /> : <div role="alert" className="rv-banner rv-banner-danger"><span><b>Couldn't load your sign-in factors.</b></span><Button disabled={factors.isFetching} onClick={() => { void factors.refetch(); }}>Try again</Button></div>)
    : factors.data.factorEmail === undefined ? <p>No confirmation email is set. A fresh sign-in needs a passkey or a code sent to one. Ask a company admin to set it.</p>
    : <p><b data-testid="factor-email"><VisibleText text={factors.data.factorEmail} /></b></p>}
   <p className="rv-muted">It comes from your first sign-in. Changing your email at Slack, Google or GitHub never moves it; only a company admin can change it, and the old address is told first.</p>
  </AdminSection>
  <AdminSection title="Passkeys" note="Tap to confirm it's you">
   {removed && <p role="status">Passkey removed. You can still confirm with a code sent to your confirmation email.</p>}
   {factors.isPending ? <Skeleton label="Loading your passkeys" /> : factors.data === undefined ? (isNotConnected(factors.error) ? <NotConnected what="Passkeys" /> : <p className="rv-muted">Passkeys are unavailable until your sign-in factors load.</p>)
    : factors.data.passkeys.length === 0 ? <p>You have no passkeys. After a fresh sign-in with an emailed code, Rovara offers to add one.</p>
    : <ul className="rv-passkeys" aria-label="Your passkeys">{factors.data.passkeys.map(key => <li key={key.credentialId}><span>Passkey added {when(key.createdAt)}<small>{key.lastUsedAt === undefined ? "Not used yet" : `Last used ${when(key.lastUsedAt)}`}</small></span><Button aria-label={`Remove the passkey added ${when(key.createdAt)}`} onClick={() => { setResult(undefined); setRemoved(false); setParams({ remove: key.credentialId }, { replace: true }); }}>Remove</Button></li>)}</ul>}
  </AdminSection>
  <ConnectedSignIns confirmed={confirmed} who={nav?.me.developerId} />
  <Dialog title="Remove this passkey?" description="You can still confirm with a code sent to your confirmation email." open={target !== undefined} onOpenChange={next => { if (!next) { setResult(undefined); setParams({}, { replace: true }); } }}>
   {!ready ? <FreshSignIn action="remove a passkey" refused={stale} /> : <><FreshSignIn action="remove a passkey" done /><Button variant="danger" busy={busy} onClick={() => { void remove(); }}>Remove passkey</Button></>}
   {result?.kind === "failed" && <p role="alert"><VisibleText text={result.text} /></p>}
   {result?.kind === "not_connected" && <NotConnected what="Passkeys" />}
  </Dialog>
 </section>;
}
