// Guided onboarding PR 13 (design section 4 "Notices when something breaks later"): GitHub or Slack removed, or Linear refusing Rovara's token, used to surface
// only as failed tasks. Now company owners and admins see one banner on every page and a card on Home, each pointing to Company settings, Connections. Read from
// the same real-state reads the Connections page uses (Code's GitHub health from #832, the company's Slack workspace, the Linear connection); nothing is stored.
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useOnboardingApi } from "../../api/onboarding.js";
import { useIntegrationsApi } from "../../api/integrations.js";
import { VisibleText } from "../../design/VisibleText.js";
import "./connect.css";

export const CONNECTIONS_PATH = "/app/admin/connections";
/** One broken integration, in the app's own words (account names are shown as quoted text). */
export interface BrokenIntegration { key: string; words: string }

/** The company's broken integrations, for a company owner or admin (nothing is asked for anyone else). */
export function useBrokenIntegrations(admin: boolean): BrokenIntegration[] {
 const onboarding = useOnboardingApi(), integrations = useIntegrationsApi();
 const options = { enabled: admin, retry: false, staleTime: 60_000 } as const;
 const github = useQuery({ queryKey: ["github", "connections"], queryFn: onboarding.githubConnections, ...options });
 const slack = useQuery({ queryKey: ["slack", "workspace"], queryFn: integrations.slackStatus, ...options });
 const linear = useQuery({ queryKey: ["linear", "status"], queryFn: integrations.linearStatus, ...options });
 if (!admin) return [];
 const broken: BrokenIntegration[] = [];
 for (const item of github.data?.installations ?? []) {
  if (item.status === "suspended") broken.push({ key: `github-${String(item.installationId)}`, words: `GitHub suspended the Rovara app on ${item.accountLogin}. Tasks can't reach its repos until it's reconnected.` });
  if (item.status === "uninstalled") broken.push({ key: `github-${String(item.installationId)}`, words: `GitHub disconnected: the Rovara app was removed from ${item.accountLogin}. Reconnect it so tasks can reach its repos.` });
 }
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
