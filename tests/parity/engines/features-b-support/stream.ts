// A table write as the DynamoDB stream hands it to a reader (NEW_AND_OLD_IMAGES), for running Cloud's stream readers (the agent-session projector) over the
// journey harness's table, which has no stream reader of its own.
import { randomUUID } from "node:crypto";
import { marshall } from "@aws-sdk/util-dynamodb";

type Item = Record<string, unknown>;

export function streamRecordOf(change: { before?: Item; after?: Item }): Record<string, unknown> {
  const image = (item: Item) => marshall(item, { removeUndefinedValues: true, convertClassInstanceToMap: true });
  const key = change.after ?? change.before ?? {};
  return {
    eventName: change.before === undefined ? "INSERT" : change.after === undefined ? "REMOVE" : "MODIFY",
    eventID: randomUUID(),
    dynamodb: {
      Keys: image({ pk: key.pk, sk: key.sk }),
      ...(change.after === undefined ? {} : { NewImage: image(change.after) }),
      ...(change.before === undefined ? {} : { OldImage: image(change.before) }),
    },
  };
}
