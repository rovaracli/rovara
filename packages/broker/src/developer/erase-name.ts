// ERASE-NAME-1: erasing the name a person is shown by. Two places hold it: the State item `DEVELOPER_NAME#<id>` (the name the person chose, developer/chosen-name.ts) and the displayName of their
// sign-in record. The item becomes a tombstone first (so every reader that reads the chosen name reads "erased" at once, with no name left in storage), then the sign-in function clears the
// record's name, because the broker has no write on that table. Repeatable: a second run changes nothing. Throws when the sign-in record could not be cleared, so the caller repeats the erase.
import type { EraseDeveloperNameRequest, EraseDeveloperNameResponse } from "@agentx/contracts";
import { eraseChosenName, type ChosenNameClient } from "./chosen-name.js";

export interface NameEraserInput {
  documentClient: ChosenNameClient;
  /** The State table. */
  stateTable: string;
  /** The sign-in function's erase of the record's name. Absent: an install with no sign-in function keeps no such record. */
  eraseSignInName?: ((request: EraseDeveloperNameRequest) => Promise<EraseDeveloperNameResponse>) | undefined;
  now: () => number;
}

export function nameEraserOf(input: NameEraserInput): { erase(developerId: string): Promise<void> } {
  return {
    async erase(developerId) {
      const at = new Date(input.now()).toISOString();
      await eraseChosenName(input.documentClient, input.stateTable, developerId, at);
      if (input.eraseSignInName === undefined) return;
      const answer = await input.eraseSignInName({ kind: "erase-developer-name", developerId, at });
      // Not found is an answer: the person never signed in, so there is no record with a name.
      if (!answer.ok && answer.error !== "not_found") throw new Error(`erase_name_sign_in_${answer.error}`);
    },
  };
}
