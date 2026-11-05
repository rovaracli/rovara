// An OPTIONAL custom domain for the hosted Rovara cloud's control plane (0.5.7): `https://staging.rovara.dev` in front of the same HTTP API.
// Off by default (both parameters empty): no certificate, domain name, mapping or record exists and nothing the install runs changes.
//
// When both parameters are set the stack adds, and only adds:
//   - a regional ACM certificate for the name, validated by DNS in the given hosted zone (CloudFormation writes the validation record),
//   - an API Gateway v2 DomainName and the ApiMapping that sends the whole name to the API's `$default` stage,
//   - an alias A and AAAA record for the name, in the same hosted zone.
// The API's own `https://<id>.execute-api.<region>.amazonaws.com` address keeps answering exactly as before: the same API serves both names.
// The hosted zone is only ever written by these three records (and the validation record); nothing existing in it is read or changed here.
import { Fn, Token, aws_apigatewayv2 as apigwv2, aws_certificatemanager as acm, aws_route53 as route53, CfnCondition, CfnOutput, CfnParameter, CfnRule, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { CUSTOM_DOMAIN_NAME_PATTERN, CUSTOM_DOMAIN_ZONE_PATTERN } from "./custom-domain-patterns.js";


export interface CustomDomainProps {
  /** The HTTP API the name is mapped to. */
  api: apigwv2.CfnApi;
  /** Its `$default` stage: the mapping targets the stage by name, which also orders the mapping after it. */
  stage: apigwv2.CfnStage;
}

export class CustomDomain extends Construct {
  readonly name: CfnParameter;
  readonly hostedZoneId: CfnParameter;
  /** True only when both parameters are set. Every resource below exists only under it. */
  readonly enabled: CfnCondition;
  private readonly api: apigwv2.CfnApi;

  constructor(scope: Construct, id: string, props: CustomDomainProps) {
    super(scope, id);
    const stack = Stack.of(this);
    this.api = props.api;
    // Declared on the stack itself, so the parameter names are exactly these.
    this.name = new CfnParameter(stack, "CustomDomainName", {
      type: "String", default: "", allowedPattern: CUSTOM_DOMAIN_NAME_PATTERN, maxLength: 64,
      description: "A DNS name for the control plane, for example staging.rovara.dev; needs CustomDomainHostedZoneId. Empty keeps the API's own address as the only one",
    });
    this.hostedZoneId = new CfnParameter(stack, "CustomDomainHostedZoneId", {
      type: "String", default: "", allowedPattern: CUSTOM_DOMAIN_ZONE_PATTERN,
      description: "The Route 53 hosted zone (in this account) that holds CustomDomainName's DNS; the certificate's validation record and the name's alias records are written there. Needs CustomDomainName",
    });
    this.enabled = new CfnCondition(stack, "CustomDomainEnabled", {
      expression: Fn.conditionAnd(
        Fn.conditionNot(Fn.conditionEquals(this.name.valueAsString, "")),
        Fn.conditionNot(Fn.conditionEquals(this.hostedZoneId.valueAsString, "")),
      ),
    });
    // One without the other would silently do nothing (the condition above needs both): refuse it instead.
    new CfnRule(stack, "CustomDomainNeedsBothOrNeither", {
      assertions: [{
        assert: Fn.conditionOr(
          Fn.conditionAnd(Fn.conditionEquals(this.name.valueAsString, ""), Fn.conditionEquals(this.hostedZoneId.valueAsString, "")),
          Fn.conditionAnd(Fn.conditionNot(Fn.conditionEquals(this.name.valueAsString, "")), Fn.conditionNot(Fn.conditionEquals(this.hostedZoneId.valueAsString, ""))),
        ),
        assertDescription: "CustomDomainName and CustomDomainHostedZoneId go together: set both, or leave both empty",
      }],
    });

    const certificate = new acm.CfnCertificate(this, "Certificate", {
      domainName: this.name.valueAsString,
      validationMethod: "DNS",
      // HostedZoneId makes CloudFormation create the CNAME validation record itself (and remove it with the certificate).
      domainValidationOptions: [{ domainName: this.name.valueAsString, hostedZoneId: this.hostedZoneId.valueAsString }],
    });
    certificate.cfnOptions.condition = this.enabled;

    const domainName = new apigwv2.CfnDomainName(this, "DomainName", {
      domainName: this.name.valueAsString,
      domainNameConfigurations: [{ certificateArn: certificate.ref, endpointType: "REGIONAL", securityPolicy: "TLS_1_2", ipAddressType: "dualstack" }],
    });
    domainName.cfnOptions.condition = this.enabled;

    const mapping = new apigwv2.CfnApiMapping(this, "Mapping", { apiId: props.api.ref, domainName: domainName.ref, stage: props.stage.ref });
    mapping.cfnOptions.condition = this.enabled;

    for (const type of ["A", "AAAA"] as const) {
      const record = new route53.CfnRecordSet(this, `${type}Record`, {
        hostedZoneId: this.hostedZoneId.valueAsString,
        name: this.name.valueAsString,
        type,
        aliasTarget: { dnsName: domainName.attrRegionalDomainName, hostedZoneId: domainName.attrRegionalHostedZoneId, evaluateTargetHealth: false },
      });
      record.cfnOptions.condition = this.enabled;
    }

    // What an operator and the CLI read: the address people should use (the custom name when set, the API's own otherwise).
    new CfnOutput(stack, "PublicUrl", { value: this.origin(), description: "The address people and the agentx command use: the custom domain when it is set, the API's own address otherwise" });
  }

  /** The custom origin (`https://<name>`) under the condition, else `otherwise`. */
  private ifEnabled(custom: string, otherwise: string): string {
    return Token.asString(Fn.conditionIf(this.enabled.logicalId, custom, otherwise));
  }

  /** `https://<name>` when the domain is set, else the API's own address: where people and links should point. */
  origin(): string {
    return this.ifEnabled(Fn.join("", ["https://", this.name.valueAsString]), this.api.attrApiEndpoint);
  }

  /** `path` on the custom origin when the domain is set, else on the API's own address. */
  urlFor(path: string): string {
    return this.ifEnabled(Fn.join("", ["https://", this.name.valueAsString, path]), Fn.join("", [this.api.attrApiEndpoint, path]));
  }

  /** The sign-in server's issuer people see (`<origin>/v1/auth`). */
  issuer(): string {
    return this.urlFor("/v1/auth");
  }

  /** `https://<name>` when the domain is set, else empty: the one origin browser pages belong on (empty means every address is canonical). */
  canonicalOrigin(): string {
    return this.ifEnabled(Fn.join("", ["https://", this.name.valueAsString]), "");
  }

  /** The origins the API answers on: the custom one only when it is set (for CORS lists that must keep the API's own address). */
  extraOrigins(): string[] {
    return Token.asList(Fn.conditionIf(this.enabled.logicalId, [Fn.join("", ["https://", this.name.valueAsString]), this.api.attrApiEndpoint], [this.api.attrApiEndpoint]));
  }
}

