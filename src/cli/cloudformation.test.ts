import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { accountNumber } from "@/engine/ids";
import { MemoryStore } from "@/engine/store";
import { executeCli } from "./execute";

let clock: Date;
let engine: Engine;
const ACCOUNT = "acct-cfn-cli";
const ACCT = accountNumber(ACCOUNT);
let files: Record<string, string> = {};
const ctx = () => ({ engine, accountId: ACCOUNT, region: "us-east-1", files });
const run = (line: string) => executeCli(line, ctx());
async function json(line: string) {
  const r = await run(line);
  if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
  return r.output ? JSON.parse(r.output) : {};
}
async function fails(line: string) {
  const r = await run(line);
  const m = /\(([^)]+)\) when calling the (\w+) operation: ([\s\S]*)/.exec(r.output);
  if (!m) throw new Error(r.output);
  return { code: m[1], message: m[3].trim() };
}
const file = (name: string, text: string) => {
  files[name] = Buffer.from(text).toString("base64");
};
const list = (service: string, type: string) => engine.list(ACCOUNT, { service, type, region: "us-east-1" });

const NETWORK = `AWSTemplateFormatVersion: "2010-09-09"
Description: A public subnet
Parameters:
  Env:
    Type: String
    AllowedValues: [dev, prod]
  SubnetCidr:
    Type: String
    Default: 10.20.1.0/24
Conditions:
  IsProd: !Equals [!Ref Env, prod]
Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.20.0.0/16
      Tags: [{ Key: Name, Value: !Sub "\${Env}-vpc" }]
  Igw:
    Type: AWS::EC2::InternetGateway
  Attach:
    Type: AWS::EC2::VPCGatewayAttachment
    Properties:
      VpcId: !Ref Vpc
      InternetGatewayId: !Ref Igw
  Public:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: !Ref SubnetCidr
      AvailabilityZone: !Select [0, !GetAZs ""]
      MapPublicIpOnLaunch: true
  Routes:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref Vpc
  ToInternet:
    Type: AWS::EC2::Route
    DependsOn: Attach
    Properties:
      RouteTableId: !Ref Routes
      DestinationCidrBlock: 0.0.0.0/0
      GatewayId: !Ref Igw
  PublicRoutes:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref Public
      RouteTableId: !Ref Routes
  Web:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: HTTP from anywhere
      VpcId: !Ref Vpc
      SecurityGroupIngress:
        - { IpProtocol: tcp, FromPort: 80, ToPort: 80, CidrIp: 0.0.0.0/0 }
  Alerts:
    Type: AWS::SNS::Topic
    Condition: IsProd
Outputs:
  VpcId:
    Value: !Ref Vpc
    Export:
      Name: !Sub "\${AWS::StackName}-vpc"
  SubnetAz:
    Value: !GetAtt Public.AvailabilityZone
`;

beforeEach(() => {
  clock = new Date("2026-10-01T12:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
  files = {};
});

describe("aws cloudformation", { timeout: 60_000 }, () => {
  it("rejects bad templates and parameters up front", async () => {
    file("bad.yaml", "Resources:\n  A: [unclosed");
    expect(await fails("aws cloudformation create-stack --stack-name s --template-body file://bad.yaml")).toMatchObject({ code: "ValidationError", message: expect.stringMatching(/^Template format error: YAML not well-formed/) });
    file("empty.yaml", "Description: nothing\n");
    expect(await fails("aws cloudformation validate-template --template-body file://empty.yaml")).toEqual({ code: "ValidationError", message: "Template format error: At least one Resources member must be defined." });
    file("unres.yaml", "Resources:\n  S:\n    Type: AWS::EC2::Subnet\n    Properties:\n      VpcId: !Ref Nope\n      CidrBlock: 10.0.0.0/24\n");
    expect(await fails("aws cloudformation create-stack --stack-name s --template-body file://unres.yaml")).toEqual({
      code: "ValidationError",
      message: "Template format error: Unresolved resource dependencies [Nope] in the Resources block of the template",
    });
    file("odd.yaml", "Resources:\n  X:\n    Type: AWS::Foo::Bar\n");
    expect(await fails("aws cloudformation create-stack --stack-name s --template-body file://odd.yaml")).toMatchObject({ message: expect.stringMatching(/^Template format error: Unrecognized resource types: \[AWS::Foo::Bar\]/) });
    file("net.yaml", NETWORK);
    expect(await fails("aws cloudformation create-stack --stack-name s --template-body file://net.yaml")).toEqual({ code: "ValidationError", message: "Parameters: [Env] must have values" });
    expect(await fails("aws cloudformation create-stack --stack-name s --template-body file://net.yaml --parameters ParameterKey=Env,ParameterValue=qa")).toEqual({
      code: "ValidationError",
      message: "Parameter 'Env' must be one of AllowedValues",
    });
    expect(await fails("aws cloudformation create-stack --stack-name 'bad name' --template-body file://net.yaml")).toMatchObject({ message: expect.stringContaining("Member must satisfy regular expression pattern: [a-zA-Z][-a-zA-Z0-9]*") });
    file("role.yaml", 'Resources:\n  R:\n    Type: AWS::IAM::Role\n    Properties:\n      RoleName: app\n      AssumeRolePolicyDocument: {Version: "2012-10-17", Statement: [{Effect: Allow, Principal: {Service: lambda.amazonaws.com}, Action: "sts:AssumeRole"}]}\n');
    expect(await fails("aws cloudformation create-stack --stack-name r --template-body file://role.yaml")).toEqual({ code: "InsufficientCapabilitiesException", message: "Requires capabilities : [CAPABILITY_NAMED_IAM]" });
    expect(await fails("aws cloudformation create-stack --stack-name r --template-body file://role.yaml --capabilities CAPABILITY_IAM")).toMatchObject({ message: "Requires capabilities : [CAPABILITY_NAMED_IAM]" });
    await json("aws cloudformation create-stack --stack-name r --template-body file://role.yaml --capabilities CAPABILITY_NAMED_IAM");
    expect((await list("iam", "role").then(() => engine.list(ACCOUNT, { service: "iam", type: "role", region: "global" }))).some((r) => r.name === "app")).toBe(true);
    const v = await json("aws cloudformation validate-template --template-body file://role.yaml");
    expect(v).toMatchObject({ Capabilities: ["CAPABILITY_NAMED_IAM"] });
  });

  it("creates a network in dependency order, with refs, conditions and outputs", async () => {
    file("net.yaml", NETWORK);
    const { StackId } = await json("aws cloudformation create-stack --stack-name web --template-body file://net.yaml --parameters ParameterKey=Env,ParameterValue=dev");
    expect(StackId).toMatch(new RegExp(`^arn:aws:cloudformation:us-east-1:${ACCT}:stack/web/[0-9a-f-]{36}$`));
    expect(await fails("aws cloudformation create-stack --stack-name web --template-body file://net.yaml --parameters ParameterKey=Env,ParameterValue=dev")).toEqual({
      code: "AlreadyExistsException",
      message: "Stack [web] already exists",
    });
    const [stack] = (await json("aws cloudformation describe-stacks --stack-name web")).Stacks;
    expect(stack).toMatchObject({ StackStatus: "CREATE_COMPLETE", Description: "A public subnet", Parameters: expect.arrayContaining([{ ParameterKey: "SubnetCidr", ParameterValue: "10.20.1.0/24" }]) });
    const vpc = (await list("networking", "vpc")).find((x) => x.name === "dev-vpc")!;
    expect(stack.Outputs).toEqual([
      { OutputKey: "VpcId", OutputValue: vpc.id, ExportName: "web-vpc" },
      { OutputKey: "SubnetAz", OutputValue: "us-east-1a" },
    ]);
    // The condition was false: no topic.
    expect(await list("sns", "topic")).toHaveLength(0);
    const rt = (await list("networking", "route-table")).find((t) => t.config.vpcId === vpc.id && (t.config.routes as unknown[]).length > 0)!;
    expect(rt.config.routes).toEqual([{ destination: "0.0.0.0/0", gatewayId: expect.stringMatching(/^igw-/) }]);
    expect((rt.config.subnetIds as string[]).length).toBe(1);
    const res = (await json("aws cloudformation list-stack-resources --stack-name web")).StackResourceSummaries;
    expect(res.map((r: { LogicalResourceId: string }) => r.LogicalResourceId)).toEqual(["Vpc", "Igw", "Attach", "Public", "Routes", "ToInternet", "PublicRoutes", "Web"]);
    const events = (await json("aws cloudformation describe-stack-events --stack-name web")).StackEvents;
    expect(events[0]).toMatchObject({ LogicalResourceId: "web", ResourceStatus: "CREATE_COMPLETE" });
    expect(events.at(-1)).toMatchObject({ ResourceStatus: "CREATE_IN_PROGRESS", ResourceStatusReason: "User Initiated" });
    expect((await run("aws cloudformation wait stack-create-complete --stack-name web")).exitCode).toBe(0);

    // Updates: a parameter change replaces the subnet (its CIDR can't change in place); No updates otherwise.
    expect(await fails("aws cloudformation update-stack --stack-name web --use-previous-template --parameters ParameterKey=Env,UsePreviousValue=true")).toEqual({
      code: "ValidationError",
      message: "No updates are to be performed.",
    });
    const oldSubnet = (await list("networking", "subnet")).find((x) => x.config.vpcId === vpc.id)!;
    await json("aws cloudformation create-change-set --stack-name web --change-set-name bigger --use-previous-template --parameters ParameterKey=Env,UsePreviousValue=true ParameterKey=SubnetCidr,ParameterValue=10.20.2.0/24");
    const cs = await json("aws cloudformation describe-change-set --stack-name web --change-set-name bigger");
    expect(cs.Changes.map((c: { ResourceChange: { LogicalResourceId: string; Action: string; Replacement?: string } }) => c.ResourceChange)).toEqual([
      expect.objectContaining({ LogicalResourceId: "Public", Action: "Modify", Replacement: "True" }),
      expect.objectContaining({ LogicalResourceId: "PublicRoutes", Action: "Modify", Replacement: "True" }),
    ]);
    await json("aws cloudformation execute-change-set --stack-name web --change-set-name bigger");
    expect((await json("aws cloudformation describe-stacks --stack-name web")).Stacks[0].StackStatus).toBe("UPDATE_COMPLETE");
    const subnets = (await list("networking", "subnet")).filter((x) => x.config.vpcId === vpc.id);
    expect(subnets.map((x) => x.config.cidrBlock)).toEqual(["10.20.2.0/24"]);
    expect(subnets[0].id).not.toBe(oldSubnet.id);

    // Turning the condition on adds the topic.
    await json("aws cloudformation update-stack --stack-name web --use-previous-template --parameters ParameterKey=Env,ParameterValue=prod ParameterKey=SubnetCidr,UsePreviousValue=true");
    expect(await list("sns", "topic")).toHaveLength(1);

    // An export in use can't be deleted.
    file("user.yaml", 'Resources:\n  S:\n    Type: AWS::EC2::Subnet\n    Properties:\n      VpcId: !ImportValue web-vpc\n      CidrBlock: 10.20.9.0/24\n');
    await json("aws cloudformation create-stack --stack-name user --template-body file://user.yaml");
    expect(await fails("aws cloudformation delete-stack --stack-name web")).toEqual({ code: "ValidationError", message: "Export web-vpc cannot be deleted as it is in use by user" });
    await json("aws cloudformation delete-stack --stack-name user");
    await json("aws cloudformation delete-stack --stack-name web");
    expect(await list("networking", "vpc").then((v) => v.filter((x) => x.name === "dev-vpc"))).toHaveLength(0);
    expect(await fails("aws cloudformation describe-stacks --stack-name web")).toEqual({ code: "ValidationError", message: "Stack with id web does not exist" });
  });

  it("rolls back a failed create, and a failed update", async () => {
    file("bad.yaml", `Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties: { CidrBlock: 10.30.0.0/16 }
  Queue:
    Type: AWS::SQS::Queue
  Sub:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.99.0.0/24
`);
    await json("aws cloudformation create-stack --stack-name bad --template-body file://bad.yaml");
    const [s] = (await json("aws cloudformation describe-stacks --stack-name bad")).Stacks;
    expect(s.StackStatus).toBe("ROLLBACK_COMPLETE");
    expect(s.StackStatusReason).toBeUndefined();
    const events = (await json("aws cloudformation describe-stack-events --stack-name bad")).StackEvents;
    expect(events.find((e: { ResourceStatus: string }) => e.ResourceStatus === "CREATE_FAILED")).toMatchObject({
      LogicalResourceId: "Sub",
      ResourceStatusReason: expect.stringMatching(/^Resource handler returned message: ".*" \(Service: EC2, Status Code: 400, Error Code: InvalidSubnet.Range\)$/),
    });
    expect(events.find((e: { ResourceStatus: string }) => e.ResourceStatus === "ROLLBACK_IN_PROGRESS").ResourceStatusReason).toBe("The following resource(s) failed to create: [Sub]. Rollback requested by user.");
    expect((await list("networking", "vpc")).some((v) => v.config.cidrBlock === "10.30.0.0/16")).toBe(false);
    expect(await list("sqs", "queue")).toHaveLength(0);
    expect((await run("aws cloudformation wait stack-create-complete --stack-name bad")).output).toMatch(/Waiter StackCreateComplete failed: .*"ROLLBACK_COMPLETE"/);
    expect(await fails("aws cloudformation update-stack --stack-name bad --use-previous-template")).toMatchObject({ message: expect.stringMatching(/is in ROLLBACK_COMPLETE state and can not be updated\.$/) });
    await json("aws cloudformation delete-stack --stack-name bad");

    file("q.yaml", "Resources:\n  Queue:\n    Type: AWS::SQS::Queue\n    Properties: { QueueName: jobs, VisibilityTimeout: 30 }\n");
    await json("aws cloudformation create-stack --stack-name q --template-body file://q.yaml");
    file("q2.yaml", "Resources:\n  Queue:\n    Type: AWS::SQS::Queue\n    Properties: { QueueName: jobs, VisibilityTimeout: 60 }\n  Table:\n    Type: AWS::DynamoDB::Table\n    Properties:\n      KeySchema: [{AttributeName: id, KeyType: HASH}]\n      AttributeDefinitions: [{AttributeName: id, AttributeType: S}]\n");
    // The table has no BillingMode, so it's PROVISIONED without throughput: it fails, and the queue goes back to 30.
    await json("aws cloudformation update-stack --stack-name q --template-body file://q2.yaml");
    expect((await json("aws cloudformation describe-stacks --stack-name q")).Stacks[0].StackStatus).toBe("UPDATE_ROLLBACK_COMPLETE");
    expect((await list("sqs", "queue"))[0].config.visibilityTimeout).toBe(30);
    expect((await json("aws cloudformation get-template --stack-name q")).TemplateBody).toContain("VisibilityTimeout: 30");
    // In-place update works.
    file("q3.yaml", "Resources:\n  Queue:\n    Type: AWS::SQS::Queue\n    Properties: { QueueName: jobs, VisibilityTimeout: 60 }\n");
    await json("aws cloudformation update-stack --stack-name q --template-body file://q3.yaml");
    const q = (await list("sqs", "queue"))[0];
    expect(q.config.visibilityTimeout).toBe(60);
    // Retention can change in place too: same queue.
    file("q4.yaml", "Resources:\n  Queue:\n    Type: AWS::SQS::Queue\n    Properties: { QueueName: jobs, VisibilityTimeout: 60, MessageRetentionPeriod: 120 }\n");
    await json("aws cloudformation update-stack --stack-name q --template-body file://q4.yaml");
    expect((await list("sqs", "queue"))[0].id).toBe(q.id);
    await json("aws cloudformation delete-stack --stack-name q");
    expect(await list("sqs", "queue")).toHaveLength(0);
  });

  it("builds a serverless app: role, function, topic and permission", async () => {
    file("app.yaml", `Resources:
  Role:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement: [{ Effect: Allow, Principal: { Service: lambda.amazonaws.com }, Action: "sts:AssumeRole" }]
      ManagedPolicyArns: [arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]
  Fn:
    Type: AWS::Lambda::Function
    Properties:
      Runtime: nodejs22.x
      Handler: index.handler
      Role: !GetAtt Role.Arn
      Code:
        ZipFile: |
          exports.handler = async (event) => ({ got: event.Records.length });
  Topic:
    Type: AWS::SNS::Topic
  Sub:
    Type: AWS::SNS::Subscription
    Properties:
      TopicArn: !Ref Topic
      Protocol: lambda
      Endpoint: !GetAtt Fn.Arn
  Allow:
    Type: AWS::Lambda::Permission
    Properties:
      FunctionName: !Ref Fn
      Action: lambda:InvokeFunction
      Principal: sns.amazonaws.com
      SourceArn: !Ref Topic
Outputs:
  TopicArn:
    Value: !Ref Topic
`);
    await json("aws cloudformation create-stack --stack-name app --template-body file://app.yaml --capabilities CAPABILITY_IAM");
    const [s] = (await json("aws cloudformation describe-stacks --stack-name app")).Stacks;
    expect(s.StackStatus).toBe("CREATE_COMPLETE");
    const fn = (await list("lambda", "function"))[0];
    expect(fn.name).toMatch(/^app-Fn-[A-Z0-9]{12}$/);
    const topicArn = s.Outputs[0].OutputValue;
    await json(`aws sns publish --topic-arn ${topicArn} --message hi`);
    const deliveries = (await engine.get(ACCOUNT, topicArn)).attributes.deliveries as { status: string }[];
    expect(deliveries[0].status).toBe("delivered");
    await json("aws cloudformation delete-stack --stack-name app");
    expect(await list("lambda", "function")).toHaveLength(0);
    expect(await list("sns", "topic")).toHaveLength(0);
  });
});
