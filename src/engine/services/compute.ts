import { IMAGES } from "../catalog";
import { EngineError } from "../errors";
import { generateId } from "../ids";
import { generateKey, type KeyType } from "../keys";
import type { Resource, ResourceTypeDef, ServiceDef, SystemApi } from "../types";
import { freePublicIp, nextPrivateIp } from "./ips";

/** Whether an instance gets an automatic public IP when it runs (launch setting or subnet default). */
async function autoPublicIp(instance: Resource, get: (id: string) => Promise<Resource | null>): Promise<boolean> {
  if (typeof instance.attributes.autoPublicIp === "boolean") return instance.attributes.autoPublicIp;
  if (instance.config.associatePublicIp === "enable") return true;
  if (instance.config.associatePublicIp === "disable") return false;
  const subnet = await get(instance.config.subnetId as string);
  return subnet?.config.mapPublicIpOnLaunch === true;
}

/** States in which an instance holds no automatic public IP. */
const OFFLINE = ["stopped", "terminated", "shutting-down"];

/**
 * Gives an instance its own public IP back after an Elastic IP leaves it: a fresh
 * automatic one if it should have one and is running, otherwise none.
 */
async function restorePublicIp(system: SystemApi, instanceId: string): Promise<void> {
  const instance = await system.get(instanceId);
  if (!instance) return;
  const online = !OFFLINE.includes(instance.state ?? "") && !OFFLINE.includes(instance.pendingState ?? "");
  const publicIp = online && (await autoPublicIp(instance, system.get)) ? await freePublicIp(system.list) : null;
  await system.setAttributes(instanceId, { publicIp, elasticIp: null });
}

// ---------- key pairs ----------

const keyPair: ResourceTypeDef = {
  service: "compute",
  type: "key-pair",
  label: "Key pair",
  pluralLabel: "Key pairs",
  description:
    "An SSH key pair for logging in to Linux instances. The platform keeps the public key; you download the private key once, when you create it.",
  idPrefix: "key",
  notFoundCode: "InvalidKeyPair.NotFound",
  apiNoun: "key pair",
  revealOnce: ["keyMaterial"],
  fields: [
    {
      key: "name",
      label: "Name",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 255,
      param: "KeyName",
      placeholder: "my-key",
      description: "Unique in this region. You pass it to instances as the key pair name.",
    },
    {
      key: "keyType",
      label: "Key pair type",
      type: "enum",
      required: true,
      immutable: true,
      default: "rsa",
      param: "KeyType",
      options: [
        { value: "rsa", label: "RSA", hint: "2048-bit, works everywhere" },
        { value: "ed25519", label: "ED25519", hint: "Smaller and faster, Linux only" },
      ],
    },
  ],
  columns: [
    { label: "Type", path: "config.keyType" },
    { label: "Fingerprint", path: "attributes.fingerprint", mono: true },
  ],
  async validate({ config, existing, ctx }) {
    if (existing) return;
    const name = config.name as string;
    if (!/^[\x20-\x7e]+$/.test(name)) {
      throw new EngineError("InvalidParameterValue", `Value (${name}) for parameter KeyName is invalid. Key names may only contain ASCII characters.`);
    }
    if ((await ctx.list("compute", "key-pair")).some((k) => k.name === name)) {
      throw new EngineError("InvalidKeyPair.Duplicate", `The keypair '${name}' already exists.`);
    }
  },
  async derive({ config, existing }) {
    if (existing) return existing.attributes;
    const key = generateKey(config.keyType as KeyType, config.name as string);
    return { fingerprint: key.fingerprint, publicKey: key.publicKey, keyMaterial: key.keyMaterial };
  },
};

// ---------- instances ----------

const instance: ResourceTypeDef = {
  service: "compute",
  type: "instance",
  label: "Instance",
  pluralLabel: "Instances",
  description: "A virtual server launched from a machine image into a subnet.",
  idPrefix: "i",
  notFoundCode: "InvalidInstanceID.NotFound",
  apiNoun: "instance",
  stateErrorCode: "IncorrectInstanceState",
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
      description: "An automatic public IP changes every time the instance stops and starts. Use an Elastic IP for a fixed one.",
    },
    {
      key: "keyName",
      label: "Key pair",
      type: "ref",
      immutable: true,
      ref: { service: "compute", type: "key-pair", by: "name" },
      description: "Without a key pair you cannot SSH in. Deleting the key pair later doesn't affect the instance.",
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
      stop: { label: "Stop", from: ["running"], via: "stopping", to: "stopped", afterMs: 5000, pastTense: "stopped" },
      start: { label: "Start", from: ["stopped"], via: "pending", to: "running", afterMs: 6000, pastTense: "started" },
      reboot: { label: "Reboot", from: ["running"], via: "rebooting", to: "running", afterMs: 4000, pastTense: "rebooted" },
      terminate: {
        label: "Terminate",
        pastTense: "terminated",
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
  invalidValue({ field, value }) {
    if (field.key === "imageId") {
      const id = String(value);
      return id.startsWith("ami-")
        ? new EngineError("InvalidAMIID.NotFound", `The image id '[${id}]' does not exist`)
        : new EngineError("InvalidAMIID.Malformed", `Invalid id: "${id}" (expecting "ami-...")`);
    }
    if (field.key === "instanceType") {
      return new EngineError("InvalidParameterValue", `The following supplied instance types do not exist: [${value}]`);
    }
    return undefined;
  },
  async validate({ config, ctx }) {
    const subnet = await ctx.get(config.subnetId as string);
    if (!subnet) return;
    const vpcId = subnet.config.vpcId as string;
    for (const sgId of (config.securityGroupIds as string[]) ?? []) {
      const sg = await ctx.get(sgId);
      if (sg && sg.config.vpcId !== vpcId) {
        throw new EngineError("InvalidParameter", `Security group ${sgId} and subnet ${subnet.id} belong to different networks.`);
      }
    }
  },
  async derive({ config, existing, ctx }) {
    const subnet = await ctx.get(config.subnetId as string);
    if (!subnet) return existing?.attributes ?? {};
    // Network identity is fixed at launch; later edits keep it.
    if (existing) return existing.attributes;

    const privateIp = await nextPrivateIp(ctx.list, subnet);

    const wantsPublic =
      config.associatePublicIp === "enable" ||
      (config.associatePublicIp === "subnet-default" && subnet.config.mapPublicIpOnLaunch === true);
    const image = IMAGES.find((img) => img.id === config.imageId);
    return {
      vpcId: subnet.config.vpcId,
      availabilityZone: subnet.config.availabilityZone,
      privateIp,
      autoPublicIp: wantsPublic,
      publicIp: wantsPublic ? await freePublicIp(ctx.list) : null,
      elasticIp: null,
      platform: image?.platform ?? "linux",
      defaultUser: image?.defaultUser ?? null,
    };
  },
  /**
   * Public IPs follow the real rules: an automatic one is released when the
   * instance stops and a new one is assigned when it starts. An Elastic IP stays
   * through stop and start, and is disassociated when the instance terminates.
   */
  async onSettled({ resource, system }) {
    const elasticIp = resource.attributes.elasticIp as string | null | undefined;
    if (resource.state === "terminated") {
      for (const eip of await system.list("compute", "elastic-ip")) {
        if (eip.config.instanceId === resource.id) await system.update(eip.id, { instanceId: null });
      }
      await system.setAttributes(resource.id, { publicIp: null, elasticIp: null });
      return;
    }
    if (elasticIp) return;
    if (resource.state === "stopped" && resource.attributes.publicIp) {
      await system.setAttributes(resource.id, { publicIp: null });
    }
    if (resource.state === "running" && !resource.attributes.publicIp && (await autoPublicIp(resource, system.get))) {
      await system.setAttributes(resource.id, { publicIp: await freePublicIp(system.list) });
    }
  },
};

// ---------- Elastic IPs ----------

/** Addresses an account may hold per region, like the real default quota. */
export const ELASTIC_IP_LIMIT = 5;

const elasticIp: ResourceTypeDef = {
  service: "compute",
  type: "elastic-ip",
  label: "Elastic IP",
  pluralLabel: "Elastic IPs",
  description:
    "A fixed public IPv4 address you keep until you release it. Associate it with an instance so its address survives stop and start.",
  idPrefix: "eipalloc",
  notFoundCode: "InvalidAllocationID.NotFound",
  apiNoun: "allocation",
  canDelete: (eip) =>
    eip.attributes.natGatewayId || (eip.config.instanceId && !eip.attributes.inDefaultVpc)
      ? new EngineError("InvalidIPAddress.InUse", `Address ${eip.attributes.publicIp} is in use.`)
      : undefined,
  fields: [
    { key: "name", label: "Name tag", type: "string", maxLength: 255, placeholder: "web-ip" },
    {
      key: "instanceId",
      label: "Associated instance",
      type: "ref",
      // Terminating and deleting the instance just leaves the address unassociated.
      ref: { service: "compute", type: "instance", weak: true },
      description:
        "Choose None to disassociate. To move the address to another instance, disassociate it first. The instance's VPC needs an internet gateway.",
    },
  ],
  columns: [
    { label: "Public IP", path: "attributes.publicIp", mono: true },
    { label: "Instance", path: "config.instanceId", mono: true },
    { label: "NAT gateway", path: "attributes.natGatewayId", mono: true },
    { label: "Private IP", path: "attributes.privateIp", mono: true },
  ],
  async validate({ config, existing, ctx }) {
    if (!existing && (await ctx.list("compute", "elastic-ip")).length >= ELASTIC_IP_LIMIT) {
      throw new EngineError("AddressLimitExceeded", "The maximum number of addresses has been reached.");
    }
    const before = (existing?.config.instanceId as string | undefined) || undefined;
    const after = (config.instanceId as string | undefined) || undefined;
    if (!after || before === after) return;
    if (before || existing?.attributes.natGatewayId) {
      throw new EngineError(
        "Resource.AlreadyAssociated",
        `resource ${existing!.id} is already associated with associate-id ${existing!.attributes.associationId}`,
      );
    }
    const target = await ctx.get(after);
    if (!target) return;
    if (!["running", "stopped"].includes(target.state ?? "")) {
      throw new EngineError("IncorrectInstanceState", `The instance '${after}' is not in a valid state for this operation.`);
    }
    const vpcId = target.attributes.vpcId as string;
    const gateways = await ctx.list("networking", "internet-gateway");
    if (!gateways.some((g) => g.config.vpcId === vpcId)) {
      throw new EngineError("Gateway.NotAttached", `Network ${vpcId} is not attached to any internet gateway`);
    }
  },
  async derive({ config, existing, ctx }) {
    const publicIp = (existing?.attributes.publicIp as string | undefined) ?? (await freePublicIp(ctx.list));
    const base = { publicIp, domain: "vpc", networkBorderGroup: ctx.region };
    // A NAT gateway's address stays with it until the gateway is deleted.
    if (existing?.attributes.natGatewayId) {
      const { natGatewayId, associationId, privateIp } = existing.attributes;
      return { ...base, natGatewayId, associationId, privateIp, inDefaultVpc: false };
    }
    const instanceId = (config.instanceId as string | undefined) || undefined;
    if (!instanceId) return { ...base, associationId: null, privateIp: null, inDefaultVpc: false };
    const target = await ctx.get(instanceId);
    const vpc = target ? await ctx.get(target.attributes.vpcId as string) : null;
    const same = existing?.config.instanceId === instanceId;
    return {
      ...base,
      associationId: same ? existing!.attributes.associationId : generateId("eipassoc"),
      privateIp: target?.attributes.privateIp ?? null,
      inDefaultVpc: Boolean((vpc?.attributes.system as { isDefault?: boolean } | undefined)?.isDefault),
    };
  },
  async afterCreate({ resource, system }) {
    if (resource.config.instanceId) await associate(resource, system);
  },
  async afterUpdate({ resource, previous, system }) {
    const before = previous.config.instanceId as string | undefined;
    const after = resource.config.instanceId as string | undefined;
    if (before === after) return;
    if (before) await restorePublicIp(system, before);
    if (after) await associate(resource, system);
  },
  async afterDelete({ resource, system }) {
    // Releasing an associated address (allowed in a default VPC) disassociates it first.
    if (resource.config.instanceId) await restorePublicIp(system, resource.config.instanceId as string);
  },
};

/** Points an instance at an Elastic IP, taking it off any other address the instance had. */
async function associate(eip: Resource, system: SystemApi) {
  const instanceId = eip.config.instanceId as string;
  for (const other of await system.list("compute", "elastic-ip")) {
    if (other.id !== eip.id && other.config.instanceId === instanceId) await system.update(other.id, { instanceId: null });
  }
  await system.setAttributes(instanceId, { publicIp: eip.attributes.publicIp, elasticIp: eip.id });
}

export const computeService: ServiceDef = {
  id: "compute",
  label: "Compute",
  modelledOn: "EC2",
  description: "Virtual servers you launch, stop, start and terminate, with their key pairs and Elastic IPs.",
  category: "Compute",
  types: [instance, keyPair, elasticIp],
};
