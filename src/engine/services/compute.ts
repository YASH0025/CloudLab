import { IMAGES } from "../catalog";
import { intToIp, ipToInt, parseCidr, usableHosts } from "../cidr";
import { EngineError } from "../errors";
import type { ResourceTypeDef, ServiceDef } from "../types";

/** Public IPs come from 203.0.113.0/24, a range reserved for documentation, so they are clearly not real. */
function randomPublicIp(): string {
  return `203.0.113.${1 + Math.floor(Math.random() * 254)}`;
}

const instance: ResourceTypeDef = {
  service: "compute",
  type: "instance",
  label: "Instance",
  pluralLabel: "Instances",
  description: "A virtual server launched from a machine image into a subnet.",
  idPrefix: "i",
  notFoundCode: "InvalidInstanceID.NotFound",
  fields: [
    { key: "name", label: "Name", type: "string", maxLength: 255, placeholder: "web-server-1" },
    {
      key: "imageId",
      label: "Machine image",
      type: "enum",
      required: true,
      immutable: true,
      optionsSource: "images",
    },
    {
      key: "instanceType",
      label: "Instance type",
      type: "enum",
      required: true,
      default: "t3.micro",
      optionsSource: "instanceTypes",
      mutableInStates: ["stopped"],
      description: "Can only be changed while the instance is stopped.",
    },
    {
      key: "subnetId",
      label: "Subnet",
      type: "ref",
      required: true,
      immutable: true,
      ref: { service: "networking", type: "subnet" },
    },
    {
      key: "securityGroupIds",
      label: "Security groups",
      type: "ref",
      required: true,
      ref: { service: "networking", type: "security-group", multiple: true },
      description: "Must belong to the same VPC as the subnet.",
    },
    {
      key: "associatePublicIp",
      label: "Auto-assign public IP",
      type: "enum",
      required: true,
      immutable: true,
      default: "subnet-default",
      options: [
        { value: "subnet-default", label: "Use subnet setting" },
        { value: "enable", label: "Enable" },
        { value: "disable", label: "Disable" },
      ],
    },
    {
      key: "keyName",
      label: "Key pair name",
      type: "string",
      immutable: true,
      maxLength: 255,
      placeholder: "my-key",
      description: "Without a key pair you cannot SSH in.",
    },
  ],
  columns: [
    { label: "Type", path: "config.instanceType" },
    { label: "AZ", path: "attributes.availabilityZone" },
    { label: "Private IP", path: "attributes.privateIp", mono: true },
    { label: "Public IP", path: "attributes.publicIp", mono: true },
  ],
  lifecycle: {
    create: { state: "pending", settlesTo: "running", afterMs: 8000 },
    actions: {
      stop: { label: "Stop", from: ["running"], via: "stopping", to: "stopped", afterMs: 5000 },
      start: { label: "Start", from: ["stopped"], via: "pending", to: "running", afterMs: 6000 },
      reboot: { label: "Reboot", from: ["running"], via: "rebooting", to: "running", afterMs: 4000 },
      terminate: {
        label: "Terminate",
        from: ["pending", "running", "stopping", "stopped"],
        via: "shutting-down",
        to: "terminated",
        afterMs: 5000,
        destructive: true,
      },
    },
    inactiveStates: ["terminated"],
    deletableStates: ["terminated"],
  },
  async validate({ config, ctx }) {
    const subnet = await ctx.get(config.subnetId as string);
    if (!subnet) return;
    const vpcId = subnet.config.vpcId as string;
    for (const sgId of (config.securityGroupIds as string[]) ?? []) {
      const sg = await ctx.get(sgId);
      if (sg && sg.config.vpcId !== vpcId) {
        throw new EngineError(
          "InvalidParameter",
          `Security group ${sgId} belongs to ${sg.config.vpcId}, but subnet ${subnet.id} is in ${vpcId}. They must be in the same VPC.`,
        );
      }
    }
  },
  async derive({ config, existing, ctx }) {
    const subnet = await ctx.get(config.subnetId as string);
    if (!subnet) return existing?.attributes ?? {};
    // Network identity is fixed at launch; later edits keep it.
    if (existing) return existing.attributes;

    const block = parseCidr(subnet.config.cidrBlock as string);
    let privateIp: string | null = null;
    if (block) {
      const used = new Set(
        (await ctx.list("compute", "instance"))
          .filter((i) => i.config.subnetId === subnet.id)
          .map((i) => ipToInt(String(i.attributes.privateIp ?? "")))
          .filter((n): n is number => n !== null),
      );
      const hosts = usableHosts(block);
      for (let ip = hosts.first; ip <= hosts.last; ip++) {
        if (!used.has(ip)) {
          privateIp = intToIp(ip);
          break;
        }
      }
      if (!privateIp) {
        throw new EngineError(
          "InsufficientFreeAddressesInSubnet",
          `Subnet ${subnet.id} has no free IP addresses left.`,
          409,
        );
      }
    }

    const wantsPublic =
      config.associatePublicIp === "enable" ||
      (config.associatePublicIp === "subnet-default" && subnet.config.mapPublicIpOnLaunch === true);
    const image = IMAGES.find((img) => img.id === config.imageId);
    return {
      vpcId: subnet.config.vpcId,
      availabilityZone: subnet.config.availabilityZone,
      privateIp,
      publicIp: wantsPublic ? randomPublicIp() : null,
      platform: image?.platform ?? "linux",
      defaultUser: image?.defaultUser ?? null,
    };
  },
};

export const computeService: ServiceDef = {
  id: "compute",
  label: "Compute",
  modelledOn: "EC2",
  description: "Virtual servers you launch, stop, start and terminate.",
  category: "Compute",
  types: [instance],
};
