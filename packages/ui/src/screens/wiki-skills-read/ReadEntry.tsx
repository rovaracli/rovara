import { useState, useSyncExternalStore, type ReactNode } from "react";
import { servedReadState } from "../../api/served-read.js";
import { useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ProjectOverviewProjectSchema } from "@agentx/contracts/web";
import { Scope, useDenial, useIdentity } from "./read-model.js";
import { ReadState, ReadSurfaceContext } from "./ReadState.js";
import { HoldContext, createHold, useRefreshScope } from "./hold.js";
import { WikiRefreshAlso } from "../../api/wiki.js";
import { AccessEnded, AccessFrameContext, Header, Notice, readClock } from "./parts.js";
import { WikiIndexReadScreen } from "./WikiIndexReadScreen.js";
import { SkillsReadScreen } from "./SkillsReadScreen.js";
import { WikiSetupReadPanel } from "./WikiSetupReadPanel.js";
import { ProjectAnswerReadPanel } from "./ProjectAnswerReadPanel.js";
import "./wiki-skills-read.css";
/** After a write on any page the pages of this scope are read again, with the page held open meanwhile. */
function RefreshProvider({ scopeKey, children }: { scopeKey: readonly (string | number)[]; children: ReactNode }) {
 const refresh = useRefreshScope(scopeKey);
 return <WikiRefreshAlso.Provider value={refresh}>{children}</WikiRefreshAlso.Provider>;
}
function ScopedEntry({ scopeKey, project, slot, readAt }: { scopeKey: readonly (string | number)[]; project: string; slot: "project" | "setup" | "answer"; readAt?: string | undefined }) {
 const denial = useDenial(scopeKey), [params] = useSearchParams(), client = useQueryClient(), [hold] = useState(createHold);
 // Load again forgets the refusal; the reads then run again and a restored grant shows the page.
 if (denial.data !== null) return <AccessEnded onRetry={() => { client.setQueryData([...scopeKey, "denied"], null); }} />;
 return <HoldContext.Provider value={hold}><Scope.Provider value={{ key: scopeKey, project }}><RefreshProvider scopeKey={scopeKey}>
 {slot === "setup" ? <WikiSetupReadPanel /> : slot === "answer" ? <ProjectAnswerReadPanel readAt={readAt} /> : params.get("tab") === "wiki" ? <WikiIndexReadScreen /> : params.get("tab") === "skills" ? <SkillsReadScreen /> : <Notice>Choose Wiki or Skills in the project.</Notice>}
 </RefreshProvider></Scope.Provider></HoldContext.Provider>;
}
/** WIRING supplies existing project/setup/home slots; this adds no production route. */
export function WikiSkillsReadEntry({ project: supplied, slot = "project" }: { project?: string; slot?: "project" | "setup" | "answer" }) {
 const params = useParams(), [query] = useSearchParams(), project = supplied ?? params["name"] ?? "", identity = useIdentity();
 const client = useQueryClient(), cache = client.getQueryCache();
 const me = servedReadState(identity.read).data;
 const scopeKey = me === undefined ? undefined : ["g3", identity.token, me.org.orgId, me.developer.id, project];
 // Resource failures own the timestamp; only an identity-only failure uses identity's last success.
 const staleSince = useSyncExternalStore(notify => cache.subscribe(notify), () => {
  const times = scopeKey === undefined ? [] : cache.findAll({ queryKey: scopeKey, type: "active" }).flatMap(query => {
   if (query.queryKey.at(-1) === "denied") return [];
   const state = query.state;
   const shown = servedReadState({ data: state.data, dataUpdatedAt: state.dataUpdatedAt, isError: state.status === "error", error: state.error, failureCount: state.fetchFailureCount, failureReason: state.fetchFailureReason });
   return shown.staleSince === undefined ? [] : [shown.staleSince];
  });
  return times.length > 0 ? Math.min(...times) : servedReadState(identity.read).staleSince;
 }, () => undefined);
 const valid = ProjectOverviewProjectSchema.shape.name.safeParse(project);
 if (!valid.success) return <div className="rv-wiki-skills-read"><p role="alert">Project unavailable.</p></div>;
 const frame = { project, pill: slot === "project" && query.get("tab") === "skills" ? "Skills" as const : "Wiki" as const };
 return <div className="rv-wiki-skills-read"><AccessFrameContext.Provider value={frame}><ReadSurfaceContext.Provider value={{ staleSince }}><ReadState read={identity.read} code={slot === "answer" ? "WIKI-ASK-READ-FAILED" : "WIKI-IDENTITY-READ-FAILED"} {...(slot === "answer" ? { header: (confirmed: boolean) => confirmed ? null : <Header project={project} trail={["Wiki", "Ask"]} /> } : {})}>{me !== undefined && <ScopedEntry key={me.org.orgId + ":" + me.developer.id + ":" + project} scopeKey={["g3", identity.token, me.org.orgId, me.developer.id, project]} project={project} slot={slot} readAt={identity.read.dataUpdatedAt > 0 ? readClock(identity.read.dataUpdatedAt) : undefined} />}</ReadState></ReadSurfaceContext.Provider></AccessFrameContext.Provider></div>;
}
