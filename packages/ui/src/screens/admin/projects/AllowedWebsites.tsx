import { useEffect, useRef, useState } from "react";
import { AppMeResponseReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../../host.js";
import { AllowedWebsitesEditor } from "./AllowedWebsitesEditor.js";

type Props = { orgId: string; project: string; available: boolean };
export function AllowedWebsites(props: Props) {
 return props.available ? <ScopedAllowedWebsites key={`${props.orgId}:${props.project}`} {...props} /> : null;
}
function ScopedAllowedWebsites({ orgId, project }: Props) {
 const host = useAppHost(), [open, setOpen] = useState(false), [identity, setIdentity] = useState<string>(), [phase, setPhase] = useState<"checking" | "ready" | "failed">("checking");
 const trigger = useRef<HTMLButtonElement>(null);
 useEffect(() => {
  if (!open) return;
  let alive = true, generation = 0;
  async function check() {
   const current = ++generation;setPhase("checking");setIdentity(undefined);
   let timer: ReturnType<typeof setTimeout> | undefined;
   try {
    const response = await Promise.race([host.transport.request({ method: "GET", path: "/v1/app/me", retry: "never" }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Identity deadline")), 30000); })]);
    if (!alive || current !== generation) return;
    if (response.status !== 200) throw new Error("Identity unavailable");
    const value = AppMeResponseReaderSchema.parse(response.body);
    if (value.org.orgId !== orgId || !["owner", "admin", "member"].includes(value.developer.orgRole)) throw new Error("Identity changed");
    setIdentity(value.developer.id);setPhase("ready");
   } catch { if (alive && current === generation) { setIdentity(undefined);setPhase("failed"); } }
   finally { clearTimeout(timer); }
  }
  const focus = () => { void check(); }, visibility = () => { if (document.visibilityState === "visible") void check(); };
  void check();window.addEventListener("focus", focus);document.addEventListener("visibilitychange", visibility);
  return () => { alive = false;generation += 1;window.removeEventListener("focus", focus);document.removeEventListener("visibilitychange", visibility); };
 }, [host, open, orgId]);
 if (host.kind !== "web") return null;
 return <div>
  <button ref={trigger} className="rv-button rv-button-secondary" type="button" onClick={() => setOpen(value => !value)}>{open ? "Close website editor" : "Edit allowed websites"}</button>
  {open && phase === "checking" && <p role="status">Checking current website editing access.</p>}
  {open && phase === "failed" && <p role="alert">Website editing access could not be verified. Close the editor and check your project access before opening it again.</p>}
  {open && phase === "ready" && identity && <AllowedWebsitesEditor key={`${orgId}:${identity}:${project}`} orgId={orgId} developerId={identity} project={project} enabled />}
 </div>;
}
