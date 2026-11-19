import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ProjectMembersResponseSchema } from "@agentx/contracts/web";
import { ApiError } from "../../../api/errors.js";
import { createApiClient } from "../../../api/client.js";
import { useAppHost } from "../../../host.js";
import { DataTable } from "../../../design/DataTable.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import { projectRoleLabel } from "./labels.js";
import { ReadState, useAdminRead } from "./read.js";

const peopleReader = { parse(value: unknown) { return { members: ProjectMembersResponseSchema.parse(value).members.map(person => ({ developerId: person.developerId, name: person.name, role: person.role, source: person.source })) }; } };
const grantReader = { parse(value: unknown) { const parsed = value as { member?: { developerId?: unknown; role?: unknown } }; if (typeof parsed?.member?.developerId !== "string" || parsed.member.role !== "contributor") throw new Error("invalid grant response"); return parsed.member; } };
const removeReader = { parse(value: unknown) { const parsed = value as { developerId?: unknown; removed?: unknown }; if (typeof parsed?.developerId !== "string" || typeof parsed.removed !== "boolean") throw new Error("invalid removal response"); return parsed; } };

function refusal(error: unknown) {
 if (error instanceof ApiError && error.status === 403) return "You don't have permission to change access for this project.";
 if (error instanceof ApiError && error.status === 404) return "This project or person isn't available in your company.";
 return "Access could not be changed. Refresh the project people list and try again.";
}

export function ProjectPeople({ name }: { name: string }) {
 const context = useAdminContext(), host = useAppHost(), query = useQueryClient(), api = useMemo(() => createApiClient(host), [host]);
 const read = useAdminRead("project-members", name, `/v1/app/projects/${encodeURIComponent(name)}/members`, peopleReader);
 const [person, setPerson] = useState(""), [busy, setBusy] = useState<string>(), [feedback, setFeedback] = useState<{ kind: "status" | "alert"; text: string }>();
 const allowed = host.kind === "web" && !context.checking && (context.role === "owner" || context.role === "admin");
 const path = (who: string) => `/v1/app/projects/${encodeURIComponent(name)}/members/${encodeURIComponent(who)}`;
 async function grant(event: FormEvent) {
  event.preventDefault();
  const target = person.trim();
  if (!allowed || target === "" || busy !== undefined) return;
  setBusy("grant"); setFeedback(undefined);
  try {
   await api.sendAnswer("PUT", path(target), {}, grantReader, { retry: "never" });
   setPerson(""); setFeedback({ kind: "status", text: "Access granted." });
   await Promise.all([query.invalidateQueries({ queryKey: ["admin", "project-members", context.orgId, context.developerId, name] }), query.invalidateQueries({ queryKey: ["nav"] })]);
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
   await Promise.all([query.invalidateQueries({ queryKey: ["admin", "project-members", context.orgId, context.developerId, name] }), query.invalidateQueries({ queryKey: ["nav"] })]);
  } catch (error) { setFeedback({ kind: "alert", text: refusal(error) }); }
  finally { setBusy(undefined); }
 }
 return <section aria-labelledby={`project-people-${name}`}><h2 id={`project-people-${name}`}>Project people</h2><p>Company owners and admins can grant or remove project access. People listed here have a direct project grant.</p><ReadState read={read} label="project people">{data => <>
   {allowed && <form onSubmit={event => { void grant(event); }}><label htmlFor={`project-person-${name}`}>Person's email or developer ID</label><input id={`project-person-${name}`} className="rv-input" autoComplete="off" value={person} onChange={event => setPerson(event.target.value)} /><button className="rv-button rv-button-primary" type="submit" disabled={busy !== undefined || person.trim() === ""}>{busy === "grant" ? "Granting access…" : "Grant access"}</button></form>}
   {feedback && <p role={feedback.kind === "alert" ? "alert" : "status"}>{feedback.text}</p>}
   {data.members.length === 0 ? <p>No project people were returned.</p> : <DataTable caption="Project people" rows={data.members} rowKey={member => member.developerId} columns={[{key:"name",title:"Person",render:member=><VisibleText text={member.name} />},{key:"role",title:"Project role",render:member=>projectRoleLabel[member.role]},{key:"source",title:"Access source",render:member=>member.source === "grant" ? "Project grant" : "Company role"},...(allowed ? [{key:"actions",title:"Actions",render:(member:typeof data.members[number])=>member.source === "grant" && member.role === "contributor" ? <button className="rv-button rv-button-danger" type="button" disabled={busy !== undefined} onClick={() => { void remove(member.developerId); }}>{busy === member.developerId ? "Removing access…" : `Remove access for ${member.name}`}</button> : "No action"}] : [])]} />}
  </>}</ReadState></section>;
}
