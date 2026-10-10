import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { resolvePrincipal, type Identity } from "@/engine/iam/authorize";
import { parsePolicy } from "@/engine/iam/policy";
import { accountNumber } from "@/engine/ids";
import { MemoryStore } from "@/engine/store";
import { executeCli } from "./execute";

const ACCOUNT = "acct-iam";
const ACCT = accountNumber(ACCOUNT);
let engine: Engine;
let clock: Date;

/** Runs a command as root, or as an IAM user/role. */
async function run(line: string, as?: Identity) {
  const principal = as ? await resolvePrincipal(engine, ACCOUNT, as) : undefined;
  return executeCli(line, { engine, accountId: ACCOUNT, region: "us-east-1", principal });
}
async function ok(line: string, as?: Identity) {
  const r = await run(line, as);
  if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
  return r.output ? JSON.parse(r.output) : {};
}
async function fails(line: string, as?: Identity) {
  const r = await run(line, as);
  expect(r.exitCode, r.output).toBe(254);
  const m = /\(([^)]+)\) when calling the (\w+) operation: (.*)/.exec(r.output)!;
  return { code: m[1], operation: m[2], message: m[3] };
}
const dev: Identity = { kind: "user", name: "dev" };

beforeEach(() => {
  clock = new Date("2026-01-01T00:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("policy documents", () => {
  it("validates like IAM", () => {
    expect(() => parsePolicy("{oops")).toThrow("The policy failed legacy parsing");
    expect(() => parsePolicy({ Statement: [{ Effect: "Allow", Resource: "*" }] })).toThrow("Policy statement must contain actions.");
    expect(() => parsePolicy({ Statement: [{ Effect: "Allow", Action: "s3:GetObject" }] })).toThrow("Policy statement must contain resources.");
    expect(() => parsePolicy({ Statement: [{ Effect: "Allow", Action: "GetObject", Resource: "*" }] })).toThrow(
      "Actions/Conditions must be prefaced by a vendor",
    );
    expect(() => parsePolicy({ Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:*", Resource: "*" }] })).toThrow(
      "Policy document should not specify a principal.",
    );
  });
});

describe("IAM users, groups and permissions", () => {
  it("denies by default, allows through a group, and an explicit Deny wins", async () => {
    expect((await ok("aws iam create-user --user-name dev")).User).toMatchObject({ UserName: "dev", Arn: `arn:aws:iam::${ACCT}:user/dev` });
    expect((await fails("aws iam create-user --user-name dev")).code).toBe("EntityAlreadyExists");

    // A brand-new user can't do anything.
    const denied = await fails("aws ec2 describe-vpcs", dev);
    expect(denied).toEqual({
      code: "UnauthorizedOperation",
      operation: "DescribeVpcs",
      message: `You are not authorized to perform this operation. User: arn:aws:iam::${ACCT}:user/dev is not authorized to perform: ec2:DescribeVpcs on resource: * because no identity-based policy allows the ec2:DescribeVpcs action`,
    });
    // ...except ask who it is.
    expect((await ok("aws sts get-caller-identity", dev)).Arn).toBe(`arn:aws:iam::${ACCT}:user/dev`);

    await ok("aws iam create-group --group-name readers");
    await ok("aws iam attach-group-policy --group-name readers --policy-arn arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess");
    await ok("aws iam add-user-to-group --group-name readers --user-name dev");
    await ok("aws ec2 describe-vpcs", dev);
    expect((await fails("aws ec2 create-vpc --cidr-block 10.0.0.0/16", dev)).code).toBe("UnauthorizedOperation");

    // S3 says AccessDenied, with the bucket's ARN in quotes.
    expect(await fails("aws s3api create-bucket --bucket dev-bucket-1", dev)).toEqual({
      code: "AccessDenied",
      operation: "CreateBucket",
      message: `User: arn:aws:iam::${ACCT}:user/dev is not authorized to perform: s3:CreateBucket on resource: "arn:aws:s3:::dev-bucket-1" because no identity-based policy allows the s3:CreateBucket action`,
    });

    // A customer policy with an explicit Deny beats the group's Allow.
    const deny = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "ec2:Describe*", Resource: "*" }] });
    const p = (await ok(`aws iam create-policy --policy-name no-describe --policy-document '${deny}'`)).Policy;
    expect(p).toMatchObject({ Arn: `arn:aws:iam::${ACCT}:policy/no-describe`, DefaultVersionId: "v1", AttachmentCount: 0 });
    await ok(`aws iam attach-user-policy --user-name dev --policy-arn ${p.Arn}`);
    expect((await fails("aws ec2 describe-vpcs", dev)).message).toContain("with an explicit deny in an identity-based policy");

    // The simulator explains it.
    const sim = await ok(`aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::${ACCT}:user/dev --action-names ec2:DescribeVpcs ec2:RunInstances`);
    expect(sim.EvaluationResults.map((r: { EvalDecision: string }) => r.EvalDecision)).toEqual(["explicitDeny", "implicitDeny"]);
  });

  it("scopes S3 permissions to one bucket's objects", async () => {
    await ok("aws s3api create-bucket --bucket team-assets-1");
    await ok("aws s3api create-bucket --bucket secret-stuff-1");
    await ok("aws iam create-user --user-name dev");
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: "s3:ListBucket", Resource: "arn:aws:s3:::team-assets-1" },
        { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: "arn:aws:s3:::team-assets-1/*" },
      ],
    });
    const arn = (await ok(`aws iam create-policy --policy-name assets --policy-document '${policy}'`)).Policy.Arn;
    await ok(`aws iam attach-user-policy --user-name dev --policy-arn ${arn}`);
    await run("aws s3 ls s3://team-assets-1", dev).then((r) => expect(r.exitCode).toBe(0));
    expect((await fails("aws s3 ls s3://secret-stuff-1", dev)).code).toBe("AccessDenied");
    expect((await fails("aws s3 ls", dev)).message).toContain("s3:ListAllMyBuckets");
    expect((await fails("aws s3api delete-object --bucket team-assets-1 --key a.txt", dev)).message).toContain(
      'on resource: "arn:aws:s3:::team-assets-1/a.txt"',
    );
  });

  it("refuses to delete things that are still in use, with DeleteConflict", async () => {
    await ok("aws iam create-user --user-name dev");
    await ok("aws iam create-group --group-name g1");
    await ok("aws iam add-user-to-group --group-name g1 --user-name dev");
    await ok("aws iam attach-user-policy --user-name dev --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess");
    const key = (await ok("aws iam create-access-key --user-name dev")).AccessKey;
    expect(key.AccessKeyId).toMatch(/^AKIA[A-Z2-7]{16}$/);
    expect(key.SecretAccessKey).toHaveLength(40);
    expect((await ok("aws iam list-access-keys --user-name dev")).AccessKeyMetadata[0].SecretAccessKey).toBeUndefined();

    expect((await fails("aws iam delete-user --user-name dev")).message).toBe("Cannot delete entity, must detach all policies first.");
    await ok("aws iam detach-user-policy --user-name dev --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess");
    expect((await fails("aws iam delete-user --user-name dev")).message).toBe("Cannot delete entity, must remove user from all groups first.");
    expect((await fails("aws iam delete-group --group-name g1")).message).toBe("Cannot delete entity, must remove users from group first.");
    await ok("aws iam remove-user-from-group --group-name g1 --user-name dev");
    expect((await fails("aws iam delete-user --user-name dev")).message).toBe("Cannot delete entity, must delete access keys first.");
    await ok(`aws iam delete-access-key --access-key-id ${key.AccessKeyId}`);
    await ok("aws iam delete-user --user-name dev");
    expect(await fails("aws iam get-user --user-name dev")).toMatchObject({ code: "NoSuchEntity", message: "The user with name dev cannot be found." });
    expect((await fails("aws iam attach-group-policy --group-name g1 --policy-arn arn:aws:iam::aws:policy/Nope")).message).toBe(
      "Policy arn:aws:iam::aws:policy/Nope does not exist or is not attachable.",
    );
  });

  it("lets roles be assumed only when their trust policy allows it, and gives instances roles", async () => {
    const ec2Trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }] });
    await ok(`aws iam create-role --role-name web --assume-role-policy-document '${ec2Trust}'`);
    await ok("aws iam attach-role-policy --role-name web --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess");
    // The account can't assume a role that only trusts EC2.
    await expect(resolvePrincipal(engine, ACCOUNT, { kind: "role", name: "web" })).rejects.toMatchObject({ code: "AccessDenied" });

    const inst = (await ok("aws ec2 run-instances --image-id ami-0lab2023linux0001 --iam-instance-profile Name=web")).Instances[0];
    expect(inst.IamInstanceProfile.Arn).toBe(`arn:aws:iam::${ACCT}:instance-profile/web`);
    expect((await fails("aws ec2 run-instances --image-id ami-0lab2023linux0001 --iam-instance-profile Name=nope")).code).toBe("NoSuchEntity");
    await ok("aws iam detach-role-policy --role-name web --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess");
    expect((await fails("aws iam delete-role --role-name web")).message).toBe("Cannot delete entity, must remove roles from instance profile first.");

    const accountTrust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${ACCT}:root` }, Action: "sts:AssumeRole" }] });
    await ok(`aws iam create-role --role-name admin --assume-role-policy-document '${accountTrust}'`);
    await ok("aws iam attach-role-policy --role-name admin --policy-arn arn:aws:iam::aws:policy/AdministratorAccess");
    const admin: Identity = { kind: "role", name: "admin" };
    expect((await ok("aws sts get-caller-identity", admin)).Arn).toBe(`arn:aws:sts::${ACCT}:assumed-role/admin/cloudlab-session`);
    await ok("aws ec2 create-vpc --cidr-block 10.0.0.0/16", admin);
  });

  it("keeps policy versions and rejects bad documents", async () => {
    expect((await fails("aws iam create-policy --policy-name bad --policy-document '{\"Statement\":[{\"Effect\":\"Allow\",\"Resource\":\"*\"}]}'")).code).toBe(
      "MalformedPolicyDocument",
    );
    const doc = (action: string) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: action, Resource: "*" }] });
    const arn = (await ok(`aws iam create-policy --policy-name p --policy-document '${doc("s3:List*")}'`)).Policy.Arn;
    await ok(`aws iam create-policy-version --policy-arn ${arn} --policy-document '${doc("s3:Get*")}' --set-as-default`);
    const v = (await ok(`aws iam get-policy-version --policy-arn ${arn} --version-id v2`)).PolicyVersion;
    expect(v.Document.Statement[0].Action).toBe("s3:Get*");
    expect((await ok("aws iam list-policies --scope Local")).Policies).toHaveLength(1);
    expect((await ok("aws iam list-policies --scope AWS")).Policies.some((p: { PolicyName: string }) => p.PolicyName === "AdministratorAccess")).toBe(true);
  });
});
