// Parts the two report pages share: the filter row (kept in the address, so a link or a reload keeps it), the four top numbers, the cost cell, and the words for a failed read.
import { useMemo, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { ORIGINS, ORIGIN_WORDS, PATHS, PATH_WORDS, RANGES, RANGE_WORDS, costWords, dollars, durationWords, filterQuery, isRange, pullRequestWords, rangeBounds, unpricedWords, type Origin, type RangeId, type ReportFilters, type ReportNumbers, type StateFilter, type TaskPath } from "../../../api/admin-report.js";
import { Button } from "../../../design/Button.js";
import { Select } from "../../../design/Select.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { isNotConnected } from "../../../api/admin-company.js";
import { AdminSection, NotConnected, Stat } from "../parts.js";

export const REPORT_HOME = "/app/admin/money/report";
/** The "no filter" choice of a menu (the menu's own empty value is its placeholder). */
const ALL = "__all__";
const STATE_OPTIONS: ReadonlyArray<{ value: StateFilter; label: string }> = [{ value: "open", label: "Open" }, { value: "merged", label: "Merged" }, { value: "closed", label: "Closed or failed" }];

/** The filters the address holds. The range is a name (this month by default); the others are the report's own words, anything else is ignored. */
export function useReportFilters(): { range: RangeId; filters: ReportFilters; apply: (next: { range?: RangeId; project?: string; origin?: string; state?: string; path?: string }) => void; query: string; carry: string } {
 const [params, setParams] = useSearchParams();
 const rangeParam = params.get("range"), range: RangeId = isRange(rangeParam) ? rangeParam : "this-month";
 const project = params.get("project") ?? undefined, origin = params.get("origin"), state = params.get("state"), path = params.get("path");
 const filters = useMemo<ReportFilters>(() => ({
  ...rangeBounds(range, new Date()), ...(project === undefined || project === "" ? {} : { project }),
  ...(origin !== null && (ORIGINS as readonly string[]).includes(origin) ? { origin: origin as Origin } : {}),
  ...(state !== null && STATE_OPTIONS.some(option => option.value === state) ? { state: state as StateFilter } : {}),
  ...(path !== null && (PATHS as readonly string[]).includes(path) ? { path: path as TaskPath } : {}),
 }), [range, project, origin, state, path]);
 const apply = (next: { range?: RangeId; project?: string; origin?: string; state?: string; path?: string }) => {
  const out = new URLSearchParams(params);
  for (const [key, value] of Object.entries(next)) { if (value === undefined || value === "" || (key !== "range" && value === ALL) || (key === "range" && value === "this-month")) out.delete(key); else out.set(key, value); }
  setParams(out, { replace: true });
 };
 // The filters as the address carries them, for a link from one page to the other.
 const carry = (() => { const out = new URLSearchParams(); for (const key of ["range", "project", "origin", "state", "path"]) { const value = params.get(key); if (value !== null && value !== "") out.set(key, value); } const text = out.toString(); return text === "" ? "" : `?${text}`; })();
 return { range, filters, apply, query: filterQuery(filters), carry };
}

/** The five filters, one row: date range, project, where it started, state, path. */
export function FilterRow({ projects, state, hideProject = false }: { projects: readonly string[]; state: ReturnType<typeof useReportFilters>; hideProject?: boolean }) {
 const { range, filters, apply } = state;
 const projectOptions = [{ value: ALL, label: "All projects" }, ...(filters.project !== undefined && !projects.includes(filters.project) ? [{ value: filters.project, label: filters.project }] : []), ...projects.map(name => ({ value: name, label: name }))];
 return <div className="rv-report-filters" role="group" aria-label="Filters">
  <Select label="Date range" value={range} onValueChange={value => apply({ range: value as RangeId })} options={RANGES.map(id => ({ value: id, label: RANGE_WORDS[id] }))} />
  {!hideProject && <Select label="Project" value={filters.project ?? ALL} onValueChange={value => apply({ project: value })} options={projectOptions} />}
  <Select label="Where it started" value={filters.origin ?? ALL} onValueChange={value => apply({ origin: value })} options={[{ value: ALL, label: "Anywhere" }, ...ORIGINS.map(id => ({ value: id, label: ORIGIN_WORDS[id] }))]} />
  <Select label="State" value={filters.state ?? ALL} onValueChange={value => apply({ state: value })} options={[{ value: ALL, label: "Any state" }, ...STATE_OPTIONS]} />
  <Select label="Path" value={filters.path ?? ALL} onValueChange={value => apply({ path: value })} options={[{ value: ALL, label: "Any path" }, ...PATHS.map(id => ({ value: id, label: PATH_WORDS[id] }))]} />
 </div>;
}

/** The four numbers at the top: spent, merged pull requests, cost per merged pull request, median time from request to pull request. A number that does not exist is said so, never drawn as zero. */
export function TopNumbers({ totals, label }: { totals: ReportNumbers; label: string }) {
 return <div className="rv-stats" role="group" aria-label={label}>
  <Stat label="Spent" note={totals.unpricedCalls > 0 ? unpricedWords(totals.unpricedCalls) + ", so the real total is higher" : undefined}>{costWords(totals.costCents, totals.costIsFloor)}</Stat>
  <Stat label="Merged pull requests" note={`of ${totals.prsOpened} opened`}>{totals.prsMerged}</Stat>
  <Stat label="Cost per merged pull request" note={totals.costPerMergedCents === undefined ? "Nothing has merged yet" : "All cost, failed work included"}>{totals.costPerMergedCents === undefined ? "No merges yet" : dollars(totals.costPerMergedCents)}</Stat>
  <Stat label="Median time from request to pull request" note={totals.medianRequestToPrMs === undefined ? "No pull request opened yet" : undefined}>{totals.medianRequestToPrMs === undefined ? "None yet" : durationWords(totals.medianRequestToPrMs)}</Stat>
 </div>;
}

export function CostCell({ cents, floor, unpriced }: { cents: number; floor: boolean; unpriced: number }) {
 return <span className="rv-num">{costWords(cents, floor)}{unpriced > 0 && <span className="rv-report-note">{unpricedWords(unpriced)}</span>}</span>;
}
export const PullRequestCell = ({ merged, opened }: { merged: number; opened: number }) => <span className="rv-num">{pullRequestWords(merged, opened)}</span>;
export function EndCell({ ms, soFar }: { ms: number | undefined; soFar: boolean | undefined }) {
 return ms === undefined ? <span className="rv-muted">Not known</span> : <span className="rv-num">{durationWords(ms)}{soFar === true && <span className="rv-report-note">so far</span>}</span>;
}

export const RANGE_NOTE = "A task counts in the range it started in, with all of its cost. The Spending page counts by calendar month, so the two can differ.";

/** The page's body while it has nothing to draw: loading, not connected, refused or failed. Undefined once there is data. */
export function ReadState({ read, what, title }: { read: UseQueryResult<unknown>; what: string; title: string }): ReactNode {
 if (read.isPending) return <Skeleton label={`Loading ${what}`} />;
 if (read.data !== undefined) return undefined;
 const error = read.error;
 if (isNotConnected(error)) return <AdminSection title={title}><NotConnected what="The cost report">Cost and time shows here when it is.</NotConnected></AdminSection>;
 const forbidden = error instanceof ApiError && error.status === 403;
 const tooLarge = error instanceof ApiError && error.code === "RANGE_TOO_LARGE";
 return <AdminSection title={title}><div role="alert" className="rv-banner rv-banner-danger" data-testid="report-error"><span><b>{forbidden ? "You don't have permission to view the cost report." : tooLarge ? "That range has too many tasks to add up." : `Couldn't load ${what}.`}</b> {tooLarge ? "Choose a shorter date range." : "No amounts are shown."}</span>{!forbidden && <Button disabled={read.isFetching} onClick={() => { void read.refetch(); }}>Try again</Button>}</div></AdminSection>;
}
