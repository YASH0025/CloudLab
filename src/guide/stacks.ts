import type { StackOutput, StackResource } from "@/engine/cloudformation/deploy";
import type { Engine } from "@/engine/engine";
import type { Resource } from "@/engine/types";

/** The two stacks the "split into stacks" tutorial suggests. */
export const NETWORK_STACK = "network";
export const APP_STACK = "web-app";

const DONE = ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"];

/** What the cross-stack tutorial looks at: a network stack that exports, an app stack that imports. */
export interface StacksState {
  network?: Resource;
  app?: Resource;
  /** Export names the network stack offers. */
  exports: string[];
  /** Export names the app stack uses. */
  imports: string[];
  /** The web server the app stack made. */
  server?: Resource;
  /** Someone tried to delete the network stack while the app stack still used it. */
  deleteBlocked: boolean;
}

export async function loadStacks(engine: Engine, accountId: string, region: string): Promise<StacksState> {
  const stacks = await engine.list(accountId, { service: "cloudformation", type: "stack", region });
  const network = stacks.find((s) => s.name === NETWORK_STACK && DONE.includes(String(s.state)));
  const app = stacks.find((s) => s.name === APP_STACK && DONE.includes(String(s.state)));
  const exports = ((network?.attributes.outputs as StackOutput[] | undefined) ?? []).flatMap((o) => (o.exportName ? [o.exportName] : []));
  const imports = (app?.attributes.imports as string[] | undefined) ?? [];
  const ref = ((app?.attributes.resources as StackResource[] | undefined) ?? []).find((r) => r.type === "AWS::EC2::Instance");
  const server = ref?.resourceId ? ((await engine.get(accountId, ref.resourceId).catch(() => null)) ?? undefined) : undefined;
  return { network, app, exports, imports, server, deleteBlocked: !!network?.attributes.deleteBlockedBy };
}

export const NETWORK_TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Description: The shared network. Other stacks build on it.

Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.50.0.0/16
      Tags: [{ Key: Name, Value: shared-vpc }]

  PublicSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.50.1.0/24
      AvailabilityZone: !Select [0, !GetAZs ""]
      MapPublicIpOnLaunch: true
      Tags: [{ Key: Name, Value: shared-public-a }]

  Gateway:
    Type: AWS::EC2::InternetGateway

  GatewayAttachment:
    Type: AWS::EC2::VPCGatewayAttachment
    Properties:
      VpcId: !Ref Vpc
      InternetGatewayId: !Ref Gateway

  PublicRoutes:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref Vpc

  InternetRoute:
    Type: AWS::EC2::Route
    DependsOn: GatewayAttachment
    Properties:
      RouteTableId: !Ref PublicRoutes
      DestinationCidrBlock: 0.0.0.0/0
      GatewayId: !Ref Gateway

  PublicSubnetRoutes:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PublicSubnet
      RouteTableId: !Ref PublicRoutes

Outputs:
  VpcId:
    Description: The shared VPC
    Value: !Ref Vpc
    Export:
      Name: !Sub "\${AWS::StackName}-VpcId"
  PublicSubnetId:
    Description: A public subnet for web servers
    Value: !Ref PublicSubnet
    Export:
      Name: !Sub "\${AWS::StackName}-PublicSubnetId"
`;

export const APP_TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Description: A web server on the shared network

Parameters:
  NetworkStack:
    Type: String
    Default: ${NETWORK_STACK}
    Description: Name of the stack that exports the network

Resources:
  WebGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Web traffic from anywhere
      VpcId:
        Fn::ImportValue: !Sub "\${NetworkStack}-VpcId"
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 80
          ToPort: 80
          CidrIp: 0.0.0.0/0

  WebServer:
    Type: AWS::EC2::Instance
    Properties:
      ImageId: ami-0ubuntu24040lts01
      InstanceType: t3.micro
      SubnetId:
        Fn::ImportValue: !Sub "\${NetworkStack}-PublicSubnetId"
      SecurityGroupIds: [!Ref WebGroup]
      Tags: [{ Key: Name, Value: stack-web }]

Outputs:
  WebsiteUrl:
    Description: Open this in a browser
    Value: !Sub "http://\${WebServer.PublicIp}"
`;
