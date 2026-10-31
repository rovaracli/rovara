// Enterprise foundations, fix round 1 (review I-3): the edition is decided once, at synth, and every function and task carries it as ROVARA_EDITION, so no
// process has to guess it from another setting at run time.
import { type IAspect, aws_ecs as ecs, aws_lambda as lambda } from "aws-cdk-lib";
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
