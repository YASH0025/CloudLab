import { randomBytes } from "node:crypto";
import { availabilityZones } from "../catalog";
import type { Engine } from "../engine";
import { EngineError } from "../errors";
import { accountNumber } from "../ids";
import { addPermission, removePermission } from "../lambda/invoke";
import type { Resource } from "../types";
import type { Json } from "./template";

/**
 * The CloudFormation resource types CloudLab can create, and how each maps to
 * a console resource: its properties become the resource's settings, Ref and
 * Fn::GetAtt read its ID and attributes. A few types (a route, a gateway
 * attachment, a Lambda permission…) aren't resources of their own here: they
 * change another resource, and undo that when deleted.
 */

export interface HandlerContext {
  engine: Engine;
  accountId: string;
  region: string;
  stackName: string;
  logicalId: string;
}

type Props = Record<string, Json>;

export interface Handler {
  /** The console resource this becomes; absent for types that only change another resource. */
  service?: string;
  type?: string;
  props: string[];
  required?: string[];
  /** The property that names the resource, if any: a custom name can't be replaced in place. */
  nameProp?: string;
  /** Settings for the console resource. */
  config?(p: Props, c: HandlerContext): Promise<Record<string, unknown>> | Record<string, unknown>;
  ref(r: Resource): string;
  attrs?: Record<string, (r: Resource) => Json>;
  /** For types without a resource of their own. Returns the physical ID. */
  apply?(p: Props, c: HandlerContext): Promise<string>;
  undo?(physicalId: string, p: Props, c: HandlerContext): Promise<void>;
}

const suffix = () => randomBytes(9).toString("base64").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 12).padEnd(12, "X");

/** How CloudFormation names what you didn't name: stack-LogicalId-RANDOM, within the service's limit. */
export function generatedName(c: HandlerContext, max: number, lower = false) {
  const tail = `-${suffix()}`;
  const head = `${c.stackName}-${c.logicalId}`.slice(0, max - tail.length);
  const name = head + tail;
  return lower ? name.toLowerCase() : name;
}

const nameTag = (p: Props): string | undefined => {
  const tags = p.Tags as { Key: string; Value: string }[] | undefined;
  return Array.isArray(tags) ? tags.find((t) => t?.Key === "Name")?.Value : undefined;
};

const s = (v: Json | undefined) => (v === undefined || v === null ? undefined : String(v));
const n = (v: Json | undefined) => (v === undefined || v === null ? undefined : Number(v));
const b = (v: Json | undefined) => (v === undefined || v === null ? undefined : v === true || v === "true");
const list = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const json = (v: Json | undefined) => (v === undefined ? undefined : typeof v === "string" ? v : JSON.stringify(v));
const id = (r: Resource) => r.id;
const arnAttr = (r: Resource) => String(r.attributes.arn ?? r.id);

async function get(c: HandlerContext, id: string) {
  return c.engine.get(c.accountId, id);
}

const PROTOCOL: Record<string, string> = { tcp: "tcp", "6": "tcp", udp: "udp", "17": "udp", icmp: "icmp", "1": "icmp", "-1": "all", all: "all" };
const rules = (v: Json | undefined) =>
  list(v).map((x) => {
    const r = x as Props;
    const protocol = PROTOCOL[String(r.IpProtocol ?? "").toLowerCase()];
    if (!protocol) throw new EngineError("InvalidParameterValue", `Invalid value '${String(r.IpProtocol)}' for IP protocol. Unknown protocol.`);
    return {
      protocol,
      ...(protocol === "tcp" || protocol === "udp" ? { fromPort: n(r.FromPort), toPort: n(r.ToPort) } : {}),
      ...(r.CidrIp ? { cidr: s(r.CidrIp) } : {}),
      ...(r.SourceSecurityGroupId || r.DestinationSecurityGroupId ? { sourceGroupId: s(r.SourceSecurityGroupId ?? r.DestinationSecurityGroupId) } : {}),
      ...(r.Description ? { description: s(r.Description) } : {}),
    };
  });

const roleName = (arnOrName: string) => arnOrName.split("/").pop()!;

export const HANDLERS: Record<string, Handler> = {
  "AWS::EC2::VPC": {
    service: "networking",
    type: "vpc",
    props: ["CidrBlock", "EnableDnsHostnames", "EnableDnsSupport", "InstanceTenancy", "Tags"],
    required: ["CidrBlock"],
    config: (p) => ({ name: nameTag(p), cidrBlock: s(p.CidrBlock), enableDnsHostnames: b(p.EnableDnsHostnames) }),
    ref: id,
    attrs: { VpcId: id, CidrBlock: (r) => String(r.config.cidrBlock), CidrBlockAssociations: () => [] },
  },
  "AWS::EC2::Subnet": {
    service: "networking",
    type: "subnet",
    props: ["VpcId", "CidrBlock", "AvailabilityZone", "MapPublicIpOnLaunch", "Tags"],
    required: ["VpcId", "CidrBlock"],
    config: (p, c) => ({
      name: nameTag(p),
      vpcId: s(p.VpcId),
      cidrBlock: s(p.CidrBlock),
      availabilityZone: s(p.AvailabilityZone) ?? availabilityZones(c.region)[0],
      mapPublicIpOnLaunch: b(p.MapPublicIpOnLaunch),
    }),
    ref: id,
    attrs: { SubnetId: id, AvailabilityZone: (r) => String(r.config.availabilityZone), VpcId: (r) => String(r.config.vpcId), CidrBlock: (r) => String(r.config.cidrBlock) },
  },
  "AWS::EC2::InternetGateway": {
    service: "networking",
    type: "internet-gateway",
    props: ["Tags"],
    config: (p) => ({ name: nameTag(p) }),
    ref: id,
    attrs: { InternetGatewayId: id },
  },
  "AWS::EC2::VPCGatewayAttachment": {
    props: ["VpcId", "InternetGatewayId", "VpnGatewayId"],
    required: ["VpcId"],
    async apply(p, c) {
      if (!p.InternetGatewayId) throw new EngineError("InvalidParameterValue", "CloudLab simulates internet gateway attachments (InternetGatewayId), not VPN gateways.");
      await c.engine.update(c.accountId, String(p.InternetGatewayId), { vpcId: s(p.VpcId) });
      return `IGW|${String(p.VpcId)}`;
    },
    async undo(_id, p, c) {
      await c.engine.update(c.accountId, String(p.InternetGatewayId), { vpcId: undefined }).catch(() => undefined);
    },
    ref: (r) => r.id,
  },
  "AWS::EC2::RouteTable": {
    service: "networking",
    type: "route-table",
    props: ["VpcId", "Tags"],
    required: ["VpcId"],
    config: (p) => ({ name: nameTag(p), vpcId: s(p.VpcId), routes: [], subnetIds: [] }),
    ref: id,
    attrs: { RouteTableId: id },
  },
  "AWS::EC2::Route": {
    props: ["RouteTableId", "DestinationCidrBlock", "GatewayId", "NatGatewayId", "VpcPeeringConnectionId"],
    required: ["RouteTableId", "DestinationCidrBlock"],
    async apply(p, c) {
      const rt = await get(c, String(p.RouteTableId));
      const routes = (rt.config.routes as Record<string, unknown>[]) ?? [];
      const route = {
        destination: s(p.DestinationCidrBlock),
        ...(p.GatewayId ? { gatewayId: s(p.GatewayId) } : {}),
        ...(p.NatGatewayId ? { natGatewayId: s(p.NatGatewayId) } : {}),
        ...(p.VpcPeeringConnectionId ? { vpcPeeringConnectionId: s(p.VpcPeeringConnectionId) } : {}),
      };
      if (routes.some((r) => r.destination === route.destination)) {
        throw new EngineError("RouteAlreadyExists", `The route identified by ${route.destination} already exists.`);
      }
      await c.engine.update(c.accountId, rt.id, { routes: [...routes, route] });
      return `${rt.id}|${route.destination}`;
    },
    async undo(_id, p, c) {
      const rt = await get(c, String(p.RouteTableId)).catch(() => null);
      if (!rt) return;
      const routes = ((rt.config.routes as Record<string, unknown>[]) ?? []).filter((r) => r.destination !== p.DestinationCidrBlock);
      await c.engine.update(c.accountId, rt.id, { routes });
    },
    ref: (r) => r.id,
  },
  "AWS::EC2::SubnetRouteTableAssociation": {
    props: ["SubnetId", "RouteTableId"],
    required: ["SubnetId", "RouteTableId"],
    async apply(p, c) {
      const rt = await get(c, String(p.RouteTableId));
      const ids = (rt.config.subnetIds as string[]) ?? [];
      await c.engine.update(c.accountId, rt.id, { subnetIds: [...new Set([...ids, String(p.SubnetId)])] });
      return `rtbassoc-${randomBytes(8).toString("hex").slice(0, 17)}`;
    },
    async undo(_id, p, c) {
      const rt = await get(c, String(p.RouteTableId)).catch(() => null);
      if (!rt) return;
      await c.engine.update(c.accountId, rt.id, { subnetIds: ((rt.config.subnetIds as string[]) ?? []).filter((x) => x !== p.SubnetId) });
    },
    ref: (r) => r.id,
  },
  "AWS::EC2::SecurityGroup": {
    service: "networking",
    type: "security-group",
    props: ["GroupDescription", "GroupName", "VpcId", "SecurityGroupIngress", "SecurityGroupEgress", "Tags"],
    required: ["GroupDescription"],
    nameProp: "GroupName",
    config: async (p, c) => ({
      name: s(p.GroupName) ?? generatedName(c, 255),
      description: s(p.GroupDescription),
      vpcId: s(p.VpcId) ?? (await c.engine.defaultVpc(c.accountId, c.region))?.id,
      inboundRules: rules(p.SecurityGroupIngress),
      outboundRules: p.SecurityGroupEgress ? rules(p.SecurityGroupEgress) : [{ protocol: "all", cidr: "0.0.0.0/0" }],
    }),
    ref: id,
    attrs: { GroupId: id, VpcId: (r) => String(r.config.vpcId) },
  },
  "AWS::EC2::Instance": {
    service: "compute",
    type: "instance",
    props: ["ImageId", "InstanceType", "SubnetId", "SecurityGroupIds", "KeyName", "Tags", "UserData", "IamInstanceProfile"],
    required: ["ImageId"],
    config: async (p, c) => {
      let subnet = s(p.SubnetId);
      if (!subnet) {
        const vpc = await c.engine.defaultVpc(c.accountId, c.region);
        subnet = vpc ? (await c.engine.list(c.accountId, { service: "networking", type: "subnet", region: c.region })).find((x) => x.config.vpcId === vpc.id)?.id : undefined;
      }
      let groups = list(p.SecurityGroupIds).map(String);
      if (groups.length === 0 && subnet) {
        const sub = await get(c, subnet);
        const def = (await c.engine.list(c.accountId, { service: "networking", type: "security-group", region: c.region })).find(
          (g) => g.config.vpcId === sub.config.vpcId && (g.attributes.system as { isDefault?: boolean } | undefined)?.isDefault,
        );
        groups = def ? [def.id] : [];
      }
      return {
        name: nameTag(p),
        imageId: s(p.ImageId),
        // CloudFormation's default is m1.small, which CloudLab doesn't offer; t3.micro is the free-tier-like choice.
        instanceType: s(p.InstanceType) ?? "t3.micro",
        subnetId: subnet,
        securityGroupIds: groups,
        keyName: s(p.KeyName),
        iamRole: p.IamInstanceProfile ? roleName(String(p.IamInstanceProfile)) : undefined,
      };
    },
    ref: id,
    attrs: {
      PublicIp: (r) => String(r.attributes.publicIp ?? ""),
      PrivateIp: (r) => String(r.attributes.privateIp ?? ""),
      AvailabilityZone: (r) => String(r.attributes.availabilityZone ?? ""),
      InstanceId: id,
    },
  },
  "AWS::EC2::EIP": {
    service: "compute",
    type: "elastic-ip",
    props: ["Domain", "InstanceId", "Tags"],
    config: (p) => ({ name: nameTag(p), instanceId: s(p.InstanceId) }),
    ref: (r) => String(r.attributes.publicIp ?? r.id),
    attrs: { AllocationId: id, PublicIp: (r) => String(r.attributes.publicIp ?? "") },
  },
  "AWS::EC2::NatGateway": {
    service: "networking",
    type: "nat-gateway",
    props: ["SubnetId", "AllocationId", "Tags"],
    required: ["SubnetId", "AllocationId"],
    config: (p) => ({ name: nameTag(p), subnetId: s(p.SubnetId), allocationId: s(p.AllocationId) }),
    ref: id,
  },
  "AWS::S3::Bucket": {
    service: "storage",
    type: "bucket",
    props: ["BucketName", "VersioningConfiguration", "WebsiteConfiguration", "PublicAccessBlockConfiguration", "Tags"],
    nameProp: "BucketName",
    config: (p, c) => {
      const pab = p.PublicAccessBlockConfiguration as Props | undefined;
      const web = p.WebsiteConfiguration as Props | undefined;
      const status = (p.VersioningConfiguration as Props | undefined)?.Status;
      return {
        name: s(p.BucketName) ?? generatedName(c, 63, true).replace(/[^a-z0-9-]/g, "-"),
        versioning: status === "Enabled" ? "Enabled" : status === "Suspended" ? "Suspended" : undefined,
        blockPublicAccess: pab ? Object.values(pab).some((x) => x === true || x === "true") : undefined,
        websiteEnabled: web ? true : undefined,
        indexDocument: s(web?.IndexDocument),
        errorDocument: s(web?.ErrorDocument),
      };
    },
    ref: id,
    attrs: {
      Arn: (r) => `arn:aws:s3:::${r.id}`,
      DomainName: (r) => `${r.id}.s3.amazonaws.com`,
      RegionalDomainName: (r) => `${r.id}.s3.${r.region}.amazonaws.com`,
      WebsiteURL: (r) => `http://${r.id}.s3-website.${r.region}.cloudlab.local`,
    },
  },
  "AWS::SNS::Topic": {
    service: "sns",
    type: "topic",
    props: ["TopicName", "DisplayName", "Tags"],
    nameProp: "TopicName",
    config: (p, c) => ({ name: s(p.TopicName) ?? generatedName(c, 256), displayName: s(p.DisplayName) }),
    ref: id,
    attrs: { TopicArn: id, TopicName: (r) => r.name },
  },
  "AWS::SNS::Subscription": {
    service: "sns",
    type: "subscription",
    props: ["TopicArn", "Protocol", "Endpoint", "FilterPolicy", "RawMessageDelivery", "Region"],
    required: ["TopicArn", "Protocol"],
    config: (p) => ({
      topicArn: s(p.TopicArn),
      protocol: s(p.Protocol),
      endpoint: s(p.Endpoint),
      filterPolicy: json(p.FilterPolicy),
      rawMessageDelivery: b(p.RawMessageDelivery),
    }),
    ref: id,
  },
  "AWS::SQS::Queue": {
    service: "sqs",
    type: "queue",
    props: ["QueueName", "VisibilityTimeout", "MessageRetentionPeriod", "DelaySeconds", "ReceiveMessageWaitTimeSeconds", "MaximumMessageSize", "RedrivePolicy", "Tags"],
    nameProp: "QueueName",
    config: async (p, c) => {
      const rp = p.RedrivePolicy as Props | undefined;
      const dlqArn = s(rp?.deadLetterTargetArn);
      return {
        name: s(p.QueueName) ?? generatedName(c, 80),
        visibilityTimeout: n(p.VisibilityTimeout),
        messageRetentionPeriod: n(p.MessageRetentionPeriod),
        delaySeconds: n(p.DelaySeconds),
        receiveMessageWaitTimeSeconds: n(p.ReceiveMessageWaitTimeSeconds),
        maximumMessageSize: n(p.MaximumMessageSize),
        ...(dlqArn
          ? {
              deadLetterQueue: `https://sqs.${dlqArn.split(":")[3]}.amazonaws.com/${dlqArn.split(":")[4]}/${dlqArn.split(":")[5]}`,
              maxReceiveCount: n(rp?.maxReceiveCount),
            }
          : {}),
      };
    },
    ref: id,
    attrs: { Arn: arnAttr, QueueName: (r) => r.name, QueueUrl: id },
  },
  "AWS::SQS::QueuePolicy": {
    props: ["Queues", "PolicyDocument"],
    required: ["Queues", "PolicyDocument"],
    async apply(p, c) {
      for (const url of list(p.Queues)) await c.engine.update(c.accountId, String(url), { policy: json(p.PolicyDocument) });
      return `${c.stackName}-${c.logicalId}-${suffix()}`;
    },
    async undo(_id, p, c) {
      for (const url of list(p.Queues)) await c.engine.update(c.accountId, String(url), { policy: undefined }).catch(() => undefined);
    },
    ref: (r) => r.id,
  },
  "AWS::DynamoDB::Table": {
    service: "dynamodb",
    type: "table",
    props: ["TableName", "AttributeDefinitions", "KeySchema", "BillingMode", "ProvisionedThroughput", "GlobalSecondaryIndexes", "TimeToLiveSpecification", "DeletionProtectionEnabled", "Tags"],
    required: ["KeySchema"],
    nameProp: "TableName",
    config: (p, c) => {
      const defs = new Map(list(p.AttributeDefinitions).map((d) => [String((d as Props).AttributeName), String((d as Props).AttributeType)]));
      const key = (ks: Json | undefined, kind: string) => (list(ks).find((k) => (k as Props).KeyType === kind) as Props | undefined)?.AttributeName as string | undefined;
      const typeOf = (name: string | undefined) => {
        if (!name) return undefined;
        const t = defs.get(name);
        if (!t) throw new EngineError("ValidationException", "One or more parameter values were invalid: Some index key attributes are not defined in AttributeDefinitions. Keys: [" + name + "], AttributeDefinitions: [" + [...defs.keys()].join(", ") + "]");
        return t;
      };
      const pk = key(p.KeySchema, "HASH");
      const sk = key(p.KeySchema, "RANGE");
      const billing = s(p.BillingMode) ?? "PROVISIONED";
      const tp = p.ProvisionedThroughput as Props | undefined;
      if (billing === "PROVISIONED" && !tp) throw new EngineError("ValidationException", "One or more parameter values were invalid: ReadCapacityUnits and WriteCapacityUnits must both be specified when BillingMode is PROVISIONED");
      const ttl = p.TimeToLiveSpecification as Props | undefined;
      return {
        name: s(p.TableName) ?? generatedName(c, 255),
        partitionKey: pk,
        partitionKeyType: typeOf(pk),
        sortKey: sk,
        sortKeyType: typeOf(sk),
        billingMode: billing,
        ...(tp ? { readCapacity: n(tp.ReadCapacityUnits), writeCapacity: n(tp.WriteCapacityUnits) } : {}),
        globalSecondaryIndexes: list(p.GlobalSecondaryIndexes).map((g) => {
          const gp = g as Props;
          const gpk = key(gp.KeySchema, "HASH");
          const gsk = key(gp.KeySchema, "RANGE");
          return { indexName: s(gp.IndexName), partitionKey: gpk, partitionKeyType: typeOf(gpk), sortKey: gsk, sortKeyType: typeOf(gsk) };
        }),
        ttlAttribute: ttl && b(ttl.Enabled) ? s(ttl.AttributeName) : undefined,
        deletionProtection: b(p.DeletionProtectionEnabled),
      };
    },
    ref: (r) => r.name,
    attrs: { Arn: id },
  },
  "AWS::IAM::Role": {
    service: "iam",
    type: "role",
    props: ["RoleName", "AssumeRolePolicyDocument", "ManagedPolicyArns", "Description", "Path", "Tags", "Policies", "MaxSessionDuration"],
    required: ["AssumeRolePolicyDocument"],
    nameProp: "RoleName",
    config: (p, c) => {
      if (p.Policies) throw new EngineError("ValidationError", "CloudLab doesn't simulate inline Policies on roles yet: use ManagedPolicyArns (AWS managed policies, or an AWS::IAM::ManagedPolicy you create).");
      return { name: s(p.RoleName) ?? generatedName(c, 64), trustPolicy: json(p.AssumeRolePolicyDocument), policyArns: list(p.ManagedPolicyArns).map(String), description: s(p.Description) };
    },
    ref: (r) => r.name,
    attrs: { Arn: (r) => String(r.attributes.arn ?? `arn:aws:iam::${accountNumber(r.accountId)}:role/${r.name}`), RoleId: (r) => String(r.attributes.roleId ?? r.id) },
  },
  "AWS::Lambda::Function": {
    service: "lambda",
    type: "function",
    props: ["FunctionName", "Runtime", "Handler", "Role", "Code", "MemorySize", "Timeout", "Environment", "Description", "Architectures", "Tags"],
    required: ["Role", "Code"],
    nameProp: "FunctionName",
    config: (p, c) => {
      const code = p.Code as Props;
      if (!code?.ZipFile) throw new EngineError("InvalidParameterValueException", "CloudLab supports inline code (Code: ZipFile: |) for functions in templates; S3Bucket/S3Key uploads aren't simulated yet.");
      const runtime = s(p.Runtime) ?? "nodejs22.x";
      const file = runtime.startsWith("python") ? "index.py" : "index.js";
      return {
        name: s(p.FunctionName) ?? generatedName(c, 64),
        runtime,
        handler: s(p.Handler) ?? "index.handler",
        role: roleName(String(p.Role)),
        files: { [file]: String(code.ZipFile) },
        memorySize: n(p.MemorySize),
        timeout: n(p.Timeout),
        description: s(p.Description),
        environment: Object.entries(((p.Environment as Props | undefined)?.Variables as Props | undefined) ?? {}).map(([key, value]) => ({ key, value: String(value) })),
        architecture: s(list(p.Architectures)[0]),
      };
    },
    ref: (r) => r.name,
    attrs: { Arn: id },
  },
  "AWS::Lambda::Permission": {
    props: ["FunctionName", "Action", "Principal", "SourceArn", "SourceAccount"],
    required: ["FunctionName", "Action", "Principal"],
    async apply(p, c) {
      const name = String(p.FunctionName).split(":").pop()!;
      const fn = (await c.engine.list(c.accountId, { service: "lambda", type: "function", region: c.region })).find((f) => f.name === name || f.id === p.FunctionName);
      if (!fn) throw new EngineError("ResourceNotFoundException", `Function not found: ${String(p.FunctionName)}`);
      const sid = `${c.stackName}-${c.logicalId}-${suffix()}`.slice(0, 100);
      await addPermission(c.engine, c.accountId, fn, { statementId: sid, action: String(p.Action), principal: String(p.Principal), sourceArn: s(p.SourceArn) });
      return sid;
    },
    async undo(sid, p, c) {
      const name = String(p.FunctionName).split(":").pop()!;
      const fn = (await c.engine.list(c.accountId, { service: "lambda", type: "function", region: c.region })).find((f) => f.name === name || f.id === p.FunctionName);
      if (fn) await removePermission(c.engine, c.accountId, fn, sid).catch(() => undefined);
    },
    ref: (r) => r.id,
  },
  "AWS::Logs::LogGroup": {
    service: "logs",
    type: "log-group",
    props: ["LogGroupName", "RetentionInDays", "Tags"],
    nameProp: "LogGroupName",
    config: (p, c) => ({ name: s(p.LogGroupName) ?? generatedName(c, 512), retentionInDays: p.RetentionInDays !== undefined ? String(p.RetentionInDays) : undefined }),
    ref: (r) => r.name,
    attrs: { Arn: (r) => `${r.id}:*` },
  },
  "AWS::CloudWatch::Alarm": {
    service: "cloudwatch",
    type: "alarm",
    props: ["AlarmName", "AlarmDescription", "Namespace", "MetricName", "Dimensions", "Statistic", "Period", "EvaluationPeriods", "DatapointsToAlarm", "Threshold", "ComparisonOperator", "TreatMissingData", "AlarmActions", "OKActions", "ActionsEnabled"],
    required: ["ComparisonOperator", "EvaluationPeriods"],
    nameProp: "AlarmName",
    config: (p, c) => ({
      name: s(p.AlarmName) ?? generatedName(c, 255),
      description: s(p.AlarmDescription),
      namespace: s(p.Namespace),
      metricName: s(p.MetricName),
      dimensions: list(p.Dimensions).map((d) => ({ name: s((d as Props).Name), value: s((d as Props).Value) })),
      statistic: s(p.Statistic),
      period: n(p.Period),
      evaluationPeriods: n(p.EvaluationPeriods),
      datapointsToAlarm: n(p.DatapointsToAlarm),
      threshold: n(p.Threshold),
      comparisonOperator: s(p.ComparisonOperator),
      treatMissingData: s(p.TreatMissingData),
      alarmActions: list(p.AlarmActions).map(String),
      okActions: list(p.OKActions).map(String),
      actionsEnabled: b(p.ActionsEnabled),
    }),
    ref: (r) => r.name,
    attrs: { Arn: id },
  },
};

export const SUPPORTED_TYPES = Object.keys(HANDLERS);
