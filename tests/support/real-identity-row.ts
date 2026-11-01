// A sign-in table DEVELOPER#<id>/META row exactly as a real sign-in writes it. `upsertDeveloper` writes no `developerId` attribute (the id is
// the key), which hand-built fixtures used to add; checks that compared it refused every real person (2026-11-01).
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";

type Profile = Parameters<DeveloperSignInStore["upsertDeveloper"]>[0];

/** Writes the row through the real sign-in into `db` (replacing any row already there) (a fresh table when omitted), applies `changes` (revoked, mergedInto, ...) and returns it. */
export async function realIdentityRow(profile: Profile, changes: Record<string, unknown> = {}, db = new FakeDynamoDb()): Promise<Record<string, unknown>> {
  // A hand-built fixture row is replaced, never updated: the result is what the person's own sign-in wrote.
  db.delete({ pk: `DEVELOPER#${profile.developerId}`, sk: "META" });
  await new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => Date.parse("2026-10-30T14:00:00.000Z") }).upsertDeveloper(profile);
  const written = db.get(`DEVELOPER#${profile.developerId}`, "META");
  if (written === undefined || Object.hasOwn(written, "developerId")) throw new Error("a real sign-in row is keyed by the person and has no developerId attribute");
  if (Object.keys(changes).length > 0) db.set({ ...written, ...changes });
  return db.get(`DEVELOPER#${profile.developerId}`, "META")!;
}
