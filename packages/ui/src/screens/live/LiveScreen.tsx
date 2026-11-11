import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppNavReaderSchema, ProjectOverviewProjectSchema, LIVE_FILTERS, LiveFilterSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../host.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { useLive, mergeLiveTiles, type ReadLiveTile } from "../../api/live.js";
import { createRealtimeClient } from "../../realtime/client.js";
import { createNoticeInvalidator } from "../../realtime/invalidate.js";
import { useAnnounce } from "../../design/Announcer.js";
import { Button } from "../../design/Button.js";
import { EmptyState } from "../../design/EmptyState.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { Tabs } from "../../design/Tabs.js";
import { VisibleText } from "../../design/VisibleText.js";
import { SessionTile } from "./SessionTile.js";
import { isWorkListOn } from "./work-list-flags.js";
import { WorkListScreen } from "./WorkListScreen.js";
import "./live.css";
const LABELS = { all: "All", mine: "Mine", team: "Team", needs_me: "Needs me", failed: "Failed" } as const;
/** The Live list. With the Work list switch on (`rovara.work`, see work-list-flags.ts) the same route shows the Work list instead; off, it is today's list, unchanged. */
export function LiveScreen() { return isWorkListOn(useAppHost()) ? <WorkListScreen /> : <TodaysLiveScreen />; }
function TodaysLiveScreen() {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createApiClient(host), [host]), [params, setParams] = useSearchParams(), announce = useAnnounce();
 const parsedFilter = LiveFilterSchema.safeParse(params.get("filter")), filter = parsedFilter.success ? parsedFilter.data : "all", parsedProject = ProjectOverviewProjectSchema.shape.name.safeParse(params.get("project")), project = parsedProject.success ? parsedProject.data : undefined;
 const live = useLive(filter, project), nav = useQuery({ queryKey: ["nav"], queryFn: () => api.get("/v1/app/nav", AppNavReaderSchema) }), ready = live.data !== undefined && !live.isError;
 const [connection, setConnection] = useState("connecting");
 useEffect(() => { if (!ready) return;const invalidator = createNoticeInvalidator(query), realtime = createRealtimeClient(host, { onNotice: notice => invalidator.notice(notice), onStatus: setConnection, onReset: () => invalidator.reset() });realtime.start();return () => { realtime.stop();invalidator.stop(); }; }, [host, query, ready]);
 const tiles = useMemo(() => { if (live.isError || live.data === undefined) return undefined;return mergeLiveTiles(live.data.pages); }, [live.data, live.isError]);
 const previous = useRef<{ key: string; tiles: ReadLiveTile[] } | undefined>(undefined), selection = filter + ":" + (project ?? "");
 useEffect(() => { if (tiles === undefined) return;if (previous.current?.key === selection) for (const tile of previous.current.tiles) if (!tiles.some(next => next.sessionId === tile.sessionId)) announce(tile.title + " left Live");previous.current = { key: selection, tiles }; }, [tiles, selection, announce]);
 function choose(key: string, value: string | undefined) { const next = new URLSearchParams(params);if (value === undefined) next.delete(key);else next.set(key, value);setParams(next); }
 const projects = nav.data?.projects.map(item => item.name) ?? [];if (project !== undefined && !projects.includes(project)) projects.push(project);
 const content = <>{filter === "team" && <p className="rv-muted">Sessions on projects you're part of</p>}{live.isPending && <Skeleton label="Loading sessions" />}{live.isError && <div role="alert"><p><VisibleText text={live.error instanceof ApiError ? live.error.message : "Couldn't load Live. Try again."} /></p><Button onClick={() => { void live.refetch(); }}>Try again</Button></div>}{tiles !== undefined && tiles.length === 0 && <EmptyState title={filter === "needs_me" ? "No sessions need you right now" : "No sessions here right now"} description="New work will appear here when it's available to you." />}{tiles !== undefined && tiles.length > 0 && <div className="rv-live-list">{tiles.map(tile => <SessionTile key={tile.sessionId} tile={tile} onChanged={() => query.invalidateQueries({ queryKey: ["live"] })} />)}</div>}{!live.isError && live.hasNextPage && <Button busy={live.isFetchingNextPage} onClick={() => { void live.fetchNextPage(); }}>Load more sessions</Button>}</>;
 return <section className="rv-live"><PageHeader title="Live" /><div className="rv-live-toolbar"><Select label="Project" value={project ?? "__all"} onValueChange={value => choose("project", value === "__all" ? undefined : value)} options={[{ value: "__all", label: "All projects" }, ...projects.map(name => ({ value: name, label: name }))]} />{ready && <span className="rv-muted" role="status">{connection === "reconnecting" ? "Reconnecting" : connection === "online" ? "Live updates connected" : "Connecting live updates"}</span>}</div><Tabs label="Live filters" value={filter} onValueChange={value => choose("filter", value)} items={LIVE_FILTERS.map(value => ({ value, label: LABELS[value], content: value === filter ? content : null }))} /></section>;
}
