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
];

/** Actions that create or list: checked against "any resource of the kind". */
const COLLECTION = /^(Describe|Create|Allocate|Run|Get|List)/;

export function cliChecks(command: Command, args: Args, ctx: CliContext): Check[] {
  if (command.permissions) return command.permissions(args, ctx);
  const action = `${command.service}:${command.apiName}`;
  if (FREE.has(action)) return [];
  const account = accountNumber(ctx.accountId);

  if (command.service === "ec2") {
    if (!COLLECTION.test(command.apiName)) {
      for (const [option, kind] of EC2_ID_OPTIONS) {
        const ids = args.list(option);
        if (ids.length) return ids.map((id) => ({ action, resource: `arn:aws:ec2:${ctx.region}:${account}:${kind}/${id}` }));
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

  return [{ action, resource: "*" }];
}
