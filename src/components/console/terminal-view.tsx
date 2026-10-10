"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Terminal, type TerminalHandle } from "./terminal";

const examples: { label: string; command: string }[] = [
  { label: "Who am I?", command: "aws sts get-caller-identity" },
  { label: "Find the default VPC", command: "aws ec2 describe-vpcs --filters Name=isDefault,Values=true" },
  { label: "Launch into the default VPC", command: "aws ec2 run-instances --image-id ami-0lab2023linux0001 --instance-type t3.micro" },
  { label: "Create a VPC", command: "aws ec2 create-vpc --cidr-block 10.0.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=main}]'" },
  { label: "List VPCs", command: "aws ec2 describe-vpcs" },
  { label: "Create a subnet", command: "aws ec2 create-subnet --vpc-id <vpc-id> --cidr-block 10.0.1.0/24" },
  { label: "Create an internet gateway", command: "aws ec2 create-internet-gateway" },
  { label: "Attach it", command: "aws ec2 attach-internet-gateway --internet-gateway-id <igw-id> --vpc-id <vpc-id>" },
  { label: "Route table", command: "aws ec2 create-route-table --vpc-id <vpc-id>" },
  { label: "Default route", command: "aws ec2 create-route --route-table-id <rtb-id> --destination-cidr-block 0.0.0.0/0 --gateway-id <igw-id>" },
  { label: "Security group", command: "aws ec2 create-security-group --group-name web --description \"Web servers\" --vpc-id <vpc-id>" },
  { label: "Allow HTTP", command: "aws ec2 authorize-security-group-ingress --group-id <sg-id> --protocol tcp --port 80 --cidr 0.0.0.0/0" },
  { label: "Launch an instance", command: "aws ec2 run-instances --image-id ami-0lab2023linux0001 --instance-type t3.micro --subnet-id <subnet-id> --security-group-ids <sg-id> --associate-public-ip-address" },
  { label: "Running instances", command: "aws ec2 describe-instances --filters Name=instance-state-name,Values=running" },
  { label: "Make a bucket", command: "aws s3 mb s3://my-lab-bucket-2026" },
  { label: "List buckets", command: "aws s3 ls" },
];

export function TerminalView() {
  const terminal = useRef<TerminalHandle>(null);
  // The guide's "Do it in the terminal" links put a command on the prompt via ?cmd=.
  const cmd = useSearchParams().get("cmd");
  useEffect(() => {
    if (cmd) terminal.current?.insert(cmd);
  }, [cmd]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Terminal</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Practice the real CLI commands. Everything you create here shows up in the console too, and vice versa.
        </p>
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
        <div className="h-[60vh]">
          <Terminal ref={terminal} />
        </div>
        <Card className="max-h-[60vh] overflow-hidden">
          <CardHeader>
            <CardTitle>Try these</CardTitle>
            <CardDescription>Click to put a command on the prompt. Replace the &lt;ids&gt; with your own.</CardDescription>
          </CardHeader>
          <CardContent className="relative space-y-1 overflow-y-auto py-2">
            {examples.map((e) => (
              <button
                key={e.label}
                type="button"
                onClick={() => terminal.current?.insert(e.command)}
                className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                {e.label}
                <span className="block truncate font-mono text-xs text-muted-foreground">{e.command}</span>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
