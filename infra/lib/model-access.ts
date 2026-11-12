import {
  aws_ec2 as ec2,
  aws_iam as iam,
  type aws_lambda as lambda,
  Stack,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { modelEndpointSecretsStatement } from "./model-endpoints.js";
import { MODEL_PROXY_MANAGEMENT_PORT, assumeOrgBedrockRoles, type ModelProxy } from "./model-proxy.js";
import type { AgentXNaming } from "./naming.js";
import { enterpriseHttpsEgress } from "./vpc-endpoints.js";

export interface ModelAccessProps {
  naming: AgentXNaming;
  vpcId: string;
  /** The foundation's private subnets, which have NAT egress. */
  subnetIds: string[];
  proxy: ModelProxy;
  /** The bundled handler (packages/broker/src/model-proxy/handler.ts); this construct puts it in the VPC and wires it to the proxy. */
  handler: lambda.Function;
  /** Enterprise installs: the ranges the function may reach over HTTPS. Absent: HTTPS to the whole internet, as before. */
  privateEgressCidrs?: readonly string[];
  /** Enterprise installs that turned company model endpoints on (N8): the function may read secrets named under `rovara/model-endpoints/`, and no others. */
  customModelEndpoints?: boolean;
  /** With `customModelEndpoints`: the environment the function judges endpoint addresses with (`modelEndpointBrokerEnvironment`: the switch, the private ranges, Rovara's own network). */
  customModelEndpointEnvironment?: Readonly<Record<string, string>>;
}

/**
 * Ruling R28 (implements R26): the broker Lambdas are not in the VPC, so they cannot reach the proxy's
 * internal load balancer. This function is the one VPC-attached hop. It is the only principal besides
 * the proxy's own tasks that may read the master key, so the broker never holds it. The broker invokes
 * it with lambda:InvokeFunction on this function alone (granted by the control plane).
 */
export class ModelAccess extends Construct {
  readonly securityGroup: ec2.CfnSecurityGroup;

  constructor(scope: Construct, id: string, props: ModelAccessProps) {
    super(scope, id);
    const { naming, handler, proxy } = props;
    const tags = [{ key: "Application", value: "AgentX" }, ...(naming.env === undefined ? [] : [{ key: "agentx:env", value: naming.env }])];
    const port = MODEL_PROXY_MANAGEMENT_PORT;

    // Its own group: the management port (4001) of the proxy load balancer, which no other group may reach (ruling R48), and HTTPS (through the NAT) for Secrets Manager.
    this.securityGroup = new ec2.CfnSecurityGroup(this, "SecurityGroup", {
      groupDescription: `AgentX model access function: management port ${port} to the model proxy and HTTPS to Secrets Manager`,
      vpcId: props.vpcId,
      securityGroupEgress: props.privateEgressCidrs === undefined ? [{
        ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIp: "0.0.0.0/0",
        description: "HTTPS to Secrets Manager",
      }] : enterpriseHttpsEgress(props.privateEgressCidrs, "HTTPS to Secrets Manager"),
      tags,
    });
    // The management ports the proxy serves (4001, or 8443 with TLS, both while the legacy listeners are kept). The plain-http port keeps its old ids; the group's description
    // above names 4001 and is left as it is, because a changed description would replace the group (and the function's network interfaces) on upgrade.
    for (const managementPort of proxy.managementPorts) {
      const suffix = managementPort === port ? "" : "Tls";
      new ec2.CfnSecurityGroupEgress(this, `ToModelProxy${suffix}`, {
        groupId: this.securityGroup.attrGroupId,
        ipProtocol: "tcp", fromPort: managementPort, toPort: managementPort,
        destinationSecurityGroupId: proxy.loadBalancerSecurityGroup.attrGroupId,
        description: `Model proxy management port ${managementPort} on the proxy load balancer`,
      });
      new ec2.CfnSecurityGroupIngress(this, `ProxyIngress${suffix}`, {
        groupId: proxy.loadBalancerSecurityGroup.attrGroupId,
        ipProtocol: "tcp", fromPort: managementPort, toPort: managementPort,
        sourceSecurityGroupId: this.securityGroup.attrGroupId,
        description: `Model proxy management port ${managementPort} from the model access function`,
      });
    }

    (handler.node.defaultChild as lambda.CfnFunction).vpcConfig = {
      subnetIds: props.subnetIds,
      securityGroupIds: [this.securityGroup.attrGroupId],
    };
    handler.role!.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"));
    handler.addEnvironment("MODEL_PROXY_URL", proxy.managementUrl);
    // With TLS the function is given https://<name>:8443: never before that listener and the name exist.
    for (const each of proxy.tlsReady) (handler.node.defaultChild as lambda.CfnFunction).addDependency(each);
    handler.addEnvironment("MODEL_PROXY_MASTER_KEY_SECRET_ARN", proxy.masterKeySecret.secretArn);
    handler.addToRolePolicy(new iam.PolicyStatement({
      sid: "ReadMasterKey",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [proxy.masterKeySecret.secretArn],
    }));
    // The Bedrock probe (checkSource) assumes a customer's role to test its trust policy. Company keys are not stored in Secrets
    // Manager (they live in the proxy's own store), so this function is given no way to create or change a secret.
    handler.addToRolePolicy(assumeOrgBedrockRoles(Stack.of(this)));
    // N8: the secret behind a company's model endpoint is read here, when the source is registered, and handed to the proxy's credential store. Only the prefix.
    if (props.customModelEndpoints === true) {
      handler.addToRolePolicy(modelEndpointSecretsStatement(Stack.of(this)));
      // The address of an endpoint is judged here, inside the VPC, with the resolver the proxy connects with.
      for (const [name, value] of Object.entries(props.customModelEndpointEnvironment ?? {})) handler.addEnvironment(name, value);
    }
  }
}

