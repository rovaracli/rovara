// Imported first by the broker's handler (broker.ts), so that this runs before anything else in the process reads its environment.
// See broker-environment.ts.
import { hydrateBrokerEnvironment } from "./broker-environment.js";

hydrateBrokerEnvironment(process.env);
