// RULING Q42: the used App entry owns global design CSS even when the library barrel is tree-shaken.
import "./design/design.css";
import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { RouterProvider, type RouteObject } from "react-router";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { AppNavReaderSchema, type AppNav, type ReadAppNav } from "@agentx/cloud-contracts/web";
import { AppHostProvider, reloadPage, useAppHost, type AppHost } from "./host.js";
import { ThemeProvider } from "./theme.js";
import { Announcer } from "./design/Announcer.js";
import { Skeleton } from "./design/Skeleton.js";
import { PageError } from "./shell/ErrorBoundary.js";
import { AppErrorBoundary } from "./shell/AppErrorBoundary.js";
import { createApiClient } from "./api/client.js";
import { createQueryClient } from "./api/query.js";
import { appRoutes } from "./routes.js";
import { isBillingV2On } from "./billing-flags.js";
import { isAgentPublishOn } from "./screens/agents/publish-flags.js";
import { applyNavUiFlags, startUiFlags, syncUiFlags, useUiFlagsStarted } from "./ui-flags.js";
import "./shell/shell.css";
import "./look-v2.css";
type Router = ComponentProps<typeof RouterProvider>["router"];
export type AppRouterFactory = (routes: RouteObject[]) => Router;
const EMPTY_FEATURES: AppNav["features"] = { localAgents: false, usage: false, admin: false, chains: false, notices: false, describe: false };
const isStandalone = (host: AppHost) => /^\/app\/(?:signup|welcome|signed-out)\/?(?:\?|$)/u.test(host.currentPath());
function Startup({ createRouter }: { createRouter: AppRouterFactory }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const standalone = isStandalone(host);
 const nav = useQuery({ queryKey: ["nav"], queryFn: () => api.get("/v1/app/nav", AppNavReaderSchema), enabled: !standalone });
 if (standalone || nav.data !== undefined) return <Routed createRouter={createRouter} nav={nav.data} standalone={standalone} />;
 if (nav.isPending) return <main className="rv-entry"><Skeleton label="Loading workspace" /></main>;
 return <PageError error={nav.error} reload={() => { reloadPage(host); }} />;
}
/** Mounted once the navigation answer is in (or on a page that has none). The layout switches are read ONCE, here, after the company's runtime flags (in the answer, ui-flags.ts) are in the host's store, so the route table never changes under a person mid-task. */
function Routed({ createRouter, nav, standalone }: { createRouter: AppRouterFactory; nav: ReadAppNav | undefined; standalone: boolean }) {
 const host = useAppHost(), features = nav?.features;
 const [options] = useState(() => { applyNavUiFlags(host, nav);return { billing: isBillingV2On(host), publish: isAgentPublishOn(host) }; });
 const router = useMemo(() => standalone || features !== undefined ? createRouter(appRoutes(features ?? EMPTY_FEATURES, options)) : undefined, [createRouter, features, options, standalone]);
 useEffect(() => () => { router?.dispose(); }, [router]);
 return router === undefined ? null : <RouterProvider router={router} />;
}
export function App({ host, createRouter }: { host: AppHost; createRouter: AppRouterFactory }) {
 const [query] = useState(createQueryClient);
 // Fail closed: until the navigation answer arrives (or when it fails) every new screen and the new look are off, whatever this device's keys say. Pages that make no navigation read keep the device keys.
 // The hold is a write to the host's store, so it runs in an effect, not in a render initializer. Nothing below renders until it has run (`held`), so no screen reads a flag before the hold is in place.
 const held = useUiFlagsStarted(host);
 useEffect(() => { startUiFlags(host, !isStandalone(host)); }, [host]);
 useEffect(() => () => query.clear(), [query]);
 // Lane U5: the company's runtime UI flags ride the navigation answer; keep the host's flag store equal to the newest one.
 useEffect(() => syncUiFlags(query.getQueryCache(), host), [query, host]);
 if (!held) return null;
 // The outermost boundary wraps the theme and the announcer too, so a failure in either still ends in a styled page with Reload (its fallback brings its own sheet).
 return <AppErrorBoundary host={host}><AppHostProvider host={host}><QueryClientProvider client={query}><ThemeProvider host={host}><Announcer><Startup createRouter={createRouter} /></Announcer></ThemeProvider></QueryClientProvider></AppHostProvider></AppErrorBoundary>;
}
