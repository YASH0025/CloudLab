import type { PolicyDocument } from "./policy";

/**
 * AWS managed policies: ready-made policies every account can attach. These
 * follow the real ones, trimmed to the services CloudLab simulates.
 */

export interface ManagedPolicy {
  name: string;
  arn: string;
  description: string;
  document: PolicyDocument;
}

const allow = (Action: string[], Resource: string[] = ["*"]) => ({ Effect: "Allow" as const, Action, Resource });

const managed = (name: string, description: string, statements: PolicyDocument["Statement"]): ManagedPolicy => ({
  name,
  arn: `arn:aws:iam::aws:policy/${name}`,
  description,
  document: { Version: "2012-10-17", Statement: statements },
});

export const MANAGED_POLICIES: ManagedPolicy[] = [
  managed("AdministratorAccess", "Provides full access to AWS services and resources.", [allow(["*"])]),
  managed("PowerUserAccess", "Provides full access to AWS services and resources, but does not allow management of users and groups.", [
    { Effect: "Allow", NotAction: ["iam:*", "organizations:*", "account:*"], Resource: ["*"] },
    allow(["iam:CreateServiceLinkedRole", "iam:DeleteServiceLinkedRole", "iam:ListRoles", "organizations:DescribeOrganization", "account:ListRegions"]),
  ]),
  managed("ReadOnlyAccess", "Provides read-only access to AWS services and resources.", [
    allow(["ec2:Describe*", "ec2:Get*", "s3:Get*", "s3:List*", "iam:Get*", "iam:List*", "iam:Simulate*", "elasticloadbalancing:Describe*", "cloudwatch:Describe*", "cloudwatch:Get*", "cloudwatch:List*"]),
  ]),
  managed("AmazonEC2FullAccess", "Provides full access to Amazon EC2.", [
    allow(["ec2:*", "elasticloadbalancing:*", "cloudwatch:*", "autoscaling:*"]),
  ]),
  managed("AmazonEC2ReadOnlyAccess", "Provides read only access to Amazon EC2.", [
    allow(["ec2:Describe*", "elasticloadbalancing:Describe*", "cloudwatch:ListMetrics", "cloudwatch:GetMetricStatistics", "cloudwatch:Describe*", "autoscaling:Describe*"]),
  ]),
  managed("AmazonVPCFullAccess", "Provides full access to Amazon VPC.", [
    allow([
      "ec2:*Vpc*",
      "ec2:*Subnet*",
      "ec2:*Gateway*",
      "ec2:*Route*",
      "ec2:*Address*",
      "ec2:*SecurityGroup*",
      "ec2:*NetworkAcl*",
      "ec2:Describe*",
    ]),
  ]),
  managed("AmazonVPCReadOnlyAccess", "Provides read only access to Amazon VPC.", [allow(["ec2:Describe*"])]),
  managed("AmazonS3FullAccess", "Provides full access to all buckets.", [allow(["s3:*", "s3-object-lambda:*"])]),
  managed("AmazonS3ReadOnlyAccess", "Provides read only access to all buckets.", [
    allow(["s3:Get*", "s3:List*", "s3:Describe*", "s3-object-lambda:Get*", "s3-object-lambda:List*"]),
  ]),
  managed("IAMFullAccess", "Provides full access to IAM.", [allow(["iam:*"])]),
  managed("IAMReadOnlyAccess", "Provides read only access to IAM.", [
    allow(["iam:GenerateCredentialReport", "iam:Get*", "iam:List*", "iam:SimulateCustomPolicy", "iam:SimulatePrincipalPolicy"]),
  ]),
];

export const managedByArn = (arn: string) => MANAGED_POLICIES.find((p) => p.arn === arn);
