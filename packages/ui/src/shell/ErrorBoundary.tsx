import { ApiError } from "../api/errors.js";
import { VisibleText } from "../design/VisibleText.js";
import { Component, type ReactNode } from "react";
import { useRouteError } from "react-router";
import { useAppHost } from "../host.js";
import { Button } from "../design/Button.js";
export function PageError({ error, reload }: { error: unknown; reload?: () => void }) {
 const update = error instanceof TypeError && /(?:dynamic.*import|import.*module|module.*script|chunk)/iu.test(error.message);
 return <section className="rv-page-error"><h1 tabIndex={-1}>{update ? "Rovara was updated. Reload to continue." : "Something went wrong on this page."}</h1>{error instanceof ApiError && <p role="alert"><VisibleText text={error.message} /></p>}<Button onClick={reload}>Reload</Button></section>;
}
export function RouteError() { const host = useAppHost();return <PageError error={useRouteError()} reload={() => host.navigate(host.currentPath())} />; }
export class ErrorBoundary extends Component<{ children: ReactNode; reload: () => void }, { error?: unknown }> {
 override state: { error?: unknown } = {};
 static getDerivedStateFromError(error: unknown) { return { error }; }
 override render() { return this.state.error === undefined ? this.props.children : <PageError error={this.state.error} reload={this.props.reload} />; }
}
