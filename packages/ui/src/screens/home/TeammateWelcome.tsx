// Guided onboarding PR 13 (design section 4 "A teammate's first experience"): after the invite link, sign-in and their name, a short welcome on Home. The projects
// they are in, each project's Slack channel to use, and "Start a task" or "See what's running". No setup screens. A person in no project is pointed to the
// company's admins (Home's empty state says it). Shown on the first visit after joining (`?joined=1`) and to a company member, until the person dismisses it.
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { useNav } from "../account/use-nav.js";
import { setupChecklistKey, useSetupChecklistApi } from "../../api/setup-checklist.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import "../connect/connect.css";

/** How many of the person's projects the welcome names (each asks for its channel once). */
const WELCOME_PROJECTS = 5;
const seenKey = (developerId: string) => `rovara.welcome.seen.${developerId}`;

export function TeammateWelcome() {
 const host = useAppHost(), nav = useNav(), api = useSetupChecklistApi(), [params] = useSearchParams();
 const developerId = nav?.me.developerId;
 const [seen, setSeen] = useState(() => { try { return developerId !== undefined && host.storage.get(seenKey(developerId)) === "1"; } catch { return false; } });
 const projects = (nav?.projects ?? []).slice(0, WELCOME_PROJECTS).map(project => project.name);
 const reads = useQueries({ queries: projects.map(project => ({ queryKey: setupChecklistKey(project), queryFn: () => api.status(project), retry: false })) });
 if (nav === undefined || developerId === undefined) return null;
 const member = nav.me.orgRole !== "owner" && nav.me.orgRole !== "admin";
 const joined = params.get("joined") === "1";
 let storedSeen = seen;
 try { storedSeen = storedSeen || host.storage.get(seenKey(developerId)) === "1"; } catch { /* Blocked storage: shown until dismissed in this tab. */ }
 if (storedSeen || (!joined && !member)) return null;
 if (nav.projects.length === 0) return null;
 function dismiss() { setSeen(true); try { host.storage.set(seenKey(developerId!), "1"); } catch { /* Blocked storage: it shows again next time. */ } }
 return <section className="rv-welcome" aria-labelledby="rv-welcome-heading" data-testid="teammate-welcome">
  <h2 id="rv-welcome-heading">Welcome to <VisibleText text={nav.org.name} /></h2>
  <p>You're in {projects.length === 1 ? "this project" : "these projects"}. Start a task here, or in its Slack channel.</p>
  <ul className="rv-welcome-projects">{projects.map((project, index) => {
   const channels = reads[index]?.data?.slackChannel.channels ?? [];
   return <li key={project} data-testid="welcome-project">
    <p><strong><VisibleText text={project} /></strong>{channels.length > 0 && <> · Slack: <VisibleText text={channels.map(channel => channel.name === undefined ? "a linked channel" : `#${channel.name}`).join(", ")} /></>}</p>
    <div className="rv-connect-actions"><Link className="rv-button rv-button-primary" to={`/app/projects/${encodeURIComponent(project)}#start-work`}>Start a task</Link><Link className="rv-button" to="/app/live">See what's running</Link></div>
   </li>;
  })}</ul>
  <Button data-testid="welcome-dismiss" onClick={dismiss}>Got it</Button>
 </section>;
}
