import { servedReadState } from "../../api/served-read.js";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppHost, type AppHost } from "../../host.js";
import { createRulesLessonsReads } from "./read-model.js";
import { ReadState } from "./ReadState.js";
import { ErrorBlock, ReadHeader } from "./parts.js";
import { StaleScope } from "./stale.js";
import { IdentityFrozenProvider } from "../project/write-freeze.js";
import "./rules-lessons-read.css";
const hosts = new WeakMap<AppHost, number>();let nextHost = 0;
const Context = createContext<{ scope: readonly unknown[]; api: ReturnType<typeof createRulesLessonsReads>; role: string; orgName: string; identityStale: boolean } | undefined>(undefined);
export function useReadContext() { const value = useContext(Context);if (value === undefined) throw new Error("Missing rules read context");return value; }
export function useAreaRead<T>(key: readonly unknown[], queryFn: () => Promise<T>) {
 const { scope } = useReadContext();
 return useQuery({ queryKey: [...scope, ...key], queryFn, retry: false, refetchOnMount: "always" });
}
export function ReadEntry({ children, admin = false, refName = "RULES", header }: { children: ReactNode; admin?: boolean; refName?: string; header?: { crumbs: readonly string[]; title: string } }) {
 const host = useAppHost();if (!hosts.has(host)) hosts.set(host, ++nextHost);
 const api = useMemo(() => createRulesLessonsReads(host), [host]);
 const identity = useQuery({ queryKey: ["g4", hosts.get(host), "identity"], queryFn: api.identity, retry: false, refetchOnMount: "always" });
 return <div className="g4-rules-lessons-read"><StaleScope>{header !== undefined && (servedReadState(identity).data === undefined) && <ReadHeader {...header} />}<ReadState read={identity} scope="page" refName={refName}>{me => {
  const role = me.developer.orgRole;
  if (admin && role !== "owner" && role !== "admin") return <ErrorBlock kind="denied" scope="page" refName={refName} retry={() => { void identity.refetch(); }} />;
  const identityStale = servedReadState(identity).staleSince !== undefined;
  // Every write under this page (the live Learned / Rules / Work-batch controls included) is refused at send time while the identity read shows kept facts.
  return <Context.Provider value={{ api, role, orgName: me.org.name, identityStale, scope: ["g4", hosts.get(host), me.org.orgId, me.developer.id] }}><IdentityFrozenProvider stale={identityStale}>{children}</IdentityFrozenProvider></Context.Provider>;
 }}</ReadState></StaleScope></div>;
}
