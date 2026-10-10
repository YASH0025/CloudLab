import { randomUUID } from "node:crypto";
import { EngineError } from "../errors";
import { ec2Arn } from "../iam/arns";
import { accountNumber } from "../ids";
import { systemOf, type Resource, type ResourceTypeDef, type ServiceDef } from "../types";

/**
 * Launch templates (a recipe for new instances) and Auto Scaling groups, which
 * keep the right number of healthy instances running: they replace failed ones
 * and add or remove instances as load changes.
 */

// ---------- launch templates ----------

export const launchTemplate: ResourceTypeDef = {
  service: "compute",
  type: "launch-template",
  label: "Launch template",
  pluralLabel: "Launch templates",
  description: "A saved recipe for launching instances: image, type, security groups, key pair and role. Auto Scaling uses it to launch identical servers.",
  idPrefix: "lt",
  notFoundCode: "InvalidLaunchTemplateId.NotFound",
  notFoundMessage: (id) => `The specified launch template, with template ID ${id}, does not exist.`,
  malformedCode: "InvalidLaunchTemplateId.Malformed",
  apiNoun: "launch template",
  fields: [
    {
      key: "name",
      label: "Template name",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 128,
      pattern: "^[A-Za-z0-9()./_-]+$",
      patternMessage: "Letters, numbers and ( ) . / _ - only.",
      placeholder: "web-template",
    },
    { key: "imageId", label: "Machine image", type: "enum", required: true, optionsSource: "images" },
    { key: "instanceType", label: "Instance type", type: "enum", required: true, default: "t3.micro", optionsSource: "instanceTypes" },
    {
      key: "securityGroupIds",
      label: "Security groups",
      type: "ref",
      required: true,
      ref: { service: "networking", type: "security-group", multiple: true },
      description: "Must be in the VPC the Auto Scaling group launches into.",
    },
    { key: "keyName", label: "Key pair", type: "ref", ref: { service: "compute", type: "key-pair", by: "name" } },
    { key: "iamRole", label: "IAM role", type: "ref", ref: { service: "iam", type: "role", by: "name" } },
    {
      key: "associatePublicIp",
      label: "Auto-assign public IP",
      type: "enum",
      required: true,
      default: "subnet-default",
      options: [
        { value: "subnet-default", label: "Use subnet setting" },
        { value: "enable", label: "Enable" },
        { value: "disable", label: "Disable" },
      ],
      description: "Behind a load balancer, servers don't need public IPs: keep them in private subnets.",
    },
    {
      key: "userData",
      label: "User data",
      type: "json",
      description: "A startup script, e.g. one that installs a web server. Stored and shown; CloudLab doesn't run it.",
    },
  ],
  columns: [
    { label: "Image", path: "config.imageId", mono: true },
    { label: "Type", path: "config.instanceType" },
    { label: "Version", path: "attributes.latestVersion" },
  ],
  iam: {
    create: "ec2:CreateLaunchTemplate",
    read: "ec2:DescribeLaunchTemplates",
    update: "ec2:CreateLaunchTemplateVersion",
    delete: "ec2:DeleteLaunchTemplate",
    arn: ec2Arn("launch-template"),
  },
  invalidValue({ field, value }) {
    if (field.key === "imageId") return new EngineError("InvalidAMIID.NotFound", `The image id '[${value}]' does not exist`);
    return undefined;
  },
  async validate({ config, existing, ctx }) {
    if (!existing && (await ctx.list("compute", "launch-template")).some((t) => t.name === config.name)) {
      throw new EngineError("InvalidLaunchTemplateName.AlreadyExistsException", `Launch template name already in use.`);
    }
    // The user data field is free text, not JSON.
  },
  async derive({ existing, config }) {
    const changed = existing && JSON.stringify({ ...existing.config, name: "" }) !== JSON.stringify({ ...config, name: "" });
    const version = existing ? Number(existing.attributes.latestVersion ?? 1) + (changed ? 1 : 0) : 1;
    return { latestVersion: version, defaultVersion: version };
  },
};

// The "json" field type validates JSON; user data is plain text, so override it to a string field.
launchTemplate.fields = launchTemplate.fields.map((f) => (f.key === "userData" ? { ...f, type: "string", maxLength: 16384 } : f));

// ---------- Auto Scaling groups ----------

export const ASG_ARN = /^arn:aws:autoscaling:[a-z0-9-]+:\d{12}:autoScalingGroup:[0-9a-f-]{36}:autoScalingGroupName\/[\w.@-]{1,255}$/;

/** Simulated demand, in total "CPU percent" across the group. CloudLab's stand-in for real traffic. */
export const TRAFFIC: Record<string, { label: string; load: number }> = {
  idle: { label: "Idle", load: 10 },
  normal: { label: "Normal", load: 70 },
  busy: { label: "Busy", load: 180 },
  spike: { label: "Spike", load: 400 },
};

export const MAX_GROUP_SIZE = 10;

const autoScalingGroup: ResourceTypeDef = {
  service: "autoscaling",
  type: "auto-scaling-group",
  label: "Auto Scaling group",
  pluralLabel: "Auto Scaling groups",
  description:
    "Keeps the number of healthy instances you ask for: launches them from a template across zones, replaces any that fail, and can grow and shrink with load.",
  idPrefix: "asg",
  makeId: ({ name, region, accountId }) =>
    `arn:aws:autoscaling:${region}:${accountNumber(accountId)}:autoScalingGroup:${randomUUID()}:autoScalingGroupName/${name}`,
  idPattern: ASG_ARN,
  panelAttributes: ["activities", "lastScaledAt", "policyName"],
  notFoundCode: "ValidationError",
  notFoundMessage: (id) => `AutoScalingGroup name not found - AutoScalingGroup ${id.split("/").pop()} not found`,
  malformedCode: "ValidationError",
  apiNoun: "Auto Scaling group",
  fields: [
    {
      key: "name",
      label: "Group name",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 255,
      pattern: "^[\\w.@-]+$",
      patternMessage: "Letters, numbers and . @ _ - only.",
      placeholder: "web-asg",
    },
    { key: "launchTemplate", label: "Launch template", type: "ref", required: true, ref: { service: "compute", type: "launch-template", by: "name" } },
    {
      key: "subnetIds",
      label: "Subnets",
      type: "ref",
      required: true,
      ref: { service: "networking", type: "subnet", multiple: true },
      description: "Pick subnets in two or more zones: instances are spread across them, so one zone failing doesn't take you down.",
    },
    { key: "minSize", label: "Minimum", type: "number", required: true, default: 1, min: 0, max: MAX_GROUP_SIZE },
    { key: "desiredCapacity", label: "Desired", type: "number", required: true, default: 2, min: 0, max: MAX_GROUP_SIZE },
    { key: "maxSize", label: "Maximum", type: "number", required: true, default: 4, min: 0, max: MAX_GROUP_SIZE },
    {
      key: "targetGroupIds",
      label: "Target groups",
      type: "ref",
      ref: { service: "loadbalancing", type: "target-group", multiple: true },
      description: "New instances are registered here automatically, so the load balancer sends them traffic.",
    },
    {
      key: "healthCheckType",
      label: "Health checks",
      type: "enum",
      required: true,
      default: "EC2",
      options: [
        { value: "EC2", label: "EC2", hint: "Replace instances that stop or fail" },
        { value: "ELB", label: "ELB", hint: "Also replace instances the load balancer reports unhealthy" },
      ],
    },
    {
      key: "healthCheckGracePeriod",
      label: "Health check grace period (seconds)",
      type: "number",
      default: 30,
      min: 0,
      max: 3600,
      description: "Time a new instance gets to start before its health counts. AWS's default is 300; CloudLab uses 30 so you can watch it.",
    },
    {
      key: "targetCpu",
      label: "Target tracking: average CPU %",
      type: "number",
      min: 10,
      max: 90,
      placeholder: "50",
      description: "Optional scaling policy: add instances when average CPU is above this, remove them when it's well below. Leave empty for a fixed size.",
    },
    {
      key: "simulatedTraffic",
      label: "Simulated traffic (CloudLab)",
      type: "enum",
      required: true,
      default: "normal",
      options: Object.entries(TRAFFIC).map(([value, t]) => ({ value, label: t.label })),
      description: "Not an AWS setting: turn the load up or down to watch target tracking scale the group.",
    },
  ],
  columns: [
    { label: "Instances", path: "attributes.instanceCount" },
    { label: "Desired", path: "config.desiredCapacity" },
    { label: "Min", path: "config.minSize" },
    { label: "Max", path: "config.maxSize" },
  ],
  iam: {
    create: "autoscaling:CreateAutoScalingGroup",
    read: "autoscaling:DescribeAutoScalingGroups",
    update: (changed) => [
      ...(changed.includes("targetCpu") ? ["autoscaling:PutScalingPolicy"] : []),
      ...(changed.some((c) => c !== "targetCpu") ? ["autoscaling:UpdateAutoScalingGroup"] : []),
    ],
    delete: "autoscaling:DeleteAutoScalingGroup",
    arn: (r) => r.id,
  },
  async validate({ config, existing, ctx }) {
    if (!existing && (await ctx.list("autoscaling", "auto-scaling-group")).some((g) => g.name === config.name)) {
      throw new EngineError("AlreadyExists", `AutoScalingGroup by this name already exists - A group with the name ${config.name} already exists`);
    }
    const min = Number(config.minSize);
    const max = Number(config.maxSize);
    const desired = Number(config.desiredCapacity);
    if (min > max) throw new EngineError("ValidationError", `Max bound, ${max}, must be greater than or equal to min bound, ${min}`);
    if (desired < min || desired > max) {
      throw new EngineError("ValidationError", `Desired capacity:${desired} must be between the specified min size:${min} and max size:${max}`);
    }
    const subnets = (await Promise.all(((config.subnetIds as string[]) ?? []).map((id) => ctx.get(id)))).filter((s): s is Resource => !!s);
    const vpcs = new Set(subnets.map((s) => s.config.vpcId));
    if (vpcs.size > 1) throw new EngineError("ValidationError", "The subnets of an Auto Scaling group must all be in the same VPC.");
    const vpcId = [...vpcs][0];
    const template = (await ctx.list("compute", "launch-template")).find((t) => t.name === config.launchTemplate);
    for (const sgId of (template?.config.securityGroupIds as string[] | undefined) ?? []) {
      const sg = await ctx.get(sgId);
      if (sg && sg.config.vpcId !== vpcId) {
        throw new EngineError("ValidationError", `The launch template's security group ${sgId} and subnet ${subnets[0]?.id} belong to different networks.`);
      }
    }
    for (const tgId of (config.targetGroupIds as string[]) ?? []) {
      const tg = await ctx.get(tgId);
      if (tg && tg.config.vpcId !== vpcId) {
        throw new EngineError("ValidationError", `The target group ${tg.name} is in a different VPC from the group's subnets.`);
      }
    }
  },
  async derive({ existing }) {
    // The group's live numbers (instances, CPU, activities) are kept up to date by the scaling pass.
    return existing
      ? existing.attributes
      : { instanceCount: 0, averageCpu: 0, activities: [], lastScaledAt: null };
  },
  async beforeDelete({ resource, ctx, force, system }) {
    const members = (await ctx.list("compute", "instance")).filter(
      (i) => systemOf(i).managedBy === resource.id && i.state !== "terminated" && i.state !== "shutting-down",
    );
    if (members.length === 0) return;
    if (!force) {
      throw new EngineError(
        "ResourceInUse",
        "You cannot delete an AutoScalingGroup while there are instances or pending Spot instance request(s) still in the group.",
      );
    }
    for (const m of members) await system.runAction(m.id, "terminate");
  },
};

export const autoScalingService: ServiceDef = {
  id: "autoscaling",
  label: "Auto Scaling",
  modelledOn: "EC2 Auto Scaling",
  description: "Groups that keep the right number of healthy instances running, and grow or shrink with demand.",
  category: "Compute",
  types: [autoScalingGroup],
};
