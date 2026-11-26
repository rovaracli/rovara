import { GithubConnectionsResponseReaderSchema, SlackWorkspaceResponseReaderSchema } from "@agentx/contracts/web";
import { methodName } from "../../api/sign-ins.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Row, RowBody, Rows, Section, Unknown, VisibleText, localClock } from "./parts.js";
import { ReadState } from "./ReadState.js";
import { useReadIdentity, useScopedRead } from "./read-model.js";
import { ReconnectingLine } from "./reconnecting.js";

const STEPS = ["Connect GitHub", "Connect Slack", "Who pays for AI", "First project: pick repos", "Start setup"] as const;
const ROLE = { owner: "its owner", admin: "an admin", member: "a member" } as Record<string, string>;
/** `actions`: the live setup steps stand right below this summary (the onboard page), so it says they make the changes instead of saying nothing can be edited. */
export function CompanySetupProgressRead({ actions = false }: { actions?: boolean } = {}) {
 const me = useReadIdentity();
 const github = useScopedRead("/v1/app/github/connections", GithubConnectionsResponseReaderSchema);
 const slack = useScopedRead("/v1/app/slack", SlackWorkspaceResponseReaderSchema);
 const via = me.identities[0], who = via?.login ?? via?.email;
 return <>
  <PageHeader title="Company setup progress" breadcrumbs={[{ label: "Company setup" }]} description="This part happens once. Next is the project checklist for your first project." />
  <ReconnectingLine />
  <div className="g5-main g5-stack">
   <div className="g5-checklist-phone"><Section title="Project checklist" note="first project"><Rows label="Project checklist steps">{STEPS.map((step, index) => <Row key={step} lead={<span className="g5-dot" aria-hidden="true">{index + 1}</span>} title={step} />)}</Rows></Section></div>
   <section className="g5-card" aria-labelledby="g5-company-setup"><h2 id="g5-company-setup"><VisibleText text={me.org.name} /> setup <Unknown /></h2>
    <Rows label="Observed connections">
     <Row mark="ok" title="Your account" detail={<>{me.developer.email === undefined ? "Signed in" : <VisibleText text={me.developer.email} />}{via === undefined ? "" : <>, signed in with {methodName(via.provider)}{who === undefined ? "" : <> as <VisibleText text={who} /></>}</>}. Changed in Account.</>} />
     <Row mark="ok" title={<>Company <VisibleText text={me.org.name} /></>} detail={<>You are {ROLE[me.developer.orgRole] ?? "a member"}. The name is changed in Company, Settings.</>} />
     <ReadState query={github} label="company GitHub connections" rowLabel="Company GitHub">{data => {
      const active = data.installations.find(item => item.status === undefined || item.status === "active");
      return active !== undefined
       ? <RowBody mark="ok" title="GitHub connected" detail={<>Installed on <VisibleText text={active.accountLogin} /></>} aside={`Connected ${localClock(active.connectedAt)}`} />
       : data.installations.length === 0 ? <RowBody mark="idle" title="No GitHub connections returned" />
        : <RowBody mark="idle" title="GitHub readiness: Can't tell yet. No active connection was confirmed." />;
     }}</ReadState>
     <ReadState query={slack} label="company Slack connection" rowLabel="Company Slack">{data => data.workspace?.state === "connected"
      ? <RowBody mark="ok" title="Slack connected" detail={data.workspace.teamName === undefined ? undefined : <VisibleText text={data.workspace.teamName} />} aside={`Added ${localClock(data.workspace.connectedAt)}`} />
      : data.workspace === null ? <RowBody mark="idle" title="Slack not added (optional)" aside="Not added" /> : data.workspace.state === "unknown" ? <RowBody mark="idle" title="Slack connection status unavailable" aside="Can't tell yet" /> : <RowBody mark="attention" title="Slack connection needs attention" />}</ReadState>
    </Rows>
    <p className="g5-lede">{actions ? "Read back from Rovara. The steps below make the changes." : "Nothing here can be edited from this page."}</p>
    <div className="g5-next"><h3>Next: the project checklist</h3><p>Five steps for your first project: connect GitHub, connect Slack (optional), who pays for AI, pick repos, start setup. You can also stop here. The checklist waits in Inbox under Finish setting up.</p></div>
   </section>
  </div>
 </>;
}
