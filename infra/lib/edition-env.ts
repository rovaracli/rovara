// Enterprise foundations, fix round 1 (review I-3): the edition is decided once, at synth, and every function and task carries it as ROVARA_EDITION, so no
// process has to guess it from another setting at run time.
import { Aws, type IAspect, aws_ecs as ecs, aws_iam as iam, aws_lambda as lambda } from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import { EDITION_ENV_VAR, type Edition } from "@agentx/contracts";

export class EditionEnvironment implements IAspect {
  constructor(private readonly edition: Edition) {}

  visit(node: IConstruct): void {
    // Application functions (an L2 function). The provider functions CDK makes for custom resources get it too, which is harmless.
    if (node instanceof lambda.Function) node.addEnvironment(EDITION_ENV_VAR, this.edition);
    // The ECS tasks are written as L1 (model proxy, Slack orchestrator): every container of the task definition gets it.
    if (node instanceof ecs.CfnTaskDefinition && Array.isArray(node.containerDefinitions)) {
      node.containerDefinitions = node.containerDefinitions.map((container) => {
        if (container === null || typeof container !== "object" || "resolve" in container) return container;
        const definition: ecs.CfnTaskDefinition.ContainerDefinitionProperty = container;
        const environment = Array.isArray(definition.environment) ? definition.environment as ecs.CfnTaskDefinition.KeyValuePairProperty[] : [];
        if (environment.some((entry) => entry.name === EDITION_ENV_VAR)) return container;
        return { ...definition, environment: [...environment, { name: EDITION_ENV_VAR, value: this.edition }] };
      });
    }
  }
}

/** The SSM parameter that records an install's edition (written by the foundation for an Enterprise install, and kept when the stack goes). */
export function editionRecordParameterName(env: string): string {
  return `/agentx/${env}/edition`;
}

/**
 * Lets a function that serves requests read the edition record, in EVERY synth of a named environment (not only one that names an edition): the check that an install
 * with an edition is never served without its stamp must still be able to read the record in the synth that lost the stamp.
 */
export function grantEditionRecordRead(fn: lambda.Function, env: string): void {
  fn.addToRolePolicy(new iam.PolicyStatement({
    sid: "ReadEditionRecord",
    actions: ["ssm:GetParameter"],
    resources: [`arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${editionRecordParameterName(env)}`],
  }));
}
