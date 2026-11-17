// Guided onboarding PR 11 (DEC 254k): Project settings, Slack channel and Linear team: add, change or remove at any time. Slack's or Linear's return to this
// page (`slack=` / `linear=`, one fixed word) shows its outcome here.
import { useSearchParams } from "react-router";
import { SlackChannelRow } from "./SlackChannelRow.js";
import { LinearTeamRow } from "./LinearTeamRow.js";
import { SlackConnectResult } from "./SlackConnect.js";
import { LinearConnectResult } from "./LinearConnect.js";

export function ProjectIntegrations({ project, canEdit }: { project: string; canEdit: boolean }) {
 const [params] = useSearchParams();
 return <section className="rv-connect-settings" aria-label="Slack and Linear" data-testid="project-integrations">
  <h2>Slack and Linear</h2>
  <p>Both are optional. Change or remove them any time.</p>
  <SlackConnectResult outcome={params.get("slack") ?? ""} />
  <LinearConnectResult outcome={params.get("linear") ?? ""} />
  <SlackChannelRow project={project} mode="settings" canEdit={canEdit} />
  <LinearTeamRow project={project} mode="settings" canEdit={canEdit} />
 </section>;
}
