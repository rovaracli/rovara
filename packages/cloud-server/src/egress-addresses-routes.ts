// Rovara's outbound addresses (lead 4, L4-EGR): the company settings line that tells an owner or admin which addresses Rovara's machines connect from, so the company can allow them.
//
//   GET /v1/app/org/egress-addresses -> Code GET /v1/dev/company/egress-addresses (a company owner or admin)   { addresses: [ "203.0.113.10", ... ] }
//
// Rules (as the engine-model read, ai-spend-routes.ts):
//   - The browser names nothing: Code takes the company from the person's live membership; nothing a request carries reaches Code.
//   - Cloud refuses a plain member first (Code is not asked), and Code decides again (live role).
//   - The addresses are the install's, the same for every company on it. They are public addresses, not secrets; they are shown only to owners and admins because the company's
//     firewall is the admins' business, not because they are secret.
//   - Code's answer is checked strictly (an object with exactly `addresses`: up to 4 distinct public IPv4 addresses). Anything else is "couldn't be read": never part of a list.
//   - Every refusal is fixed words; none of Code's text or the browser's reaches the app. A Code that does not serve the route (an older release) is answered 404, and the page shows nothing.
import { CodeError } from "./code-client.js";
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

export const EGRESS_ADDRESSES_CODE_PATH = "/v1/dev/company/egress-addresses";
/** The most addresses Code lists (its EGRESS_ADDRESSES_MAX). */
export const EGRESS_ADDRESSES_MAX = 4;

export const EGRESS_WORDS = Object.freeze({
  notAdmin: "Only a company owner or admin can see Rovara's outbound addresses.",
  notYet: "Rovara's outbound addresses aren't available on this Rovara yet.",
  unavailable: "Rovara's outbound addresses couldn't be read just now. Try again.",
});
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const EGRESS_ANSWERS = Object.freeze({
  notAdmin: answer(403, "FORBIDDEN", EGRESS_WORDS.notAdmin),
  notYet: answer(404, "NOT_FOUND", EGRESS_WORDS.notYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", EGRESS_WORDS.unavailable),
});

const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`, "u");
/** Ranges that are never a public internet address (Code's isNonPublicIpv4). */
function nonPublic(address: string): boolean {
  const [a, b] = address.split(".").map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Code's answer, strictly: exactly `{ addresses }` with up to EGRESS_ADDRESSES_MAX distinct public IPv4 addresses (an empty list is a real answer: this install has none yet). Undefined when anything is off. */
export function egressAddressesView(value: unknown): { addresses: string[] } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "addresses") return undefined;
  const addresses = (value as { addresses: unknown }).addresses;
  if (!Array.isArray(addresses) || addresses.length > EGRESS_ADDRESSES_MAX) return undefined;
  if (!addresses.every((entry) => typeof entry === "string" && IPV4.test(entry) && !nonPublic(entry))) return undefined;
  if (new Set(addresses).size !== addresses.length) return undefined;
  return { addresses: (addresses as string[]).slice() };
}

async function readEgressAddresses(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  // The role first (as Code does): a plain member learns nothing more, and Code is not asked.
  if (!isCompanyAdmin(who.companyRole)) return EGRESS_ANSWERS.notAdmin;
  let value: unknown;
  try {
    value = await context.client.json<unknown>(context.session, EGRESS_ADDRESSES_CODE_PATH, { method: "GET" });
  } catch (error) {
    if (!(error instanceof CodeError)) throw error;
    // A 404 is a Code that does not serve the route (an older release); a 403 is its own role check; anything else is "couldn't be read".
    return error.status === 404 ? EGRESS_ANSWERS.notYet : error.status === 403 ? EGRESS_ANSWERS.notAdmin : EGRESS_ANSWERS.unavailable;
  }
  const view = egressAddressesView(value);
  return view === undefined ? EGRESS_ANSWERS.unavailable : { status: 200, body: view };
}

/** Added to the route table (routes.ts): Code answers it, so it needs no company backend in Cloud. */
export const EGRESS_ADDRESSES_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/egress-addresses$/u, answer: readEgressAddresses },
];
