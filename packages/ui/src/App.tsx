// RULING Q42: the used App entry owns global design CSS even when the library barrel is tree-shaken.
import "./design/design.css";
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { RouterProvider, type RouteObject } from "react-router";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { AppNavReaderSchema, type AppNav } from "@agentx/contracts/web";
import { AppHostProvider, useAppHost, type AppHost } from "./host.js";
import { ThemeProvider } from "./theme.js";
import { Announcer } from "./design/Announcer.js";
import { Skeleton } from "./design/Skeleton.js";
import { PageError, ErrorBoundary } from "./shell/ErrorBoundary.js";
import { createApiClient } from "./api/client.js";
import { createQueryClient } from "./api/query.js";
import { appRoutes } from "./routes.js";
import { isNewNavOn } from "./nav-flags.js";
import { isInsightsOn } from "./screens/insights/insights-flags.js";
import { isBillingV2On } from "./billing-flags.js";
import { isAgentPublishOn } from "./screens/agents/publish-flags.js";
import { applyNavUiFlags, syncUiFlags } from "./ui-flags.js";
import "./shell/shell.css";
import "./look-v2.css";
type Router = ComponentProps<typeof RouterProvider>["router"];
export type AppRouterFactory = (routes: RouteObject[]) => Router;
const EMPTY_FEATURES: AppNav["features"] = { localAgents: false, usage: false, admin: false, chains: false, notices: false, describe: false };
function Startup({ createRouter }: { createRouter: AppRouterFactory }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const standalone = /^\/app\/(?:signup|welcome|signed-out)\/?(?:\?|$)/u.test(host.currentPath());
 const nav = useQuery({ queryKey: ["nav"], queryFn: () => api.get("/v1/app/nav", AppNavReaderSchema), enabled: !standalone });
 const features = nav.data?.features;
 // The layout switches are read ONCE, when the navigation answer first arrives (it carries the company's runtime flags, ui-flags.ts), so the route table never changes under a person mid-task.
 const options = useRef<{ newNav: boolean; insights: boolean; billing: boolean; publish: boolean }>(undefined);
 if (options.current === undefined && (standalone || nav.data !== undefined)) { applyNavUiFlags(host, nav.data);options.current = { newNav: isNewNavOn(host), insights: isInsightsOn(host), billing: isBillingV2On(host), publish: isAgentPublishOn(host) }; }
 const latched = options.current;
 const router = useMemo(() => latched !== undefined && (standalone || features !== undefined) ? createRouter(appRoutes(features ?? EMPTY_FEATURES, latched)) : undefined, [createRouter, features, latched, standalone]);
 useEffect(() => () => { router?.dispose(); }, [router]);
 if (router !== undefined) return <RouterProvider router={router} />;
 if (nav.isPending) return <main className="rv-entry"><Skeleton label="Loading workspace" /></main>;
 return <PageError error={nav.error} reload={() => host.navigate(host.currentPath())} />;
}
export function App({ host, createRouter }: { host: AppHost; createRouter: AppRouterFactory }) {
 const [query] = useState(createQueryClient);
 useEffect(() => () => query.clear(), [query]);
 // Lane U5: the company's runtime UI flags ride the navigation answer; keep the host's flag store equal to the newest one.
 useEffect(() => syncUiFlags(query.getQueryCache(), host), [query, host]);
 return <AppHostProvider host={host}><QueryClientProvider client={query}><ThemeProvider host={host}><Announcer><ErrorBoundary reload={() => host.navigate(host.currentPath())}><Startup createRouter={createRouter} /></ErrorBoundary></Announcer></ThemeProvider></QueryClientProvider></AppHostProvider>;
}
