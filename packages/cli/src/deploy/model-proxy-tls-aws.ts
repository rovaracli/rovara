// MODEL-PROXY-TLS: the read-only AWS reads behind the pre-deploy checks of model-proxy-tls.ts (the control plane's ModelProxyUrl output, the worker URL parameter and when it changed,
// the install's running worker instances) and the public DNS lookups. Nothing here writes.
import { resolveCaa, resolveNs } from "node:dns/promises";
import { DescribeInstancesCommand, type EC2Client } from "@aws-sdk/client-ec2";
import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { environmentStackName } from "@rovara-code/contracts";
import type { StackOutputs } from "./deployer.js";
import { workerModelProxyUrlParameter, type DnsLookups, type ModelProxyTlsState } from "./model-proxy-tls.js";

/** The worker instances' tags, as the destroy command finds them (destroy/aws.ts). */
const workerFilters = (env: string) => [
  { Name: "tag:DeploymentMode", Values: ["ec2-ebs"] }, { Name: "tag:Environment", Values: [env] }, { Name: "tag:agentx:env", Values: [env] },
  { Name: "instance-state-name", Values: ["pending", "running"] },
];
/** At most this many pages of instances are read (a bound; an install far beyond it is refused by the caller's fail-closed check). */
const MAX_PAGES = 50;

export function awsModelProxyTlsState(clients: { /** Absent: the caller knows the deployed output itself. */ outputs?: (stackName: string) => Promise<StackOutputs | undefined>; ssm: Pick<SSMClient, "send">; ec2: Pick<EC2Client, "send"> }): (env: string, options: { workers: boolean }) => Promise<ModelProxyTlsState> {
  return async (env, options) => {
    const deployedUrl = clients.outputs === undefined ? undefined : (await clients.outputs(environmentStackName(env, "control-plane")))?.ModelProxyUrl;
    let urlParameter: ModelProxyTlsState["urlParameter"];
    try {
      const answer = await clients.ssm.send(new GetParameterCommand({ Name: workerModelProxyUrlParameter(env) }));
      if (answer.Parameter?.Value !== undefined && answer.Parameter.LastModifiedDate !== undefined) urlParameter = { value: answer.Parameter.Value, lastModified: answer.Parameter.LastModifiedDate };
    } catch (error) {
      if (!(error instanceof Error && error.name === "ParameterNotFound")) throw error;
    }
    const workers: Array<{ id: string; launchTime: Date }> = [];
    let token: string | undefined;
    // Only when the deploy drops the legacy listeners (L1) are the workers read.
    for (let page = 0; options.workers && page < MAX_PAGES; page += 1) {
      const answer = await clients.ec2.send(new DescribeInstancesCommand({ Filters: workerFilters(env), ...(token === undefined ? {} : { NextToken: token }) }));
      for (const reservation of answer.Reservations ?? []) for (const instance of reservation.Instances ?? []) {
        if (instance.InstanceId !== undefined && instance.LaunchTime !== undefined) workers.push({ id: instance.InstanceId, launchTime: instance.LaunchTime });
      }
      token = answer.NextToken;
      if (token === undefined) break;
    }
    if (token !== undefined) throw new Error(`more than ${MAX_PAGES} pages of worker instances; the model proxy TLS check could not read them all`);
    return { deployedUrl, urlParameter, workers };
  };
}

/** Public DNS through the system resolver. */
export const systemDnsLookups: DnsLookups = { resolveNs, resolveCaa };
