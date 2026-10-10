import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "@/engine/engine";
import { MemoryStore } from "@/engine/store";
import { resolvePrincipal } from "@/engine/iam/authorize";
import { executeCli } from "./execute";

let clock: Date;
let engine: Engine;
const ctx = () => ({ engine, accountId: "acct-elb", region: "us-east-1" });
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

async function json(line: string) {
  const r = await executeCli(line, ctx());
  if (r.exitCode !== 0) throw new Error(`'${line}' failed: ${r.output}`);
  return r.output ? JSON.parse(r.output) : {};
}

async function fails(line: string) {
  const r = await executeCli(line, ctx());
  expect(r.exitCode, r.output).not.toBe(0);
  const m = /\(([^)]+)\) when calling the \w+ operation: (.*)/.exec(r.output);
  if (!m) throw new Error(r.output);
  return { code: m[1], message: m[2], output: r.output };
}

const IMAGE = "ami-0lab2023linux0001";

/** The default VPC, two of its subnets in different zones, and its default security group. */
async function defaults() {
  const vpc = (await json("aws ec2 describe-vpcs --filters Name=is-default,Values=true")).Vpcs[0].VpcId as string;
  const subnets = (await json(`aws ec2 describe-subnets --filters Name=vpc-id,Values=${vpc}`)).Subnets as { SubnetId: string; AvailabilityZone: string }[];
  subnets.sort((a, b) => a.AvailabilityZone.localeCompare(b.AvailabilityZone));
  const sg = (await json(`aws ec2 describe-security-groups --filters Name=vpc-id,Values=${vpc} Name=group-name,Values=default`)).SecurityGroups[0].GroupId as string;
  return { vpc, a: subnets[0].SubnetId, b: subnets[1].SubnetId, sg };
}

beforeEach(() => {
  clock = new Date("2026-03-01T00:00:00Z");
  engine = new Engine(new MemoryStore(), () => clock);
});

describe("aws elbv2", () => {
  it("builds a load balancer with a listener and reports target health", async () => {
    const d = await defaults();
    const tg = (await json(`aws elbv2 create-target-group --name web --protocol HTTP --port 80 --vpc-id ${d.vpc}`)).TargetGroups[0];
    expect(tg).toMatchObject({ TargetGroupName: "web", Port: 80, HealthCheckPath: "/", TargetType: "instance", LoadBalancerArns: [] });

    const lb = (await json(`aws elbv2 create-load-balancer --name web-lb --subnets ${d.a} ${d.b} --security-groups ${d.sg}`)).LoadBalancers[0];
    expect(lb.State.Code).toBe("provisioning");
    expect(lb.DNSName).toMatch(/^web-lb-\d+\.us-east-1\.elb\.cloudlab\.local$/);
    expect(lb.AvailabilityZones).toHaveLength(2);

    const listener = (
      await json(`aws elbv2 create-listener --load-balancer-arn ${lb.LoadBalancerArn} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${tg.TargetGroupArn}`)
    ).Listeners[0];
    expect(listener.ListenerArn).toContain(":listener/app/web-lb/");
    expect((await fails(`aws elbv2 create-listener --load-balancer-arn ${lb.LoadBalancerArn} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${tg.TargetGroupArn}`)).code).toBe(
      "DuplicateListener",
    );
    expect((await json(`aws elbv2 describe-target-groups --names web`)).TargetGroups[0].LoadBalancerArns).toEqual([lb.LoadBalancerArn]);

    const id = (await json(`aws ec2 run-instances --image-id ${IMAGE} --subnet-id ${d.a}`)).Instances[0].InstanceId;
    await json(`aws elbv2 register-targets --target-group-arn ${tg.TargetGroupArn} --targets Id=${id}`);
    let health = (await json(`aws elbv2 describe-target-health --target-group-arn ${tg.TargetGroupArn}`)).TargetHealthDescriptions[0];
    expect(health.TargetHealth).toMatchObject({ State: "initial", Reason: "Elb.RegistrationInProgress" });
    advance(15_000);
    health = (await json(`aws elbv2 describe-target-health --target-group-arn ${tg.TargetGroupArn}`)).TargetHealthDescriptions[0];
    // The default group lets members of itself in, and the load balancer is a member.
    expect(health.TargetHealth).toEqual({ State: "healthy" });

    expect(await fails(`aws elbv2 delete-target-group --target-group-arn ${tg.TargetGroupArn}`)).toMatchObject({ code: "ResourceInUse" });
    await json(`aws elbv2 delete-listener --listener-arn ${listener.ListenerArn}`);
    expect((await json(`aws elbv2 describe-listeners --load-balancer-arn ${lb.LoadBalancerArn}`)).Listeners).toEqual([]);
    await json(`aws elbv2 delete-target-group --target-group-arn ${tg.TargetGroupArn}`);
  });

  it("fails like ELB", async () => {
    const d = await defaults();
    expect(await fails(`aws elbv2 create-load-balancer --name one-zone --subnets ${d.a}`)).toMatchObject({
      code: "ValidationError",
      message: "At least two subnets in two different Availability Zones must be specified",
    });
    expect(await fails(`aws elbv2 describe-target-groups --target-group-arns nope`)).toMatchObject({
      code: "ValidationError",
      message: "'nope' is not a valid target group ARN",
    });
    expect(await fails(`aws elbv2 describe-load-balancers --names ghost`)).toMatchObject({ code: "LoadBalancerNotFound" });
    const tg = (await json(`aws elbv2 create-target-group --name web --protocol HTTP --port 80 --vpc-id ${d.vpc}`)).TargetGroups[0];
    expect(await fails(`aws elbv2 create-target-group --name web --protocol HTTP --port 80 --vpc-id ${d.vpc}`)).toMatchObject({ code: "DuplicateTargetGroupName" });
    expect(await fails(`aws elbv2 register-targets --target-group-arn ${tg.TargetGroupArn} --targets Id=i-0123456789abcdef0`)).toMatchObject({ code: "InvalidTarget" });
  });
});

describe("aws autoscaling", () => {
  it("creates a group from a launch template, scales it and explains what it did", async () => {
    const d = await defaults();
    const lt = (
      await json(`aws ec2 create-launch-template --launch-template-name web --launch-template-data '{"ImageId":"${IMAGE}","InstanceType":"t3.micro","SecurityGroupIds":["${d.sg}"]}'`)
    ).LaunchTemplate;
    expect(lt).toMatchObject({ LaunchTemplateName: "web", DefaultVersionNumber: 1, LatestVersionNumber: 1 });
    expect(lt.LaunchTemplateId).toMatch(/^lt-/);

    await json(`aws autoscaling create-auto-scaling-group --auto-scaling-group-name web-asg --launch-template LaunchTemplateName=web --min-size 1 --max-size 3 --desired-capacity 2 --vpc-zone-identifier ${d.a},${d.b}`);
    let group = (await json("aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names web-asg")).AutoScalingGroups[0];
    expect(group).toMatchObject({ MinSize: 1, MaxSize: 3, DesiredCapacity: 2, VPCZoneIdentifier: `${d.a},${d.b}` });
    expect(group.Instances).toHaveLength(2);
    expect(group.Instances[0].LifecycleState).toBe("Pending");

    expect(await fails("aws autoscaling set-desired-capacity --auto-scaling-group-name web-asg --desired-capacity 5")).toMatchObject({
      message: "New SetDesiredCapacity value 5 is above max value 3 for the AutoScalingGroup.",
    });
    await json("aws autoscaling set-desired-capacity --auto-scaling-group-name web-asg --desired-capacity 3");
    advance(10_000);
    group = (await json("aws autoscaling describe-auto-scaling-groups")).AutoScalingGroups[0];
    expect(group.Instances.map((i: { LifecycleState: string }) => i.LifecycleState)).toEqual(["InService", "InService", "InService"]);

    const victim = group.Instances[0].InstanceId;
    const usage = await executeCli(`aws autoscaling terminate-instance-in-auto-scaling-group --instance-id ${victim}`, ctx());
    expect(usage.exitCode).toBe(252);
    await json(`aws autoscaling terminate-instance-in-auto-scaling-group --instance-id ${victim} --should-decrement-desired-capacity`);
    group = (await json("aws autoscaling describe-auto-scaling-groups")).AutoScalingGroups[0];
    expect(group.DesiredCapacity).toBe(2);

    const activities = (await json("aws autoscaling describe-scaling-activities --auto-scaling-group-name web-asg")).Activities;
    expect(activities[0].Description).toBe(`Terminating EC2 instance: ${victim}`);
    expect(activities.some((a: { Cause: string }) => /^At \S+Z an instance was started in response to a difference between desired and actual capacity/.test(a.Cause))).toBe(true);

    const policy = await json(
      `aws autoscaling put-scaling-policy --auto-scaling-group-name web-asg --policy-name cpu50 --policy-type TargetTrackingScaling --target-tracking-configuration '{"PredefinedMetricSpecification":{"PredefinedMetricType":"ASGAverageCPUUtilization"},"TargetValue":50}'`,
    );
    expect(policy.PolicyARN).toContain(":scalingPolicy:");
    expect(policy.Alarms).toHaveLength(2);
    expect((await json("aws autoscaling describe-policies --auto-scaling-group-name web-asg")).ScalingPolicies[0]).toMatchObject({
      PolicyName: "cpu50",
      TargetTrackingConfiguration: { TargetValue: 50 },
    });

    expect(await fails("aws autoscaling delete-auto-scaling-group --auto-scaling-group-name web-asg")).toMatchObject({ code: "ResourceInUse" });
    await json("aws autoscaling delete-auto-scaling-group --auto-scaling-group-name web-asg --force-delete");
    expect((await json("aws autoscaling describe-auto-scaling-groups")).AutoScalingGroups).toEqual([]);
  });

  it("checks permissions with the elasticloadbalancing and autoscaling prefixes", async () => {
    await json(`aws iam create-user --user-name viewer`);
    await json(`aws iam attach-user-policy --user-name viewer --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess`);
    const d = await defaults();
    const asViewer = { ...ctx(), principal: await resolvePrincipal(engine, "acct-elb", { kind: "user", name: "viewer" }) };
    const ok = await executeCli("aws elbv2 describe-load-balancers", asViewer);
    const denied = await executeCli(`aws elbv2 create-target-group --name x --protocol HTTP --port 80 --vpc-id ${d.vpc}`, asViewer);
    expect(ok.exitCode, ok.output).toBe(0);
    expect(denied.output).toContain("elasticloadbalancing:CreateTargetGroup");
  });
});
