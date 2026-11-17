// Guided onboarding PR 9 (design section 1): once the company part is done it collapses to one line ("Company: GitHub connected, Slack connected") with a link
// to Company settings, Connections. Read from the same real-state reads the company steps use (GitHub connections, the company's Slack workspace).
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useOnboardingApi } from "../../api/onboarding.js";
import { useIntegrationsApi } from "../../api/integrations.js";

export function CompanySetupLine() {
 const onboarding = useOnboardingApi(), integrations = useIntegrationsApi();
 const github = useQuery({ queryKey: ["github", "connections"], queryFn: onboarding.githubConnections, retry: false });
 const slack = useQuery({ queryKey: ["slack", "status"], queryFn: integrations.slackStatus, retry: false });
 const githubWords = github.isPending ? "GitHub checking" : github.isError ? "GitHub unknown" : github.data.installations.length > 0 ? "GitHub connected" : "GitHub not connected";
 const slackWords = slack.isPending ? "Slack checking" : slack.isError ? "Slack unknown" : slack.data.workspace?.state === "connected" ? "Slack connected" : "Slack not added (optional)";
 return <p className="rv-checklist-company" data-testid="checklist-company">Company: {githubWords}, {slackWords}. <Link to="/app/admin/connections">Company settings, Connections</Link></p>;
}
