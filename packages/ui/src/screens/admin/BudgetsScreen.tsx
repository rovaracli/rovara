import { TaskStopEditor } from "./TaskStopEditor.js";
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUsdMicrodollars, type AdminBudgetSettings } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createBudgetSettingsApi } from "../../api/budget-settings.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { DataTable, type Column } from "../../design/DataTable.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { useAdminContext } from "./AdminLayout.js";
type Row = { label: string; limit: AdminBudgetSettings["orgMonthly"] };
const columns: readonly Column<Row>[] = [
 { key: "scope", title: "Monthly base", render: row => row.label },
 { key: "amount", title: "Amount (USD)", render: row => row.limit.kind === "unlimited" ? "Unlimited (not configured)" : formatUsdMicrodollars(row.limit.microdollars) },
 { key: "source", title: "Source", render: row => row.limit.source === "configured" ? "Set by company" : row.limit.source === "cloud_default" ? "Existing cloud default" : "Not configured" },
];
export function BudgetsScreen() {
 const { orgId, developerId, role } = useAdminContext();
 if (role !== "owner" && role !== "admin") return <section><PageHeader focusOnMount title="Spending" /><p role="alert">Only current company owners and admins can view these budgets. No amounts are shown.</p></section>;
 return <div key={`${orgId}:${developerId}:${role}`}><MonthlyBase orgId={orgId} developerId={developerId} role={role} /><TaskStopEditor /></div>;
}
function MonthlyBase({ orgId, developerId, role }: { orgId: string; developerId: string; role: "owner" | "admin" }) {
 const host = useAppHost(), query = useQueryClient(), { checking } = useAdminContext();
 const api = useMemo(() => createBudgetSettingsApi(host, orgId), [host, orgId]);
 useEffect(() => { api.setScopeActive(true);return () => { api.setScopeActive(false);const key = ["admin", "budget-settings", orgId, developerId, role];void query.cancelQueries({ queryKey: key });query.removeQueries({ queryKey: key }); }; }, [api, orgId, developerId, role, query]);
 const read = useQuery({ queryKey: ["admin", "budget-settings", orgId, developerId, role], queryFn: () => api.get(), enabled: budgetQuery => !checking && budgetQuery.state.status !== "error", retry: false, staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false });
 const locked = checking || read.isFetching;
 const error = read.error instanceof ApiError && read.error.status === 403 ? "Only current company owners and admins can view these budgets. No amounts are shown." : read.error instanceof ApiError && read.error.status === 429 ? "Too many budget checks. Wait a minute before retrying. No current amounts are shown." : "Couldn't check monthly base budgets. No current amounts are shown. Try again; an installation administrator may need to check the settings.";
 return <section aria-busy={locked}>
  <PageHeader focusOnMount title="Spending" description="Monthly base budget settings and task stop policies." actions={<Button aria-disabled={locked} onClick={() => { if (!locked) void read.refetch(); }}>Refresh budgets</Button>} />
  <p className="rv-admin-note">{"Monthly base budgets are read only. Task stops can be reviewed and changed below."}</p>
  <p className="rv-admin-note">Usage, top-ups and enforcement are not checked by the monthly table. A monthly base is separate from a task stop.</p>
  {checking && <p role="status">Checking company access...</p>}{read.isFetching && read.data !== undefined && <p role="status">Checking monthly base budgets...</p>}
  {read.isPending ? <Skeleton label="Loading monthly base budgets" /> : read.isError ? <p role="alert">{error}</p> : read.data !== undefined ? <>
   <DataTable caption="Monthly base budgets" columns={columns} rows={[{ label: "Company", limit: read.data.orgMonthly }, { label: "Default for a member", limit: read.data.memberDefaultMonthly }]} rowKey={row => row.label} />
   <section className="rv-admin-section"><h2>Configured member overrides</h2><p>{read.data.memberOverrideCount} configured member overrides. Current membership and individual limits are not checked here.</p></section>
   <p className="rv-muted">Checked at <time dateTime={read.data.checkedAt}>{new Date(read.data.checkedAt).toLocaleString("en-US", { timeZone: "UTC" })}</time> UTC.</p>
  </> : null}
  <section className="rv-admin-section"><h2>What this page does not check</h2><p>Monthly top-ups can change this month's allowance. The monthly table does not show usage, remaining funds, or project and agent monthly budgets. Task stop settings can be reviewed separately below. This page does not determine whether a task can start.</p></section>
 </section>;
}
