// Guided onboarding PR 11 (design 3d): "Connect Linear" and what Linear's return came back with (`linear=<word>`; the outcome is kept by Cloud's server).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIntegrationsApi } from "../../api/integrations.js";
import { useAppHost } from "../../host.js";
import { isLinearAuthorizeUrl } from "../../text/links.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import "./connect.css";

/** Cloud's fixed sentence for each landing word (linear-connect.ts LINEAR_OUTCOMES). */
export const LINEAR_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
 cancelled: "Linear wasn't connected. You can connect it any time.",
 start_again: "Start again from Rovara.",
 taken: "This Linear workspace is already connected to a different Rovara company.",
 other_workspace: "This company is already connected to another Linear workspace. A company owner can disconnect it first, then connect again.",
 unavailable: "Linear could not be connected just now. Start again from Rovara.",
 not_set_up: "Connecting Linear isn't set up on this Rovara yet. Ask the Rovara team.",
 not_available: "Connecting Linear isn't available yet.",
});

/** Starts Connect Linear: Cloud's server asks Code for a state, binds it to this browser, and answers Linear's consent page. Linear comes back to this page. */
export function useLinearConnect() {
 const api = useIntegrationsApi(), host = useAppHost(), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 async function start() {
  setBusy(true);setError(undefined);
  try { const { authorizeUrl } = await api.linearConnect();if (!isLinearAuthorizeUrl(authorizeUrl, host.origin)) throw new Error("Rovara returned an invalid Linear link.");host.navigate(authorizeUrl); }
  catch (e) { setError(e instanceof Error ? e.message : "Couldn't connect Linear.");setBusy(false); }
 }
 return { busy, error, start };
}

export function LinearConnectButton({ label = "Connect Linear" }: { label?: string }) {
 const connect = useLinearConnect();
 return <><Button variant="primary" busy={connect.busy} data-testid="linear-connect" onClick={() => { void connect.start(); }}>{label}</Button>{connect.error !== undefined && <p role="alert" data-testid="linear-connect-error"><VisibleText text={connect.error} /></p>}</>;
}

export function LinearConnectResult({ outcome }: { outcome: string }) {
 const api = useIntegrationsApi(), query = useQueryClient();
 const refusal = LINEAR_REFUSALS[outcome];
 const result = useQuery({ queryKey: ["linear", "connect-result"], enabled: outcome === "result", queryFn: async () => { const value = await api.linearResult();if (value.status === "connected") void query.invalidateQueries({ queryKey: ["linear"], predicate: item => item.queryKey[1] !== "connect-result" });return value; }, retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false });
 if (refusal !== undefined) return <section className="rv-connect-result" aria-label="Linear connection" data-testid="linear-refused"><p role={outcome === "cancelled" ? "status" : "alert"} data-testid="linear-refused-message"><VisibleText text={refusal} /></p>{outcome !== "not_set_up" && outcome !== "not_available" && <LinearConnectButton label="Try again" />}</section>;
 if (outcome !== "result" || result.isPending || result.isError || result.data.status === "none") return null;
 return <section className="rv-connect-result" aria-label="Linear connection"><p role="status" data-testid="linear-connected">Connected to Linear workspace <strong><VisibleText text={result.data.workspaceName} /></strong>.{result.data.reconnected ? " Reconnected." : ""}</p></section>;
}
