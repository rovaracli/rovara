import { ApiError } from "../api/errors.js";
import { VisibleText } from "../design/VisibleText.js";
import { Component, type ReactNode } from "react";
import { useRouteError, type RouteObject } from "react-router";
import { reloadPage, useAppHost } from "../host.js";
import { Button } from "../design/Button.js";
// Decision 125: with no old screen to fall back to, every failure ends in a page or a part that says so and offers Reload, never a blank page. Reload is the page's own reload (`reloadPage`), never a
// navigation the host may refuse for the address it holds.

/**
 * A screen's code that could not load: after a release the old chunk names are gone, and a reload fetches the new ones. Browsers report a failed import as a TypeError ("Failed to fetch dynamically
 * imported module", "Importing a module script failed"), but Vite preloads a chunk's CSS first and throws a plain Error ("Unable to preload CSS for ..."), so any Error with those words counts.
 * A broker answer (ApiError) never does: its words are the server's, not the browser's.
 */
export function isChunkLoadError(error: unknown): boolean {
 return error instanceof Error && !(error instanceof ApiError) && /(?:dynamic.*import|import.*module|module.*script|chunk|unable to preload)/iu.test(error.message);
}
export function PageError({ error, reload }: { error: unknown; reload?: () => void }) {
 return <section className="rv-page-error"><h1 tabIndex={-1}>{isChunkLoadError(error) ? "Rovara was updated. Reload to continue." : "Something went wrong on this page."}</h1>{error instanceof ApiError && <p role="alert"><VisibleText text={error.message} /></p>}<Button onClick={reload}>Reload</Button></section>;
}
export function RouteError() { const host = useAppHost();return <PageError error={useRouteError()} reload={() => { reloadPage(host); }} />; }

export class ErrorBoundary extends Component<{ children: ReactNode; reload: () => void; fallback?: (error: unknown) => ReactNode }, { error?: unknown }> {
 override state: { error?: unknown } = {};
 static getDerivedStateFromError(error: unknown) { return { error }; }
 // A fallback that returns null means "show nothing here" (a part that is allowed to vanish), so only an absent fallback gets the page error.
 override render() { return this.state.error === undefined ? this.props.children : this.props.fallback === undefined ? <PageError error={this.state.error} reload={this.props.reload} /> : this.props.fallback(this.state.error); }
}

/** One part of a page that failed (its code did not load, or it crashed): the page around it stays. */
export function PartError({ reload }: { reload: () => void }) {
 return <div className="rv-part-error" role="alert"><p>Couldn&apos;t load this part.</p><Button onClick={reload}>Reload</Button></div>;
}
export function PartBoundary({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
 const host = useAppHost(), reload = () => { reloadPage(host); };
 return <ErrorBoundary reload={reload} fallback={() => fallback === undefined ? <PartError reload={reload} /> : fallback}>{children}</ErrorBoundary>;
}
/** The page's own content area when a piece it depends on could not load: the page error (with Reload) in place of the content, while the shell around it (the navigation) stays. */
export function ContentBoundary({ children }: { children: ReactNode }) {
 const host = useAppHost();
 return <ErrorBoundary reload={() => { reloadPage(host); }}>{children}</ErrorBoundary>;
}

/** A route whose screen loads lazily: if its code cannot load, the route renders the page error in its place, inside the shell (and the admin layout), instead of the error reaching a parent route. */
function ChunkError({ error }: { error: unknown }) { const host = useAppHost();return <PageError error={error} reload={() => { reloadPage(host); }} />; }
export function guardLazy(route: RouteObject): RouteObject {
 const load = route.lazy;
 if (typeof load !== "function") return route;
 return { ...route, lazy: async () => { try { return await load(); } catch (error) { return { Component: () => <ChunkError error={error} /> }; } } };
}

