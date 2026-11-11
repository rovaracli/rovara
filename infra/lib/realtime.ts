// Realtime change notices (Plan 5 Task 8): an AppSync Events API, `agentx-<env>-realtime`, with one channel namespace, `rovara`. Clients connect and subscribe with a
// short-lived token that a Lambda authorizer checks; only the broker and the outbox publisher publish, over IAM (SigV4), and only to the namespace. Named environments
// only; the legacy install has no events API. API logging is off: a channel's name and a notice's content are ids, and nothing is gained by keeping them in a log.
import type { aws_dynamodb as dynamodb} from "aws-cdk-lib";
import { Duration, Fn, aws_appsync as appsync, aws_iam as iam, type aws_kms as kms, type aws_lambda_nodejs as lambdaNodejs } from "aws-cdk-lib";
import { Construct } from "constructs";
import { REALTIME_NAMESPACE } from "@agentx/cloud-contracts";
import { packagedFunction } from "./control-plane.js";

export interface RealtimeEventsProps {
  env: string;
  /** The State table the authorizer reads sessions, shares, grants and Task People entries from. */
  state: dynamodb.Table;
  /** The developer token key: the authorizer reads its public half to verify a realtime token (and may do nothing else with it). */
  tokenKey: kms.IKey;
  /** Lets the authorizer's role read the token key's public half, which the key's own policy otherwise reserves for the sign-in function. */
  allowPublicKeyRead: (role: iam.IRole) => void;
}

export class RealtimeEvents extends Construct {
  readonly api: appsync.EventApi;
  readonly authorizer: lambdaNodejs.NodejsFunction;
  /** The namespace's ARN: the one resource a publisher may publish to. */
  readonly namespaceArn: string;

  constructor(scope: Construct, id: string, props: RealtimeEventsProps) {
    super(scope, id);
    this.authorizer = packagedFunction(this, "Authorizer", "packages/broker/src/realtime/authorizer.ts", {
      STATE_TABLE_NAME: props.state.tableName,
      DEVELOPER_TOKEN_KEY_ARN: props.tokenKey.keyArn,
    }, Duration.seconds(10));
    // Exactly what it reads: sessions, shares, followers' grants, Task People entries and the org's catalog by key or one partition, and the token key's public half.
    this.authorizer.addToRolePolicy(new iam.PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:Query"], resources: [props.state.tableArn] }));
    this.authorizer.addToRolePolicy(new iam.PolicyStatement({ actions: ["kms:GetPublicKey"], resources: [props.tokenKey.keyArn] }));
    props.allowPublicKeyRead(this.authorizer.role!);

    this.api = new appsync.EventApi(this, "Api", {
      apiName: `agentx-${props.env}-realtime`,
      authorizationConfig: {
        authProviders: [
          { authorizationType: appsync.AppSyncAuthorizationType.LAMBDA, lambdaAuthorizerConfig: { handler: this.authorizer, resultsCacheTtl: Duration.seconds(0) } },
          { authorizationType: appsync.AppSyncAuthorizationType.IAM },
        ],
        connectionAuthModeTypes: [appsync.AppSyncAuthorizationType.LAMBDA],
        defaultPublishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM],
        defaultSubscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.LAMBDA],
      },
    });
    const namespace = this.api.addChannelNamespace("Namespace", {
      channelNamespaceName: REALTIME_NAMESPACE,
      authorizationConfig: { publishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM], subscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.LAMBDA] },
    });
    this.namespaceArn = namespace.channelNamespaceArn;
    // The API's own construct lets `appsync.amazonaws.com` invoke the authorizer, for this API's ARN only.
  }

  /**
   * The first label of the API's DNS names (its `Dns.Http` host, `<prefix>.appsync-api.<region>.amazonaws.com`; `Dns.Realtime` has the same prefix). It is not the API's id:
   * a host built from the id does not resolve (staging 0.4.3). The broker is given this and builds both addresses from it.
   */
  get dnsPrefix(): string {
    return Fn.select(0, Fn.split(".", this.api.httpDns));
  }

  /** The HTTP endpoint publishers post to. */
  get httpEndpoint(): string {
    return `https://${this.api.httpDns}/event`;
  }

  /** `appsync:EventPublish` on the namespace, and nothing else. */
  grantPublish(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ["appsync:EventPublish"], resources: [this.namespaceArn] }));
  }
}
