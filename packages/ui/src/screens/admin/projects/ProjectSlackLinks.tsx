import { useEffect, useState } from "react";
import { AppMeResponseReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../../host.js";
import { SlackLinksEditor } from "./SlackLinksEditor.js";
type Props = { orgId: string; project: string; available: boolean };
export function ProjectSlackLinks(props: Props) { return props.available ? <ScopedSlackLinks key={`${props.orgId}:${props.project}`} {...props} /> : null; }
function ScopedSlackLinks({ orgId, project }: Props) {
 const host = useAppHost(), [open, setOpen] = useState(false), [identity, setIdentity] = useState<string>(), [phase, setPhase] = useState<"checking" | "ready" | "failed">("checking");
 useEffect(() => {
  if (!open) return;let alive = true, generation = 0;
  async function check() {
   const version = ++generation;setPhase("checking");setIdentity(undefined);let timer: ReturnType<typeof setTimeout> | undefined;
   try {
    const response = await Promise.race([host.transport.request({ method: "GET", path: "/v1/app/me", retry: "never" }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Identity deadline")), 30000); })]);
    if (!alive || generation !== version) return;if (response.status !== 200) throw new Error("Identity unavailable");
    const value = AppMeResponseReaderSchema.parse(response.body);if (value.org.orgId !== orgId || (value.developer.orgRole !== "owner" && value.developer.orgRole !== "admin")) throw new Error("Identity changed");
    setIdentity(value.developer.id);setPhase("ready");
   } catch { if (alive && generation === version) { setIdentity(undefined);setPhase("failed"); } }
   finally { clearTimeout(timer); }
  }
  const focus = () => { void check(); }, visibility = () => { if (document.visibilityState === "visible") void check(); };
  void check();window.addEventListener("focus", focus);document.addEventListener("visibilitychange", visibility);
  return () => { alive = false;generation++;window.removeEventListener("focus", focus);document.removeEventListener("visibilitychange", visibility); };
 }, [host, open, orgId]);
 if (host.kind !== "web") return null;
 return <div>
  <button className="rv-button rv-button-secondary" type="button" onClick={() => setOpen(value => !value)}>{open ? "Close Slack links" : "Manage recorded Slack links"}</button>
  {open && phase === "checking" && <p role="status">Checking current Slack linking access.</p>}
  {open && phase === "failed" && <p role="alert">Slack linking access could not be verified. Close this section and refresh your project access before opening it again.</p>}
  {open && phase === "ready" && identity && <SlackLinksEditor key={`${orgId}:${identity}:${project}`} orgId={orgId} developerId={identity} project={project} enabled />}
 </div>;
}
