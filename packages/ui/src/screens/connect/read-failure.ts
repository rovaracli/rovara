// A read that failed is said in the app's own fixed words, chosen by the error's code: never the server's text (guided onboarding PR 11).
import { ApiError } from "../../api/errors.js";

const BY_CODE: Readonly<Record<string, string>> = Object.freeze({
 SLACK_NOT_CONNECTED: "Add Rovara to Slack first: this company has no Slack workspace connected.",
 LINEAR_NOT_CONNECTED: "Linear isn't connected for this company. A company owner or admin can connect it in Company settings, Connections.",
 FORBIDDEN: "Only a company owner or admin, or this project's admin, can change this.",
 NOT_FOUND: "This isn't available yet.",
});

export function readFailure(error: unknown, fallback: string): string {
 return error instanceof ApiError && Object.hasOwn(BY_CODE, error.code) ? BY_CODE[error.code]! : fallback;
}
