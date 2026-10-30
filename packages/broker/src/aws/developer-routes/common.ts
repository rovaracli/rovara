import type { z } from "zod";
import { agentXError } from "@agentx/contracts";
import { DeveloperSignInStore } from "../../developer/store.js";
import type { DeveloperRouteDependencies } from "./types.js";

export const PROJECT_NOT_FOUND_IN_APP = "project not found";

// The State table is given for the name a person chose (release 0.4.18): the store shows it instead of the sign-in record's.
export const signInStoreOf = (deps: DeveloperRouteDependencies) => new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.developer.signInTableName, nameTableName: deps.tableName, now: deps.now });

export const bodyError = (error: z.ZodError) => {
  const issue = error.issues[0];
  // Field names only: the values are the caller's.
  return agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
};
