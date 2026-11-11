// Experience decision 23: a person's favourite agents are one item per person and company whose key holds their developer id (`agentFavouritesKey`). The person's erase
// removes it (the registry names it under the `config` step), and nobody else's item, and not the same person's item in another company.
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { agentFavouritesKey } from "@agentx/cloud-contracts";
import { erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { PERSON_FIELDS } from "../../../packages/broker/src/team-record/person-fields.js";
import { ORG_A, ORG_B, world } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const favourites = (w: ReturnType<typeof world>) => w.db.find((item) => item.entityType === "AGENT_FAVOURITES").map((item) => `${item.pk as string}|${item.sk as string}`).sort();

describe("a person's erase removes their favourite agents", () => {
  it("deletes the person's item in this company, and keeps everyone else's", async () => {
    const w = world();
    for (const [orgId, developerId] of [[ORG_A, "dev-1"], [ORG_A, "dev-2"], [ORG_B, "dev-1"]] as const) {
      await w.table.documentClient.send(new PutCommand({ TableName: w.table.tableName, Item: { ...agentFavouritesKey(orgId, developerId), entityType: "AGENT_FAVOURITES", orgId, agentIds: ["root-cause-analyst"], revision: 1 } }));
    }
    // positive control: the items are there, keyed by the person
    expect(favourites(w)).toHaveLength(3);
    const result = await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-1" }, "erase-favourites-1");
    expect(result.steps?.config).toBe(true);
    const mine = agentFavouritesKey(ORG_A, "dev-1");
    const left = favourites(w);
    expect(left).not.toContain(`${mine.pk}|${mine.sk}`);
    expect(left).toEqual([`${agentFavouritesKey(ORG_A, "dev-2").pk}|META`, `${agentFavouritesKey(ORG_B, "dev-1").pk}|META`].sort());
  });

  it("the registry names the item under the config step", () => {
    expect(PERSON_FIELDS.find((field) => field.names.includes("favourites"))).toMatchObject({ store: "hot", step: "config" });
  });
});
