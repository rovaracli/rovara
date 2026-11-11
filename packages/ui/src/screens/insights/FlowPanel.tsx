import { useState } from "react";
import { useInsightsFlow, type FlowFigures, type InsightsOverview } from "../../api/insights.js";
import { DataTable, type Column } from "../../design/DataTable.js";
import { Select } from "../../design/Select.js";
import { VisibleText } from "../../design/VisibleText.js";
import { actorKindWords, durationWords, rateWords } from "./insights-format.js";
import { BarList, NotReady, Panel, Reading } from "./parts.js";

const NOT_ENOUGH = "Not enough work yet";
const range = (value: { median: number; p90: number } | undefined, enough: boolean): string => !enough || value === undefined ? NOT_ENOUGH : `${durationWords(value.median)} (slowest tenth ${durationWords(value.p90)})`;
const rate = (value: { of: number } & Record<string, number> | undefined, key: string, enough: boolean): string => !enough || value === undefined ? NOT_ENOUGH : rateWords(value[key] ?? 0, value.of);
function Figures({ figures }: { figures: FlowFigures }) {
 const wait = figures.enough ? figures.waitByNextActor ?? [] : [];
 return <>
  <dl className="rv-ins-figures">
   <div><dt>Cycle time (first work to merged or closed), typical</dt><dd>{range(figures.cycleTimeHours, figures.enough)}</dd></div>
   <div><dt>Wait for a review, typical</dt><dd>{range(figures.reviewWaitHours, figures.enough)}</dd></div>
   <div><dt>Failed</dt><dd>{rate(figures.failureRate, "failed", figures.enough)}</dd></div>
   <div><dt>Retried</dt><dd>{rate(figures.retryRate, "retried", figures.enough)}</dd></div>
   <div><dt>Sent back</dt><dd>{rate(figures.sendBackRate, "sentBack", figures.enough)}</dd></div>
  </dl>
  {!figures.enough && <p className="rv-muted" role="status">{NOT_ENOUGH}: {String(figures.items)} {figures.items === 1 ? "item so far" : "items so far"}.</p>}
  {wait.length > 0 && <><h3>Typical wait, by who the work waited on</h3><BarList caption="Typical wait by who the work waited on" rows={wait.map(row => ({ key: row.kind, label: actorKindWords(row.kind), value: row.medianHours, text: durationWords(row.medianHours) }))} /></>}
 </>;
}
const DAY_CHOICES = [7, 30, 90] as const;
export function FlowPanel({ overview, person, project }: { overview: InsightsOverview; person: string | undefined; project: string | undefined }) {
 const panel = overview.panels.flow, now = Date.parse(overview.asOf), unavailable = panel.status === "unavailable" || panel.status === "unknown";
 const [days, setDays] = useState<7 | 30 | 90>(30);
 const read = useInsightsFlow({ person, project, days, enabled: !unavailable });
 return <Panel id="ins-flow" title="Flow health" intro="How work moves: how long it takes, where it waits, how often it fails.">
  {unavailable ? <NotReady status={panel.status} collectingSince={panel.collectingSince} now={now} /> : <>
   <Select label="Period" value={String(days)} onValueChange={value => { setDays(Number(value) as 7 | 30 | 90); }} options={DAY_CHOICES.map(count => ({ value: String(count), label: `Last ${String(count)} days` }))} />
   <Reading read={read} title="flow health">{data => {
    const columns: Column<(typeof data.byProject)[number]>[] = [
     { key: "project", title: "Project", render: row => <VisibleText text={row.project} /> },
     { key: "items", title: "Items", render: row => String(row.items) },
     { key: "cycle", title: "Cycle time, typical", render: row => row.enough && row.cycleTimeHours !== undefined ? durationWords(row.cycleTimeHours.median) : NOT_ENOUGH },
     { key: "review", title: "Review wait, typical", render: row => row.enough && row.reviewWaitHours !== undefined ? durationWords(row.reviewWaitHours.median) : NOT_ENOUGH },
     { key: "failed", title: "Failed", render: row => rate(row.failureRate, "failed", row.enough) },
    ];
    // A panel that is still collecting shows its honest line; figures appear only for a company that has enough work, so nothing is drawn as a zero.
    return <>
     {data.status !== "ready" && <NotReady status={data.status} collectingSince={data.collectingSince ?? panel.collectingSince} now={now} />}
     {data.status === "unavailable" || data.status === "unknown" ? null : <>
      <Figures figures={data.company} />
      {data.byProject.length > 0 && <DataTable caption="Flow health by project" columns={columns} rows={data.byProject} rowKey={row => row.project} />}
     </>}
    </>;
   }}</Reading>
  </>}
 </Panel>;
}
