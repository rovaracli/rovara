// The Vertex AI guide's words and commands (L4-T4, setup review G4). Pure: the page prints what this returns, and the tests pin it.
//
// How the connection works (so the commands say the right thing):
//  - The gateway assumes Rovara's federation role with the COMPANY id as the session name, signs a GetCallerIdentity request with it, and
//    exchanges that at Google STS for a token (packages/model-gateway/src/product-vertex-token.ts:176-199). With a service account it then
//    impersonates it at iamcredentials (:201-207).
//  - Rovara refuses a pool that a canary company can also use: "too_open" (:140-153). So the provider's attribute condition must name this
//    company's exact session ARN: `assertion.arn == 'arn:aws:sts::<account>:assumed-role/<role>/<company>'`
//    (packages/model-gateway/src/product-vertex-credential.ts:124-128, vertexSetupSteps; a test keeps this file's condition equal to it).
//  - The form sends project id, location, the provider's full name and an optional service account (packages/cloud-server/src/product-ai-routes.ts:278-296).
// Only values that pass the same patterns Cloud checks (VERTEX_FORM) are ever put into a command, so a typed value can never add a shell word.
// Google's syntax: see the URLs in the L4-T4 pull request body.
import { VERTEX_FORM, type ProductAiRead } from "../../../api/admin-product-ai.js";

export type VertexStepNumber = 1 | 2 | 3;
/** The fixed names the guide gives what the customer creates (any valid name works; fixed ones keep the three commands the same for everyone). */
export const VERTEX_POOL_ID = "rovara", VERTEX_PROVIDER_ID = "rovara-aws", VERTEX_SERVICE_ACCOUNT_NAME = "rovara-vertex";
export const PROJECT_PLACEHOLDER = "YOUR_PROJECT_ID", ACCOUNT_PLACEHOLDER = "ROVARA_AWS_ACCOUNT_ID", ROLE_PLACEHOLDER = "ROVARA_ROLE_NAME", COMPANY_PLACEHOLDER = "YOUR_ROVARA_COMPANY_ID";

export interface VertexGuideStep { n: VertexStepNumber; title: string; why: string; command: string }
export interface VertexGuide {
  /** True when every value Rovara knows (its AWS account, role name, your company id) is in the commands; false: placeholders stand in. */
  complete: boolean;
  steps: readonly [VertexGuideStep, VertexGuideStep, VertexGuideStep];
  /** The condition the provider carries (also inside step 1's command), and the command that fixes a provider made without it. */
  condition: string; fixCondition: string;
  serviceAccount: string; sessionArn: string;
}

export function vertexGuide(input: { projectId: string; setup: ProductAiRead["vertexSetup"] }): VertexGuide {
  const project = VERTEX_FORM.projectId.test(input.projectId) ? input.projectId : PROJECT_PLACEHOLDER;
  const account = input.setup?.awsAccountId ?? ACCOUNT_PLACEHOLDER, role = input.setup?.roleName ?? ROLE_PLACEHOLDER, company = input.setup?.companyId ?? COMPANY_PLACEHOLDER;
  const sessionArn = `arn:aws:sts::${account}:assumed-role/${role}/${company}`;
  const condition = `assertion.arn == '${sessionArn}'`;
  const serviceAccount = `${VERTEX_SERVICE_ACCOUNT_NAME}@${project}.iam.gserviceaccount.com`;
  const head = `PROJECT_ID="${project}"`;
  const providerFlags = `--project="$PROJECT_ID" --location="global" --workload-identity-pool="${VERTEX_POOL_ID}"`;
  const fixCondition = `${head}\ngcloud iam workload-identity-pools providers update-aws ${VERTEX_PROVIDER_ID} ${providerFlags} \\\n  --attribute-condition="${condition}"`;
  return {
    complete: input.setup !== undefined, condition, fixCondition, serviceAccount, sessionArn,
    steps: [
      { n: 1, title: "Let Google trust Rovara's identity", why: "Creates a workload identity pool and an AWS provider that accepts only your company's Rovara session (the attribute condition). No key is created.",
        command: [head,
          `gcloud services enable iam.googleapis.com cloudresourcemanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com aiplatform.googleapis.com --project="$PROJECT_ID"`,
          `gcloud iam workload-identity-pools create ${VERTEX_POOL_ID} --project="$PROJECT_ID" --location="global" --display-name="Rovara"`,
          `gcloud iam workload-identity-pools providers create-aws ${VERTEX_PROVIDER_ID} ${providerFlags} \\\n  --account-id="${account}" \\\n  --attribute-mapping="google.subject=assertion.arn" \\\n  --attribute-condition="${condition}" \\\n  --display-name="Rovara"`].join("\n") },
      { n: 2, title: "Let that identity call Vertex AI", why: "Creates a service account with the Vertex AI User role, and lets only your company's Rovara session act as it.",
        command: [head, `PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")"`,
          `gcloud iam service-accounts create ${VERTEX_SERVICE_ACCOUNT_NAME} --project="$PROJECT_ID" --display-name="Rovara Vertex AI"`,
          `gcloud projects add-iam-policy-binding "$PROJECT_ID" \\\n  --member="serviceAccount:${serviceAccount}" \\\n  --role="roles/aiplatform.user"`,
          `gcloud iam service-accounts add-iam-policy-binding "${serviceAccount}" --project="$PROJECT_ID" \\\n  --role="roles/iam.workloadIdentityUser" \\\n  --member="principal://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/${VERTEX_POOL_ID}/subject/${sessionArn}"`].join("\n") },
      { n: 3, title: "Paste three values into Rovara", why: `Prints the provider's full name. Then enter it below with your project id, a location such as us-central1, and the service account ${serviceAccount}. Rovara tests the connection before it saves anything.`,
        command: [head, `echo "//iam.googleapis.com/$(gcloud iam workload-identity-pools providers describe ${VERTEX_PROVIDER_ID} ${providerFlags} --format="value(name)")"`].join("\n") },
    ],
  };
}

export interface VertexRefusalHelp { step: VertexStepNumber; /** A second step to check when it applies (a service account was entered). */ also?: VertexStepNumber; text: string }
/** Cloud's Vertex refusal reasons (product-ai-routes.ts WORDS.vertex*, `error.reason`) and the step that fixes each. */
export const VERTEX_REFUSAL_REASONS = Object.freeze(["vertex_refused", "vertex_too_open", "vertex_unavailable", "vertex_invalid"] as const);
export type VertexRefusalReason = typeof VERTEX_REFUSAL_REASONS[number];
export const isVertexRefusalReason = (value: unknown): value is VertexRefusalReason => typeof value === "string" && (VERTEX_REFUSAL_REASONS as readonly string[]).includes(value);

export function vertexRefusalHelp(reason: VertexRefusalReason, usesServiceAccount: boolean): VertexRefusalHelp {
  switch (reason) {
    case "vertex_refused": return usesServiceAccount
      ? { step: 1, also: 2, text: "Redo step 1: check the provider's full name, that it names Rovara's AWS account, and its attribute condition. You named a service account, so also check step 2: its grant must name your company's session." }
      : { step: 1, text: "Redo step 1: check the provider's full name, that it names Rovara's AWS account, and its attribute condition." };
    case "vertex_too_open": return { step: 1, text: "Redo step 1: the provider's attribute condition must name only your company's Rovara session. If the provider already exists, run the fix command under step 1." };
    case "vertex_unavailable": return { step: 3, text: "Nothing was saved. Rovara could not finish the test (Google or Rovara was unreachable). Redo step 3: press Test and save again in a minute." };
    case "vertex_invalid": return { step: 3, text: "Redo step 3: one of the four fields is not in the form Rovara expects. Copy the provider's name exactly as the step 3 command prints it." };
  }
}
