// People and limits (cost report slice A6, decision D2): each member's spend this month against their monthly limit. Company owners and admins only (the server
// refuses everyone else; a member never sees the link). One table of five columns, in NAME order as the server sent it: no sorting, no totals row, no chart, and
// nothing about how much a person got done. A person's number is their whole month across every project: the project filter narrows who is listed.
// Changing a limit is B1's page (Spending limits); this page only links to it.
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { changeLimitPath, peopleLimitsPath, readPeopleLimits, standing, type LimitStanding, type PeopleLimitsRead, type PersonLimitRow } from "../../../api/admin-people-limits.js";
import { isNotConnected } from "../../../api/admin-company.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { DataTable, type Column } from "../../../design/DataTable.js";
import { Money } from "../../../design/Money.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Select } from "../../../design/Select.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import { AdminSection, NotConnected } from "../parts.js";

const ALL = "";
const monthName = (month: string) => new Date(Date.parse(`${month}-01T00:00:00Z`)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const STANDING_WORDS: Record<LimitStanding, string> = { none: "No limit", within: "Within the limit", close: "Close to the limit", over: "Over the limit" };
const dollars = (cents: number) => cents / 100;

const columns: readonly Column<PersonLimitRow>[] = [
 { key: "person", title: "Person", render: row => <b><VisibleText text={row.name} /></b> },
 { key: "spent", title: "Spent this month (all projects)", render: row => <span className="rv-num"><Money usd={dollars(row.spentCents)} /></span> },
 { key: "limit", title: "Monthly limit", render: row => row.limitCents === null ? <span className="rv-muted">No limit set</span> : <><span className="rv-num"><Money usd={dollars(row.limitCents)} /></span><span className="rv-muted"> {row.limitSource === "own" ? "set for this person" : "company default"}</span></> },
 { key: "standing", title: "Standing", render: row => { const state = standing(row); return state === "over" ? <span className="rv-spend-flag" data-tone="bad">{STANDING_WORDS[state]}</span> : state === "close" ? <span className="rv-spend-flag">{STANDING_WORDS[state]}</span> : <span className="rv-muted">{STANDING_WORDS[state]}</span>; } },
 { key: "change", title: "Change", render: row => <Link to={changeLimitPath(row.developerId)} aria-label={`Change the limit for ${row.name}`}>Change limit</Link> },
];

/** The read, scoped to the signed-in person, company and role (dropped when access is lost) and to the project in force. */
function usePeopleLimitsRead(project: string | undefined) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient(), { orgId, developerId, role } = useAdminContext();
 useEffect(() => () => { const key = ["admin", "lane-c", "people-limits", orgId, developerId, role]; void query.cancelQueries({ queryKey: key }); query.removeQueries({ queryKey: key }); }, [query, orgId, developerId, role]);
 return useQuery({ queryKey: ["admin", "lane-c", "people-limits", orgId, developerId, role, project ?? ALL], queryFn: () => api.get(peopleLimitsPath(project), { parse: readPeopleLimits }), gcTime: 0, placeholderData: keepPreviousData, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false });
}

export function PeopleLimitsScreen() {
 const { orgId, developerId, role } = useAdminContext();
 if (role !== "owner" && role !== "admin") return <section><PageHeader focusOnMount title="People and limits" /><p role="alert">Only company owners and admins can see people's spending. No amounts are shown.</p></section>;
 return <PeopleLimits key={`${orgId}:${developerId}:${role}`} />;
}

function PeopleLimits() {
 const [project, setProject] = useState<string | undefined>();
 const read = usePeopleLimitsRead(project);
 const notConnected = read.isError && isNotConnected(read.error);
 return <section aria-busy={read.isFetching}>
  <PageHeader focusOnMount title="People and limits" description="Each person's spending this month against their monthly limit. Only company owners and admins see this page." />
  {notConnected ? <AdminSection title="This month"><NotConnected what="People and limits" /></AdminSection>
   : read.isPending ? <Skeleton label="Loading people and limits" />
   : read.data === undefined ? <ReadFailed forbidden={read.error instanceof ApiError && read.error.status === 403} busy={read.isFetching} retry={() => { void read.refetch(); }} />
   : <Loaded data={read.data} project={project} setProject={setProject} stale={read.isError} />}
 </section>;
}

function ReadFailed({ forbidden, busy, retry }: { forbidden: boolean; busy: boolean; retry: () => void }) {
 return <AdminSection title="This month"><div role="alert" className="rv-banner rv-banner-danger" data-testid="people-limits-error"><span><b>{forbidden ? "You don't have permission to see people's spending." : "Couldn't load people's spending. Spending unavailable."}</b> No amounts are shown.</span>{!forbidden && <Button disabled={busy} onClick={retry}>Try again</Button>}</div></AdminSection>;
}

function Loaded({ data, project, setProject, stale }: { data: PeopleLimitsRead; project: string | undefined; setProject: (name: string | undefined) => void; stale: boolean }) {
 const month = monthName(data.month);
 return <>
  {stale && <p role="alert" className="rv-muted">These numbers are stale: the last refresh failed.</p>}
  {data.projects.length > 0 && <div className="rv-people-limits-filter"><Select label="Show people on" value={project ?? ALL} onValueChange={value => { setProject(value === ALL ? undefined : value); }} placeholder="All people" options={[{ value: ALL, label: "All people" }, ...data.projects.map(name => ({ value: name, label: name }))]} /></div>}
  <AdminSection title={`Spending in ${month}`} note="Whole company, by name (UTC billing month)">
   {data.people.length === 0
    ? <p className="rv-muted" data-testid="people-limits-empty">{data.project === undefined ? "No one is in the company yet." : "No one is on this project."}</p>
    : <DataTable caption="People and limits" columns={columns} rows={data.people} rowKey={row => row.developerId} />}
   <p className="rv-muted">Company-wide spend: each amount is the person's spending across every project this month{data.project === undefined ? "" : <>, not only <VisibleText text={data.project} /></>}. Only finished calls are counted: money set aside for work still running is not in these amounts. The limit is their own if one was set, otherwise the company default. Names are in alphabetical order.</p>
   <p className="rv-muted"><Link to="/app/admin/money/limits">Set or change a limit on the Spending limits page.</Link></p>
  </AdminSection>
 </>;
}
