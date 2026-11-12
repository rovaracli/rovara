import {
  Aws,
  CfnOutput,
  type CfnTag,
  Fn,
  RemovalPolicy,
  Validations,
  aws_ec2 as ec2,
  aws_iam as iam,
  type aws_kms as kms,
  aws_logs as logs,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { environmentRolePath } from "@rovara-code/contracts";
import type { AgentXNaming } from "./naming.js";

/** The worker's HTTP port: /ping for health probes, /invocations for signed work (#80). */
export const EC2_WORKER_PORT = 8080;
/** Amazon Linux 2023 for arm64, resolved when each instance launches. The boot script installs Docker. */
export const EC2_WORKER_AMI_PARAMETER = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64";
/** Holds the OS, Docker and the worker image; the workspace lives on its own volume. */
export const EC2_WORKER_ROOT_VOLUME_GIB = 30;

export interface Ec2WorkerFoundationProps {
  naming: AgentXNaming;
  vpcId: string;
  privateSubnets: readonly ec2.CfnSubnet[];
  workspaceKey: kms.IKey;
  instanceType: string;
  /**
   * Enterprise installs (task N1): the address ranges the workers, the dispatcher and the session manager may reach over HTTPS: the VPC's own range (the interface
   * endpoints) and the ranges the customer approved. Absent: the HTTPS egress to the whole internet every other install has, unchanged.
   */
  privateEgressCidrs?: readonly string[];
  /**
   * Owner decision 123 (review H1): extra TCP ports workers may open toward the install's routed private ranges (never its own VPC), for a company's approved internal addresses. Enterprise only, from
   * `rovaraPrivateAddressPorts` (private-addresses.ts). Absent: the group is exactly as before.
   */
  privateAddressEgress?: { cidrs: readonly string[]; ports: readonly number[] };
}

/**
 * What self-managed EC2 workers need from the foundation (issue #82, design in #76): the launch
 * template, the instance role, the worker security group and the security groups of the two
 * callers allowed to reach it, and the worker log group. Instances are launched by the session
 * provisioner (#83), which passes the subnet and the boot script as user data per launch.
 */
export class Ec2WorkerFoundation extends Construct {
  readonly workerSecurityGroup: ec2.CfnSecurityGroup;
  readonly dispatcherSecurityGroup: ec2.CfnSecurityGroup;
  readonly sessionManagerSecurityGroup: ec2.CfnSecurityGroup;
  readonly launchTemplate: ec2.CfnLaunchTemplate;
  readonly instanceRole: iam.Role;

  constructor(scope: Construct, id: string, props: Ec2WorkerFoundationProps) {
    super(scope, id);
    const { naming } = props;
    const names = naming.ec2;
    const tags = (name: string): CfnTag[] => [
      { key: "Name", value: name },
      { key: "Application", value: "AgentX" },
      { key: "DeploymentMode", value: "ec2-ebs" },
      { key: "Environment", value: naming.environmentTagValue },
      ...(naming.env === undefined ? [] : [{ key: "agentx:env", value: naming.env }]),
    ];

    // Workers take no ingress but the worker port, and only from the two callers below.
    this.workerSecurityGroup = new ec2.CfnSecurityGroup(this, "WorkerSecurityGroup", {
      groupDescription: `AgentX EC2 workers: port ${EC2_WORKER_PORT} from the dispatcher and session manager only, HTTPS egress`,
      groupName: names.workerSecurityGroupName,
      securityGroupEgress: [
        ...egressRules(props.privateEgressCidrs, "HTTPS to ECR, Bedrock, CloudWatch, the control plane, package repositories and Git providers"),
        ...(props.privateAddressEgress?.ports ?? []).flatMap((port) => (props.privateAddressEgress?.cidrs ?? []).map((cidr): ec2.CfnSecurityGroup.EgressProperty => ({ ipProtocol: "tcp", fromPort: port, toPort: port, cidrIp: cidr, description: `Approved internal addresses: port ${String(port)} to ${cidr}` }))),
      ],
      tags: tags(names.workerSecurityGroupName),
      vpcId: props.vpcId,
    });
    // The dispatcher (#84) posts signed invocations; the session manager's Lambdas (#83, #85, #86) probe /ping.
    this.dispatcherSecurityGroup = this.callerSecurityGroup("DispatcherSecurityGroup", names.dispatcherSecurityGroupName,
      "AgentX dispatcher: signed invocations to EC2 workers, HTTPS to AWS APIs", props.vpcId, tags, props.privateEgressCidrs);
    this.sessionManagerSecurityGroup = this.callerSecurityGroup("SessionManagerSecurityGroup", names.sessionManagerSecurityGroupName,
      "AgentX session manager Lambdas: health probes to EC2 workers, HTTPS to AWS APIs", props.vpcId, tags, props.privateEgressCidrs);

    const logGroup = new logs.LogGroup(this, "WorkerLogs", {
      logGroupName: names.workerLogGroupName,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // The worker execution role can pull the worker image and write container logs; in the legacy
    // deployment it can also call Bedrock models.
    this.instanceRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } },
      }),
      description: `AgentX ${naming.environmentTagValue} EC2 worker instances`,
    });
    // The legacy deployment's role is unchanged (ruling R58): its worker image is not derived from a parameter here.
    if (naming.env === undefined) {
      this.instanceRole.addToPolicy(new iam.PolicyStatement({
        sid: "EcrImageAccess",
        actions: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        resources: [`arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/*`],
      }));
    }
    this.instanceRole.addToPolicy(new iam.PolicyStatement({
      sid: "EcrTokenAccess",
      actions: ["ecr:GetAuthorizationToken"],
      resources: ["*"],
    }));
    // A named environment's worker role reads its one worker image through a policy the runtime stack attaches, which names
    // exactly that image's repository (infra/lib/worker-settings.ts): never repository/*, and no statement here.
    // A named environment's workers call models through the model proxy, the only principal with Bedrock access
    // (Task 14); the legacy deployment's workers still call Bedrock themselves.
    if (naming.env === undefined) {
      this.instanceRole.addToPolicy(new iam.PolicyStatement({
        sid: "BedrockModelInvocation",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          `arn:${Aws.PARTITION}:bedrock:*::foundation-model/*`,
          `arn:${Aws.PARTITION}:bedrock:${Aws.REGION}:${Aws.ACCOUNT_ID}:*`,
        ],
      }));
    }
    this.instanceRole.addToPolicy(new iam.PolicyStatement({
      sid: "WorkerLogs",
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:log-stream:*`],
    }));
    // Under the environment's IAM path like its roles, which its CloudFormation role is scoped to.
    const instanceProfile = new iam.CfnInstanceProfile(this, "InstanceProfile", {
      ...(naming.env === undefined ? {} : { path: environmentRolePath(naming.env) }),
      roles: [this.instanceRole.roleName],
    });

    this.launchTemplate = new ec2.CfnLaunchTemplate(this, "LaunchTemplate", {
      launchTemplateName: names.launchTemplateName,
      launchTemplateData: {
        imageId: `resolve:ssm:${EC2_WORKER_AMI_PARAMETER}`,
        instanceType: props.instanceType,
        iamInstanceProfile: { arn: instanceProfile.attrArn },
        securityGroupIds: [this.workerSecurityGroup.attrGroupId],
        // IMDSv2 only, one hop: a container on a Docker bridge is a hop further and cannot reach the instance role. A named
        // environment's worker runs on a bridge too, and boot.sh also rejects 169.254.169.254 for every container and every
        // non-root host process (R56); only the legacy worker, which calls Bedrock, still shares the host network.
        metadataOptions: {
          httpEndpoint: "enabled",
          httpTokens: "required",
          httpPutResponseHopLimit: 1,
          instanceMetadataTags: "disabled",
          // Named environments only (ruling R58): boot.sh closes 169.254.169.254, so the IPv6 endpoint stays off.
          ...(naming.env === undefined ? {} : { httpProtocolIpv6: "disabled" }),
        },
        blockDeviceMappings: [{
          deviceName: "/dev/xvda",
          ebs: {
            volumeSize: EC2_WORKER_ROOT_VOLUME_GIB,
            volumeType: "gp3",
            encrypted: true,
            kmsKeyId: props.workspaceKey.keyArn,
            deleteOnTermination: true,
          },
        }],
        monitoring: { enabled: true },
        // Idle stop terminates the instance (the workspace lives on its own volume), so a shutdown
        // from inside must not leave a stopped instance behind.
        instanceInitiatedShutdownBehavior: "terminate",
        tagSpecifications: [
          { resourceType: "instance", tags: tags(`${naming.resourcePrefix}-worker`) },
          { resourceType: "volume", tags: tags(`${naming.resourcePrefix}-worker-root`) },
        ],
      },
      tagSpecifications: [{ resourceType: "launch-template", tags: tags(names.launchTemplateName) }],
    });

    Validations.of(this.launchTemplate).acknowledge({
      id: "CloudFormation-Validate::E1152",
      reason: "EC2 resolves a resolve:ssm: image ID when each instance launches, so the AMI stays current",
    });

    new CfnOutput(scope, "Ec2WorkerLaunchTemplateId", { value: this.launchTemplate.ref });
    new CfnOutput(scope, "Ec2WorkerSecurityGroupId", { value: this.workerSecurityGroup.attrGroupId });
    new CfnOutput(scope, "DispatcherSecurityGroupId", { value: this.dispatcherSecurityGroup.attrGroupId });
    new CfnOutput(scope, "SessionManagerSecurityGroupId", { value: this.sessionManagerSecurityGroup.attrGroupId });
    new CfnOutput(scope, "Ec2WorkerInstanceRoleArn", { value: this.instanceRole.roleArn });
    new CfnOutput(scope, "Ec2WorkerInstanceProfileArn", { value: instanceProfile.attrArn });
    new CfnOutput(scope, "Ec2WorkerLogGroupName", { value: logGroup.logGroupName });
    // availabilityZone=subnetId pairs, as an ec2-ebs runtime binding lists them.
    new CfnOutput(scope, "Ec2WorkerSubnets", {
      value: Fn.join(",", props.privateSubnets.map((subnet) => Fn.join("=", [subnet.attrAvailabilityZone, subnet.ref]))),
    });
  }

  private callerSecurityGroup(
    id: string,
    name: string,
    description: string,
    vpcId: string,
    tags: (name: string) => CfnTag[],
    privateEgressCidrs?: readonly string[],
  ): ec2.CfnSecurityGroup {
    const group = new ec2.CfnSecurityGroup(this, id, {
      groupDescription: description,
      groupName: name,
      securityGroupEgress: egressRules(privateEgressCidrs, "HTTPS to DynamoDB, SQS, KMS, EC2 and Step Functions APIs"),
      tags: tags(name),
      vpcId,
    });
    // Separate rule resources, so neither group's definition refers to the other.
    new ec2.CfnSecurityGroupEgress(this, `${id}ToWorkers`, {
      groupId: group.attrGroupId,
      ipProtocol: "tcp",
      fromPort: EC2_WORKER_PORT,
      toPort: EC2_WORKER_PORT,
      destinationSecurityGroupId: this.workerSecurityGroup.attrGroupId,
      description: `Worker port ${EC2_WORKER_PORT}`,
    });
    new ec2.CfnSecurityGroupIngress(this, `WorkersFrom${id}`, {
      groupId: this.workerSecurityGroup.attrGroupId,
      ipProtocol: "tcp",
      fromPort: EC2_WORKER_PORT,
      toPort: EC2_WORKER_PORT,
      sourceSecurityGroupId: group.attrGroupId,
      description: `Worker port ${EC2_WORKER_PORT} from ${name}`,
    });
    return group;
  }
}

function httpsEgress(description: string): ec2.CfnSecurityGroup.EgressProperty {
  return { ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIp: "0.0.0.0/0", description };
}

/** HTTPS to the whole internet (every install but an Enterprise one), or HTTPS to the listed ranges only. */
function egressRules(privateCidrs: readonly string[] | undefined, description: string): ec2.CfnSecurityGroup.EgressProperty[] {
  if (privateCidrs === undefined) return [httpsEgress(description)];
  if (privateCidrs.some((cidr) => cidr === "0.0.0.0/0" || cidr.endsWith("/0"))) throw new Error("an Enterprise install's security groups never allow the whole internet");
  // Each range once: a repeated one (a routed range equal to the install's own) would be a duplicate rule, which CloudFormation refuses.
  return [...new Set(privateCidrs)].map((cidr) => ({ ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIp: cidr, description: `HTTPS to ${cidr} only` }));
}
