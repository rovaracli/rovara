import { createContext, useContext, type ReactNode } from "react";
import { AppHostProvider, type AppHost } from "../../../host.js";
/**
 * G2's action host fences every write on the page against the reads it showed (report, feature, source, model, key and settings changes). The company AI CONNECTION forms (Anthropic key, own
 * endpoint, Bedrock) are other components with their own identity, revision and lock handling; they are the same components the setup step shows, so on G2's AI page they talk to the page's
 * own host, not through that fence (which would refuse every write it has no read for). Outside G2 there is no provider and nothing changes.
 */
export const UnfencedHostContext = createContext<AppHost | undefined>(undefined);
export function UnfencedHost({ children }: { children: ReactNode }) {
 const host = useContext(UnfencedHostContext);
 return host === undefined ? <>{children}</> : <AppHostProvider host={host}>{children}</AppHostProvider>;
}
