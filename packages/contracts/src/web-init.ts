import { z } from "zod";
export function configureZodForCsp(): void { z.config({ jitless: true }); }
// RULING Q21: Zod probes eval while constructing object schemas, before a host can call its own startup body.
// This browser-entry dependency must run before the other contract modules. Node's root entry does not import it.
configureZodForCsp();
