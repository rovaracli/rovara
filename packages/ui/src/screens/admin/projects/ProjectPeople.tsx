import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppOrgMembersResponseReaderSchema, ProjectMembersResponseSchema } from "@agentx/contracts/web";
import { ApiError } from "../../../api/errors.js";
import { createApiClient } from "../../../api/client.js";
import { useAppHost } from "../../../host.js";
import { DataTable } from "../../../design/DataTable.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../admin-context.js";
import { projectRoleLabel } from "./labels.js";
import { ReadState, useAdminRead } from "./read.js";

const peopleReader = { parse(value: unknown) { return { members: ProjectMembersResponseSchema.parse(value).members.map(person => ({ developerId: person.developerId, name: person.name, role: person.role, source: person.source })) }; } };
const candidatesReader = { parse(value: unknown) { return { members: AppOrgMembersResponseReaderSchema.parse(value).members.map(person => ({ developerId: person.developerId, name: person.name })) }; } };
const grantReader = { parse(value: unknown) { const parsed = value as { member?: { developerId?: unknown; role?: unknown } }; if (typeof parsed?.member?.developerId !== "string" || parsed.member.role !== "contributor") throw new Error("invalid grant response"); return parsed.member; } };
const removeReader = { parse(value: unknown) { const parsed = value as { developerId?: unknown; removed?: unknown }; if (typeof parsed?.developerId !== "string" || typeof parsed.removed !== "boolean") throw new Error("invalid removal response"); return parsed; } };

function refusal(error: unknown) {
 if (error instanceof ApiError && error.status === 403) return "You don't have permission to change access for this project.";
 if (error instanceof ApiError && error.status === 404) return "This project or person isn't available in your company.";
 return "Access could not be changed. Refresh the project people list and try again.";
}

// Step 1: only company owners/admins use the existing company directory. A project's admins
// can remove now; their candidate read and Add picker belong to DEC 254zzz198 step 2.
function CompanyGrant({ name, busy, grant }: { name: string; busy: string | undefined; grant: (developerId: string) => Promise<void> }) {
 const read = useAdminRead("project-people-candidates", name, "/v1/app/org/members", candidatesReader);
 const [person, setPerson] = useState("");
 const ready = read.isSuccess && !read.isFetching;
 function submit(event: FormEvent) {
  event.preventDefault();
  if (!ready || busy !== undefined || !read.data?.members.some(member => member.developerId === person)) return;
  void grant(person);
 }
 return <ReadState read={read} label="company members">{data => ready && <form onSubmit={submit}>
  <label htmlFor={`project-person-${name}`}>Company member</label>
  <select id={`project-person-${name}`} className="rv-input" value={person} onChange={event => setPerson(event.target.value)} disabled={busy !== undefined}>
   <option value="">Choose a person</option>{data.members.map(member => <option key={member.developerId} value={member.developerId}>{member.name}</option>)}
  </select>
  <button className="rv-button rv-button-primary" type="submit" disabled={busy !== undefined || !data.members.some(member => member.developerId === person)}>{busy === "grant" ? "Granting access…" : "Grant access"}</button>
 </form>}</ReadState>;
}

export function ProjectPeople({ name }: { name: string }) {
 const context = useAdminContext(), host = useAppHost(), query = useQueryClient(), api = useMemo(() => createApiClient(host), [host]);
 const read = useAdminRead("project-members", name, `/v1/app/projects/${encodeURIComponent(name)}/members`, peopleReader);
 const [busy, setBusy] = useState<string>(), [feedback, setFeedback] = useState<{ kind: "status" | "alert"; text: string }>();
 // Code applies the same live company/project permission check before GET, PUT and DELETE.
 // A browser's project role or cached navigation role is never evidence for these controls.
 const allowed = host.kind === "web" && !context.checking && read.isSuccess && !read.isFetching;
 const companyAdmin = context.role === "owner" || context.role === "admin";
 const path = (who: string) => `/v1/app/projects/${encodeURIComponent(name)}/members/${encodeURIComponent(who)}`;
 async function changed() {
  await Promise.all([query.invalidateQueries({ queryKey: ["admin", "project-members", context.orgId, context.developerId, name] }), query.invalidateQueries({ queryKey: ["nav"] })]);
 }
 async function grant(target: string) {
  if (!allowed || !companyAdmin || busy !== undefined) return;
  setBusy("grant"); setFeedback(undefined);
  try {
   await api.sendAnswer("PUT", path(target), {}, grantReader, { retry: "never" });
   setFeedback({ kind: "status", text: "Access granted." });
   await changed();
  } catch (error) { setFeedback({ kind: "alert", text: refusal(error) }); }
  finally { setBusy(undefined); }
 }
 async function remove(developerId: string) {
  if (!allowed || busy !== undefined) return;
  setBusy(developerId); setFeedback(undefined);
  try {
   const result = await api.sendAnswer("DELETE", path(developerId), {}, removeReader, { retry: "never" });
   if (!result.removed) { setFeedback({ kind: "alert", text: "Access was not removed. Refresh the project people list and try again." });return; }
   setFeedback({ kind: "status", text: "Access removed." });
   await changed();
  } catch (error) { setFeedback({ kind: "alert", text: refusal(error) }); }
  finally { setBusy(undefined); }
 }
 return <section className="rv-project-section" aria-labelledby={`project-people-${name}`}><h2 id={`project-people-${name}`}>Project people</h2><p>Company owners and admins can grant access. They and this project's administrators can remove direct project access.</p>
  {feedback && <p role={feedback.kind === "alert" ? "alert" : "status"}>{feedback.text}</p>}
  <ReadState read={read} label="project people">{data => <>
   {allowed && companyAdmin && <CompanyGrant name={name} busy={busy} grant={grant} />}
   {data.members.length === 0 ? <p>No project people were returned.</p> : <DataTable caption="Project people" rows={data.members} rowKey={member => member.developerId} columns={[{key:"name",title:"Person",render:member=><VisibleText text={member.name} />},{key:"role",title:"Project role",render:member=>projectRoleLabel[member.role]},{key:"source",title:"Access source",render:member=>member.source === "grant" ? "Project grant" : "Company role"},...(allowed ? [{key:"actions",title:"Actions",render:(member:typeof data.members[number])=>member.source === "grant" && member.role === "contributor" ? <button className="rv-button rv-button-danger" type="button" disabled={busy !== undefined} onClick={() => { void remove(member.developerId); }}>{busy === member.developerId ? "Removing access…" : `Remove access for ${member.name}`}</button> : "No action"}] : [])]} />}
  </>}</ReadState></section>;
}
