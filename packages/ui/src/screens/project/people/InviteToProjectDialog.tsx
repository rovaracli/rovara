import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ReviewedInviteCreateBodySchema, type CloudProjectRole } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../../host.js";
import { useNav } from "../../../api/nav.js";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
import { Select } from "../../../design/Select.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { peopleKey, useProjectPeopleApi } from "../../../api/project-people.js";
import { projectRoleLabel } from "../../admin/projects/labels.js";
import { MAINTAINER_EMAIL_NOTE, ROLE_HELP, emailOutcomeWords } from "./people-text.js";
import { failureText, useRequestId } from "./people-write.js";

const INVITE_ROLES = ["maintainer", "contributor", "viewer"] as const;
type InviteRole = (typeof INVITE_ROLES)[number];
type Created = { text: string; email: string | undefined; link: string | undefined };
/** A join link the app will show: https (or http on localhost), no credentials. The server builds it; this only refuses anything odd before it reaches the clipboard. */
const safeLink = (value: string): boolean => { try { const url = new URL(value);return (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")) && url.username === "" && url.password === ""; } catch { return false; } };

/**
 * Invite someone new straight into this project (`POST /v1/app/org/invites/reviewed` with `project`). The roles are the ones the server's powers name (`invitableRoles`). A maintainer's invite must name an email
 * (the server refuses a link for them); only a company owner or admin may make a shareable link. The server's refusal is shown as it came.
 */
export function InviteToProjectDialog({ project, roles, open, onOpenChange }: { project: string; roles: readonly CloudProjectRole[]; open: boolean; onOpenChange: (open: boolean) => void }) {
 const host = useAppHost(), api = useProjectPeopleApi(), query = useQueryClient(), id = useRequestId(), nav = useNav();
 const admin = nav.data?.me.orgRole === "owner" || nav.data?.me.orgRole === "admin";
 const offered: readonly InviteRole[] = INVITE_ROLES.filter(role => roles.includes(role));
 const [destination, setDestination] = useState("email"), [email, setEmail] = useState(""), [role, setRole] = useState<string>(offered.includes("contributor") ? "contributor" : offered[0] ?? "viewer");
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [created, setCreated] = useState<Created>(), [copied, setCopied] = useState(false);
 const chosen = offered.find(value => value === role), emailRequired = !admin || destination === "email";
 function reset(next: boolean) { if (busy) return;if (!next) { id.reset();setCreated(undefined);setError(undefined);setEmail("");setCopied(false); }onOpenChange(next); }
 async function send() {
  if (busy || chosen === undefined) return;
  const body = ReviewedInviteCreateBodySchema.safeParse({ requestId: id.get(), role: "member", ...(emailRequired ? { email } : {}), project: { name: project, role: chosen } });
  if (!body.success || (emailRequired && body.data.email === undefined)) { setError("Enter a valid colleague email.");return; }
  setBusy(true);setError(undefined);
  try {
   const result = await api.invite({ requestId: id.get(), project, role: chosen, ...(emailRequired ? { email: body.data.email! } : {}) });
   if (result.receipt.requestId !== id.get() || result.receipt.project?.name !== project || result.receipt.project.role !== chosen) throw new Error("unverified");
   id.reset();
   const link = result.inviteUrl !== undefined && safeLink(result.inviteUrl) ? result.inviteUrl : undefined;
   setCreated({ text: link === undefined && result.inviteUrl === undefined && result.email === undefined && !emailRequired ? "Invite created, but its link can't be shown again. Revoke it in Invites and make a new one." : emailOutcomeWords(result.email), email: emailRequired ? body.data.email : undefined, link });
   await query.invalidateQueries({ queryKey: peopleKey(project) });
  } catch (failure) { id.settle(failure);setError(failure instanceof Error && failure.message === "unverified" ? "The invite answer couldn't be verified. Check Invites before trying again." : failureText(failure)); }
  finally { setBusy(false); }
 }
 async function copy() { if (created?.link === undefined || host.copyText === undefined) return;try { await host.copyText(created.link);setCopied(true); } catch { setError("The link could not be copied. Try again."); } }
 return <Dialog title="Invite into this project" open={open} onOpenChange={reset} description="They join the company and this project together.">
  {created === undefined ? <form className="rv-people-form" onSubmit={event => { event.preventDefault();void send(); }}>
   {admin && <Select label="Send it" value={destination} onValueChange={value => { id.reset();setDestination(value); }} options={[{ value: "email", label: "By email to a colleague" }, { value: "link", label: "As a link anyone can use" }]} />}
   {emailRequired && <TextField label="Colleague's email" type="email" autoComplete="off" value={email} maxLength={254} onChange={event => { id.reset();setEmail(event.target.value); }} {...(admin ? {} : { hint: MAINTAINER_EMAIL_NOTE })} />}
   <Select label="Project role" value={role} onValueChange={value => { id.reset();setRole(value); }} options={offered.map(value => ({ value, label: projectRoleLabel[value] }))} />
   {chosen !== undefined && <p className="rv-muted">{ROLE_HELP[chosen]}</p>}
   {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
   <div className="rv-people-actions"><Button type="submit" variant="primary" busy={busy} disabled={chosen === undefined}>Send invite</Button><Button disabled={busy} onClick={() => { reset(false); }}>Cancel</Button></div>
  </form> : <div className="rv-people-form">
   <p role="status">{created.text}</p>
   {created.email !== undefined && <p>Invited <VisibleText text={created.email} /> as {projectRoleLabel[chosen ?? "viewer"].toLowerCase()} in <VisibleText text={project} />.</p>}
   {created.link !== undefined && host.copyText !== undefined && <div className="rv-people-actions"><Button onClick={() => { void copy(); }}>{copied ? "Link copied" : "Copy invite link"}</Button></div>}
   {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
   <div className="rv-people-actions"><Button variant="primary" onClick={() => { reset(false); }}>Done</Button></div>
  </div>}
 </Dialog>;
}
