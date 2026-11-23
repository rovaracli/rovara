import { createContext, createElement, useContext, useLayoutEffect, useMemo, type ReactNode } from "react";
import { ApiError } from "../../api/errors.js";
import { AppHostProvider, useAppHost, type AppHost } from "../../host.js";

/** Write authority (DEC 254zzz324, rule 14): a write control is on only while EVERY read it depends on is fresh. This file holds the identity half and the send-time refusal. */
export const RECONNECTING_TEXT = "Reconnecting; try again when the page is up to date.";
const IdentityFrozen = createContext(false);
/** The page's identity read is showing kept facts after a failed re-read. Outside a G4 page (no identity read here) nothing is frozen. */
export function useIdentityFrozen(): boolean { return useContext(IdentityFrozen); }

/**
 * Provided by the G4 read entry. Everything under it sees a host whose writes are refused while the identity read is stale: the refusal happens
 * where a request would leave the browser, so no control can send after the identity read failed, whatever its own handler does (0 requests).
 */
/** The gated hosts whose identity read is stale right now. */
const frozenHosts = new WeakSet<object>();
/** The host seen below the provider: writes are refused at the transport while it is in `frozenHosts`. */
function gatedHost(host: AppHost): AppHost {
 const transport = { request: (input: Parameters<AppHost["transport"]["request"]>[0]) => (frozenHosts.has(gated) && input.method !== "GET" && input.method !== "HEAD") ? Promise.reject(new ApiError(503, "RECONNECTING", RECONNECTING_TEXT)) : host.transport.request(input) };
 // A Proxy, not Object.create: `{ ...useAppHost() }` still copies every field of the real host (own keys are forwarded) and takes the gated transport.
 const gated: AppHost = new Proxy(host, { get: (target, key): unknown => key === "transport" ? transport : Reflect.get(target, key, target) as unknown });
 return gated;
}
export function IdentityFrozenProvider({ stale, children }: { stale: boolean; children: ReactNode }) {
 const host = useAppHost(), gated = useMemo(() => gatedHost(host), [host]);
 // Layout effects run before any click can: a handler captured earlier still finds the newest state at send time.
 useLayoutEffect(() => { if (stale) frozenHosts.add(gated);else frozenHosts.delete(gated);return () => { frozenHosts.delete(gated); }; }, [stale, gated]);
 return createElement(IdentityFrozen.Provider, { value: stale }, createElement(AppHostProvider, { host: gated, children }));
}

/** Wraps a group of write controls: while the identity read (or this group's own read, `stale`) is stale every control inside is disabled. Links and reads keep working. */
export function WriteRegion({ stale = false, children }: { stale?: boolean; children: ReactNode }) {
 const identity = useIdentityFrozen();
 return createElement("fieldset", { className: "g4-writes", disabled: identity || stale, "data-frozen": (identity || stale) ? "true" : undefined }, children);
}
