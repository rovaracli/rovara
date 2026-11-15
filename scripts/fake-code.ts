// A fake Rovara Code for building Cloud's screens before the real Code serves the routes (contract v0:
// packages/contracts/src/code-contract-v0.ts). One command, no AWS, nothing stored:
//
//   npm run fake-code
//   ROVARA_CODE_URL=http://127.0.0.1:8790 ROVARA_CLIENT_SECRET=fake-secret npm run cloud:local
//
// Optional: PORT (8790), HOST (127.0.0.1), FAKE_CODE_PERSON (priya, an administrator, or sam, a developer), ROVARA_CLIENT_ID (rovara-cloud),
// ROVARA_CLIENT_SECRET (fake-secret). To sign in as someone else without a restart:
//   curl -X POST http://127.0.0.1:8790/__fake/person -d '{"person":"sam"}'
import { PRIYA, SAM, startFakeCode } from "../tests/support/fake-code.js";

const person = process.env.FAKE_CODE_PERSON === "sam" ? SAM : PRIYA;
const fake = await startFakeCode({
  person,
  port: Number(process.env.PORT ?? 8790),
  host: process.env.HOST ?? "127.0.0.1",
  ...(process.env.ROVARA_CLIENT_ID === undefined ? {} : { clientId: process.env.ROVARA_CLIENT_ID }),
  ...(process.env.ROVARA_CLIENT_SECRET === undefined ? {} : { clientSecret: process.env.ROVARA_CLIENT_SECRET }),
});
console.log(`fake Rovara Code on ${fake.url} (signing in as ${person.name}; client ${process.env.ROVARA_CLIENT_ID ?? "rovara-cloud"}, secret ${process.env.ROVARA_CLIENT_SECRET === undefined ? "fake-secret" : "from ROVARA_CLIENT_SECRET"})`);
console.log("canned data only; it forgets everything when it stops. Ctrl-C to stop.");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void fake.close().then(() => { process.exit(0); }); });
