// RULING Q42: the used App entry owns global design CSS even when the library barrel is tree-shaken.
import "./design/design.css";
import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { RouterProvider, type RouteObject } from "react-router";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { AppNavReaderSchema, type AppNav } from "@agentx/contracts/web";
import { AppHostProvider, useAppHost, type AppHost } from "./host.js";
import { ThemeProvider } from "./theme.js";
import { Announcer } from "./design/Announcer.js";
import { Skeleton } from "./design/Skeleton.js";
import { PageError, ErrorBoundary } from "./shell/ErrorBoundary.js";
import { createApiClient } from "./api/client.js";
import { ApiError } from "./api/errors.js";
import { createQueryClient } from "./api/query.js";
import { appRoutes } from "./routes.js";
import "./shell/shell.css";
type Router = ComponentProps<typeof RouterProvider>["router"];
export type AppRouterFactory = (routes: RouteObject[]) => Router;
const EMPTY_FEATURES: AppNav["features"] = { localAgents: false, usage: false, admin: false, chains: false, notices: false, describe: false };
function Startup({ createRouter }: { createRouter: AppRouterFactory }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const standalone = /^\/app\/(?:signup|welcome|signed-out|no-company|create-company|join)\/?(?:\?|$)/u.test(host.currentPath());
 const nav = useQuery({ queryKey: ["nav"], queryFn: () => api.get("/v1/app/nav", AppNavReaderSchema), enabled: !standalone });
 // L4-SIGNIN: signed in (the app's nav answered, or this is a page only a signed-in person reaches), the browser keeps this sign-in's Slack workspace as its last workspace (a hint for the next sign-in).
 const signedIn = nav.data !== undefined || /^\/app\/(?:welcome|no-company|create-company)\/?(?:\?|$)/u.test(host.currentPath());
 useEffect(() => { if (signedIn) void host.rememberSignInWorkspace?.(); }, [host, signedIn]);
 const features = nav.data?.features;
 const router = useMemo(() => standalone || features !== undefined ? createRouter(appRoutes(features ?? EMPTY_FEATURES)) : undefined, [createRouter, features, standalone]);
 useEffect(() => () => { router?.dispose(); }, [router]);
 // DEC 253z: Code names no company for the person: the onboarding page, never the app.
 const noCompany = nav.error instanceof ApiError && nav.error.code === "NO_COMPANY";
 useEffect(() => { if (noCompany) host.navigate("/app/no-company"); }, [host, noCompany]);
 if (router !== undefined) return <RouterProvider router={router} />;
 if (nav.isPending || noCompany) return <main className="rv-entry"><Skeleton label="Loading workspace" /></main>;
 return <PageError error={nav.error} reload={() => host.navigate(host.currentPath())} />;
}
export function App({ host, createRouter }: { host: AppHost; createRouter: AppRouterFactory }) {
 const [query] = useState(createQueryClient);
 useEffect(() => () => query.clear(), [query]);
 return <AppHostProvider host={host}><QueryClientProvider client={query}><ThemeProvider host={host}><Announcer><ErrorBoundary reload={() => host.navigate(host.currentPath())}><Startup createRouter={createRouter} /></ErrorBoundary></Announcer></ThemeProvider></QueryClientProvider></AppHostProvider>;
}
