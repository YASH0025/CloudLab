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

const managed = (name: string, description: string, statements: PolicyDocument["Statement"], path = ""): ManagedPolicy => ({
  name,
  arn: `arn:aws:iam::aws:policy/${path}${name}`,
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
    allow(["ec2:Describe*", "ec2:Get*", "s3:Get*", "s3:List*", "iam:Get*", "iam:List*", "iam:Simulate*", "elasticloadbalancing:Describe*", "autoscaling:Describe*", "rds:Describe*", "lambda:Get*", "lambda:List*", "apigateway:GET", "logs:Describe*", "logs:Get*", "logs:FilterLogEvents", "cloudwatch:Describe*", "cloudwatch:Get*", "cloudwatch:List*", "sns:Get*", "sns:List*"]),
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
  managed("ElasticLoadBalancingFullAccess", "Provides full access to Amazon ElasticLoadBalancing.", [
    allow(["elasticloadbalancing:*", "ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeInstances", "ec2:DescribeAvailabilityZones"]),
  ]),
  managed("AutoScalingFullAccess", "Provides full access to Auto Scaling.", [
    allow(["autoscaling:*", "cloudwatch:PutMetricAlarm", "ec2:Describe*", "ec2:CreateLaunchTemplate*", "ec2:RunInstances", "elasticloadbalancing:Describe*"]),
  ]),
  managed("AmazonRDSFullAccess", "Provides full access to Amazon RDS via the AWS Management Console.", [
    allow(["rds:*", "ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeAvailabilityZones", "ec2:DescribeInstances", "cloudwatch:GetMetricStatistics"]),
  ]),
  managed("AmazonRDSReadOnlyAccess", "Provides read only access to Amazon RDS via the AWS Management Console.", [
    allow(["rds:Describe*", "rds:ListTagsForResource", "ec2:DescribeAccountAttributes", "ec2:DescribeAvailabilityZones", "ec2:DescribeSecurityGroups", "ec2:DescribeVpcs"]),
  ]),
  managed("AWSLambda_FullAccess", "Grants full access to AWS Lambda service, AWS Lambda console features, and other related AWS services.", [
    allow(["lambda:*", "iam:ListRoles", "iam:PassRole", "apigateway:GET", "logs:DescribeLogGroups", "logs:FilterLogEvents", "logs:GetLogEvents"]),
  ]),
  managed("AWSLambda_ReadOnlyAccess", "Grants read-only access to AWS Lambda service, AWS Lambda console features, and other related AWS services.", [
    allow(["lambda:Get*", "lambda:List*", "iam:ListRoles", "logs:DescribeLogGroups", "logs:GetLogEvents"]),
  ]),
  managed("AWSLambdaBasicExecutionRole", "Provides write permissions to CloudWatch Logs. Attach it to a Lambda function's execution role.", [
    allow(["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]),
  ], "service-role/"),
  managed("AmazonAPIGatewayAdministrator", "Provides full access to create/edit/delete APIs in Amazon API Gateway via the AWS Management Console.", [
    allow(["apigateway:*"]),
  ]),
  managed("AmazonAPIGatewayInvokeFullAccess", "Provides full access to invoke APIs in Amazon API Gateway.", [allow(["execute-api:Invoke", "execute-api:ManageConnections"])]),
  managed("CloudWatchFullAccess", "Provides full access to CloudWatch.", [allow(["cloudwatch:*", "logs:*", "autoscaling:Describe*", "sns:*"])]),
  managed("CloudWatchReadOnlyAccess", "Provides read only access to CloudWatch.", [
    allow(["cloudwatch:Describe*", "cloudwatch:Get*", "cloudwatch:List*", "logs:Get*", "logs:List*", "logs:Describe*", "logs:FilterLogEvents", "logs:StartQuery", "autoscaling:Describe*"]),
  ]),
  managed("CloudWatchLogsFullAccess", "Provides full access to CloudWatch Logs.", [allow(["logs:*", "cloudwatch:GenerateQuery"])]),
  managed("AmazonSNSFullAccess", "Provides full access to Amazon SNS via the AWS Management Console.", [allow(["sns:*"])]),
  managed("AmazonSNSReadOnlyAccess", "Provides read only access to Amazon SNS via the AWS Management Console.", [allow(["sns:GetTopicAttributes", "sns:List*", "sns:CheckIfPhoneNumberIsOptedOut", "sns:GetEndpointAttributes", "sns:GetDataProtectionPolicy", "sns:GetPlatformApplicationAttributes", "sns:GetSMSAttributes", "sns:GetSMSSandboxAccountStatus", "sns:GetSubscriptionAttributes"])]),
  managed("AmazonRoute53FullAccess", "Provides full access to all Amazon Route 53 via the AWS Management Console.", [
    allow(["route53:*", "route53domains:*", "elasticloadbalancing:DescribeLoadBalancers", "apigateway:GET", "s3:ListAllMyBuckets", "s3:GetBucketWebsite", "ec2:DescribeVpcs", "ec2:DescribeRegions"]),
  ]),
  managed("AmazonRoute53ReadOnlyAccess", "Provides read only access to all Amazon Route 53 via the AWS Management Console.", [
    allow(["route53:Get*", "route53:List*", "route53:TestDNSAnswer"]),
  ]),
  managed("IAMFullAccess", "Provides full access to IAM.", [allow(["iam:*"])]),
  managed("IAMReadOnlyAccess", "Provides read only access to IAM.", [
    allow(["iam:GenerateCredentialReport", "iam:Get*", "iam:List*", "iam:SimulateCustomPolicy", "iam:SimulatePrincipalPolicy"]),
  ]),
];

export const managedByArn = (arn: string) => MANAGED_POLICIES.find((p) => p.arn === arn);
