import { accountNumber } from "@/engine/ids";
import type { Args, CliContext, Command } from "./commands";

/**
 * The IAM actions and resources a CLI command needs. Commands can say exactly
 * (S3 does, since `aws s3 cp` may be an upload, a download or a copy); for the
 * rest the action is "<service>:<ApiName>" and the resource is worked out from
 * the ID options, e.g. --instance-ids → arn:aws:ec2:<region>:<account>:instance/i-….
 */

export interface Check {
  action: string;
  resource: string;
}

/** Calls that need no permission at all, as in AWS. */
const FREE = new Set(["sts:GetCallerIdentity"]);

const EC2_ID_OPTIONS: [string, string][] = [
  ["instance-ids", "instance"],
  ["instance-id", "instance"],
  ["vpc-id", "vpc"],
  ["subnet-id", "subnet"],
  ["internet-gateway-id", "internet-gateway"],
  ["route-table-id", "route-table"],
  ["group-id", "security-group"],
  ["allocation-id", "elastic-ip"],
  ["nat-gateway-id", "natgateway"],
  ["key-pair-id", "key-pair"],
  ["launch-template-id", "launch-template"],
  ["volume-id", "volume"],
  ["network-acl-id", "network-acl"],
  ["vpc-peering-connection-id", "vpc-peering-connection"],
  ["vpc-endpoint-id", "vpc-endpoint"],
  ["volume-ids", "volume"],
  ["snapshot-id", "snapshot"],
  ["snapshot-ids", "snapshot"],
];

const IAM_PREFIX: Record<string, string> = { elbv2: "elasticloadbalancing" };

/** Options holding ARNs that are the resource the action acts on. */
const ARN_OPTIONS = ["load-balancer-arn", "target-group-arn", "listener-arn"];

/** Actions that create or list: checked against "any resource of the kind". */
const COLLECTION = /^(Describe|Create|Allocate|Run|Get|List)/;

export function cliChecks(command: Command, args: Args, ctx: CliContext): Check[] {
  if (command.permissions) return command.permissions(args, ctx);
  // The CLI's command names and IAM's service prefixes differ for a few services.
  const prefix = IAM_PREFIX[command.service] ?? command.service;
  const action = `${prefix}:${command.apiName}`;
  if (FREE.has(action)) return [];
  const account = accountNumber(ctx.accountId);

  if (command.service === "ec2") {
    if (!COLLECTION.test(command.apiName)) {
      for (const [option, kind] of EC2_ID_OPTIONS) {
        const ids = args.list(option);
        // Snapshot ARNs have no account: arn:aws:ec2:<region>::snapshot/snap-….
        if (ids.length) return ids.map((id) => ({ action, resource: `arn:aws:ec2:${ctx.region}:${kind === "snapshot" ? "" : account}:${kind}/${id}` }));
      }
    }
    return [{ action, resource: "*" }];
  }

  if (command.service === "iam") {
    const named: [string, string][] = [
      ["user-name", "user"],
      ["group-name", "group"],
      ["role-name", "role"],
      ["policy-name", "policy"],
    ];
    const policyArn = args.one("policy-arn");
    // Attaching a policy is an action on the user/group/role; get/delete-policy act on the policy.
    for (const [option, kind] of named) {
      const name = args.one(option);
      if (name) return [{ action, resource: `arn:aws:iam::${account}:${kind}/${name}` }];
    }
    if (policyArn) return [{ action, resource: policyArn }];
    return [{ action, resource: "*" }];
  }

  if (command.service === "elbv2" && !COLLECTION.test(command.apiName)) {
    for (const option of ARN_OPTIONS) {
      const arn = args.one(option);
      if (arn) return [{ action, resource: arn }];
    }
  }

  if (command.service === "rds" && !/^Describe/.test(command.apiName)) {
    const named: [string, string][] = [
      ["db-instance-identifier", "db"],
      ["db-snapshot-identifier", "snapshot"],
      ["db-subnet-group-name", "subgrp"],
    ];
    // Snapshots and restores act on the snapshot; everything else on the database or group named first.
    const order = /Snapshot/.test(command.apiName) ? [named[1], named[0], named[2]] : named;
    for (const [option, kind] of order) {
      const name = args.one(option);
      if (name) return [{ action, resource: `arn:aws:rds:${ctx.region}:${account}:${kind}:${name.toLowerCase()}` }];
    }
  }

  if (command.service === "logs") {
    const group = args.one("log-group-name") ?? args.positionals[0];
    if (group && !/^Describe/.test(command.apiName)) return [{ action, resource: `arn:aws:logs:${ctx.region}:${account}:log-group:${group}` }];
  }

  if (command.service === "cloudwatch" && /Alarm/.test(command.apiName)) {
    const name = args.one("alarm-name") ?? args.list("alarm-names")[0];
    if (name) return [{ action, resource: `arn:aws:cloudwatch:${ctx.region}:${account}:alarm:${name}` }];
  }

  if (command.service === "lambda" && command.apiName !== "ListFunctions") {
    const name = args.one("function-name");
    if (name) {
      const fn = name.startsWith("arn:") ? name : `arn:aws:lambda:${ctx.region}:${account}:function:${name.split(":").pop()}`;
      return [{ action, resource: fn }];
    }
  }

  if (command.service === "sns") {
    // SNS permissions are on topics; a subscription's actions are checked against its topic.
    const topic = args.one("topic-arn") ?? args.one("target-arn") ?? args.one("subscription-arn")?.split(":").slice(0, 6).join(":");
    if (topic) return [{ action, resource: topic }];
    const name = args.one("name");
    if (name && command.apiName === "CreateTopic") return [{ action, resource: `arn:aws:sns:${ctx.region}:${account}:${name}` }];
  }

  if (command.service === "cloudformation") {
    const name = args.one("stack-name");
    if (name) return [{ action, resource: name.startsWith("arn:") ? name : `arn:aws:cloudformation:${ctx.region}:${account}:stack/${name}/*` }];
  }

  if (command.service === "dynamodb" && command.apiName !== "ListTables") {
    const name = args.one("table-name");
    if (name) {
      const index = args.one("index-name");
      return [{ action, resource: `arn:aws:dynamodb:${ctx.region}:${account}:table/${name}${index ? `/index/${index}` : ""}` }];
    }
  }

  if (command.service === "sqs") {
    const url = args.one("queue-url");
    const m = url ? /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/(\d{12})\/(.+)$/.exec(url.trim()) : null;
    if (m) return [{ action, resource: `arn:aws:sqs:${m[1]}:${m[2]}:${m[3]}` }];
    const name = args.one("queue-name");
    if (name) return [{ action, resource: `arn:aws:sqs:${ctx.region}:${account}:${name}` }];
  }

  if (command.service === "autoscaling" && !COLLECTION.test(command.apiName)) {
    const name = args.one("auto-scaling-group-name");
    if (name) return [{ action, resource: `arn:aws:autoscaling:${ctx.region}:${account}:autoScalingGroup:*:autoScalingGroupName/${name}` }];
  }

  return [{ action, resource: "*" }];
}
