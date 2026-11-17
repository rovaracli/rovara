// Guided onboarding PR 13 (design section 4 "Notices when something breaks later"): GitHub or Slack removed, or Linear refusing Rovara's token, used to surface
// only as failed tasks. Now company owners and admins see one banner on every page and a card on Home, each pointing to Company settings, Connections. Read from
// the same real-state reads the Connections page uses (Code's GitHub health from #832, the company's Slack workspace, the Linear connection); nothing is stored. DEC 254zc(1): and a
// repository GitHub says moved to another owner or left the app's list, read from each project's checklist (Code's repos row `access`).
import { Link } from "react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useOnboardingApi } from "../../api/onboarding.js";
import { useIntegrationsApi } from "../../api/integrations.js";
import { setupChecklistKey, useSetupChecklistApi } from "../../api/setup-checklist.js";
import { useNav } from "../account/use-nav.js";
import { VisibleText } from "../../design/VisibleText.js";
import "./connect.css";

export const CONNECTIONS_PATH = "/app/admin/connections";
/** One broken integration, in the app's own words (account names are shown as quoted text). */
export interface BrokenIntegration { key: string; words: string }

/** How many of the company's projects are asked about their repositories (each asks once, then every minute at most). */
export const REPO_NOTICE_PROJECTS = 20;
/**
 * DEC 254zc(1): the one fixed line for a repository GitHub says is gone from a project's reach, by Code's access word (from its signed webhooks: moved to another owner, or taken off the
 * Rovara app's repository list). The repository and project names are shown as quoted text; nothing else from Code is used.
 */
export const REPO_MOVED_WORDS = Object.freeze({
 transferred: (repository: string, project: string) => `${repository} in ${project} was moved to another GitHub owner. Tasks can't reach it until the project points at its new address.`,
 removed: (repository: string, project: string) => `${repository} in ${project} is no longer shared with the Rovara app on GitHub. Tasks can't reach it until it's added back.`,
});

/** The company's broken integrations, for a company owner or admin (nothing is asked for anyone else). */
export function useBrokenIntegrations(admin: boolean): BrokenIntegration[] {
 const onboarding = useOnboardingApi(), integrations = useIntegrationsApi();
 const options = { enabled: admin, retry: false, staleTime: 60_000 } as const;
 const github = useQuery({ queryKey: ["github", "connections"], queryFn: onboarding.githubConnections, ...options });
 const slack = useQuery({ queryKey: ["slack", "workspace"], queryFn: integrations.slackStatus, ...options });
 const linear = useQuery({ queryKey: ["linear", "status"], queryFn: integrations.linearStatus, ...options });
 const nav = useNav(), checklist = useSetupChecklistApi();
 const projects = admin ? (nav?.projects ?? []).slice(0, REPO_NOTICE_PROJECTS).map(project => project.name) : [];
 const repositories = useQueries({ queries: projects.map(project => ({ queryKey: setupChecklistKey(project), queryFn: () => checklist.status(project), ...options, enabled: admin })) });
 if (!admin) return [];
 const broken: BrokenIntegration[] = [];
 for (const item of github.data?.installations ?? []) {
  if (item.status === "suspended") broken.push({ key: `github-${String(item.installationId)}`, words: `GitHub suspended the Rovara app on ${item.accountLogin}. Tasks can't reach its repos until it's reconnected.` });
  if (item.status === "uninstalled") broken.push({ key: `github-${String(item.installationId)}`, words: `GitHub disconnected: the Rovara app was removed from ${item.accountLogin}. Reconnect it so tasks can reach its repos.` });
 }
 projects.forEach((project, index) => {
  for (const item of repositories[index]?.data?.repos.items ?? []) {
   if (item.access === undefined) continue;
   const repository = item.fullName ?? item.name;
   broken.push({ key: `repo-${project}-${repository}`, words: REPO_MOVED_WORDS[item.access](repository, project) });
  }
 });
 const ws = slack.data?.workspace ?? undefined;
 if (ws !== undefined && ws.state === "disconnected") broken.push({ key: "slack", words: `Rovara was removed from ${ws.teamName ?? "your Slack workspace"}. Add it to Slack again to reconnect.` });
 if (linear.data?.status === "needs_reconnect") broken.push({ key: "linear", words: `Linear refused Rovara's token${linear.data.workspace === undefined ? "" : ` for ${linear.data.workspace.name}`}. Reconnect Linear.` });
 return broken;
}

/** The banner on every page (company owners and admins only). */
export function IntegrationBanner({ admin }: { admin: boolean }) {
 const broken = useBrokenIntegrations(admin);
 if (broken.length === 0) return null;
 return <aside className="rv-integration-banner" role="status" aria-label="Connections need attention" data-testid="integration-banner">
  <p><strong>{broken.length === 1 ? "A connection needs attention." : `${String(broken.length)} connections need attention.`}</strong> <VisibleText text={broken[0]!.words} /> <Link to={CONNECTIONS_PATH}>Company settings, Connections</Link></p>
 </aside>;
}

/** The Home card: every broken integration, each with the way out. */
export function IntegrationNoticeCards({ admin }: { admin: boolean }) {
 const broken = useBrokenIntegrations(admin);
 if (broken.length === 0) return null;
 return <ol className="rv-attention-list" aria-label="Connections that need attention">{broken.map(item => <li key={item.key} className="rv-attention-row" data-testid="integration-notice"><article><div className="rv-attention-content">
  <h2>Connection needs attention</h2><p className="rv-attention-reason"><VisibleText text={item.words} /></p>
 </div><div className="rv-attention-actions"><Link className="rv-attention-open" to={CONNECTIONS_PATH}>Open Connections</Link></div></article></li>)}</ol>;
}
