// 0.5.7: an environment's optional custom domain, in a record of its own (`/agentx/<env>/custom-domain`), not in the environment settings or the install answers.
// Those two are strict schemas in every release: a 0.5.6 command reading a settings document with keys it does not know refuses it, and an emergency rollback to
// 0.5.6 must still be able to read the environment. The record is read only by 0.5.7 and later; 0.5.6 never looks at it.
import { agentXError, environmentSettingsPrefix } from "@agentx/contracts";
import { z } from "zod";
import type { ParameterStore } from "./parameter-store.js";

/** A lower-case DNS name of at least two labels. */
export const CUSTOM_DOMAIN_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** A Route 53 hosted zone id. */
export const CUSTOM_DOMAIN_ZONE = /^Z[A-Z0-9]{4,31}$/;

export const CustomDomainSchema = z.object({
  schemaVersion: z.literal(1),
  domainName: z.string().max(64).regex(CUSTOM_DOMAIN_NAME),
  hostedZoneId: z.string().regex(CUSTOM_DOMAIN_ZONE),
}).strict();
export type CustomDomain = Omit<z.infer<typeof CustomDomainSchema>, "schemaVersion">;

export const customDomainParameterName = (env: string): string => `${environmentSettingsPrefix(env)}custom-domain`;

/** The recorded domain, or undefined when none. An unreadable record is refused, never taken as absent: a deploy would then remove the domain. */
export async function readCustomDomain(store: ParameterStore, env: string): Promise<CustomDomain | undefined> {
  const stored = await store.get(customDomainParameterName(env));
  if (stored === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(stored.value);
  } catch {
    throw agentXError("CONFIG_INVALID", `${customDomainParameterName(env)} is not valid JSON; fix it or delete it (agentx signin cloud --no-custom-domain), then run this again`);
  }
  const parsed = CustomDomainSchema.safeParse(json);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${customDomainParameterName(env)} is invalid (${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}); fix it or delete it, then run this again`.replace("( ", "("));
  return { domainName: parsed.data.domainName, hostedZoneId: parsed.data.hostedZoneId };
}

export async function writeCustomDomain(store: ParameterStore, env: string, domain: CustomDomain): Promise<void> {
  await store.put(customDomainParameterName(env), JSON.stringify(CustomDomainSchema.parse({ schemaVersion: 1, ...domain })));
}

export const deleteCustomDomain = (store: ParameterStore, env: string): Promise<void> => store.delete(customDomainParameterName(env));

/**
 * The two stack parameters (the control plane and the access stack both take them). On the hosted cloud they are always sent, empty when there is no domain: a
 * deploy that left them out would keep the deployed values (cdk deploy reuses previous parameters), and a removal would never reach the stack.
 */
export const customDomainParameters = (domain: CustomDomain | undefined): Record<string, string> => ({ CustomDomainName: domain?.domainName ?? "", CustomDomainHostedZoneId: domain?.hostedZoneId ?? "" });

export const describeCustomDomain = (domain: CustomDomain | undefined): string => (domain === undefined ? "off" : `${domain.domainName} (hosted zone ${domain.hostedZoneId})`);
