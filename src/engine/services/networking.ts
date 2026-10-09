import { cidrContains, cidrOverlaps, parseCidr, usableHosts } from "../cidr";
import { EngineError } from "../errors";
import type { FieldDef, ResourceTypeDef, ServiceDef } from "../types";
import { internetGateway, routeTable } from "./routing";

const nameField = (label: string, required = false): FieldDef => ({
  key: "name",
  label,
  type: "string",
  required,
  maxLength: 255,
  placeholder: "my-resource",
});

const vpc: ResourceTypeDef = {
  service: "networking",
  type: "vpc",
  label: "VPC",
  pluralLabel: "VPCs",
  description: "An isolated private network. Subnets, instances and security groups live inside it.",
  idPrefix: "vpc",
  notFoundCode: "InvalidVpcID.NotFound",
  fields: [
    nameField("Name tag"),
    {
      key: "cidrBlock",
      label: "IPv4 CIDR block",
      type: "cidr",
      required: true,
      immutable: true,
      prefix: { min: 16, max: 28 },
      default: "10.0.0.0/16",
      description: "The private address range for the whole network. Between /16 and /28.",
    },
    {
      key: "enableDnsHostnames",
      label: "Enable DNS hostnames",
      type: "boolean",
      default: true,
      description: "Give instances with public IPs a public DNS name.",
    },
  ],
  columns: [
    { label: "CIDR", path: "config.cidrBlock", mono: true },
    { label: "DNS hostnames", path: "config.enableDnsHostnames" },
  ],
  lifecycle: { create: { state: "pending", settlesTo: "available", afterMs: 1500 } },
};

const subnet: ResourceTypeDef = {
  service: "networking",
  type: "subnet",
  label: "Subnet",
  pluralLabel: "Subnets",
  description: "A slice of a VPC's address range, pinned to one availability zone.",
  idPrefix: "subnet",
  notFoundCode: "InvalidSubnetID.NotFound",
  fields: [
    nameField("Name tag"),
    {
      key: "vpcId",
      label: "VPC",
      type: "ref",
      required: true,
      immutable: true,
      ref: { service: "networking", type: "vpc" },
    },
    {
      key: "cidrBlock",
      label: "IPv4 CIDR block",
      type: "cidr",
      required: true,
      immutable: true,
      prefix: { min: 16, max: 28 },
      placeholder: "10.0.1.0/24",
      description: "Must sit inside the VPC's block and not overlap other subnets.",
    },
    {
      key: "availabilityZone",
      label: "Availability zone",
      type: "enum",
      required: true,
      immutable: true,
      optionsSource: "availabilityZones",
    },
    {
      key: "mapPublicIpOnLaunch",
      label: "Auto-assign public IPv4",
      type: "boolean",
      default: false,
      description: "Instances launched here get a public IP by default.",
    },
  ],
  columns: [
    { label: "VPC", path: "config.vpcId", mono: true },
    { label: "CIDR", path: "config.cidrBlock", mono: true },
    { label: "AZ", path: "config.availabilityZone" },
    { label: "Usable IPs", path: "attributes.availableIpCount" },
  ],
  lifecycle: { create: { state: "available" } },
  async validate({ config, existing, ctx }) {
    const vpcRes = await ctx.get(config.vpcId as string);
    const block = parseCidr(config.cidrBlock as string);
    const vpcBlock = vpcRes ? parseCidr(vpcRes.config.cidrBlock as string) : null;
    if (!vpcRes || !block || !vpcBlock) return;
    if (!cidrContains(vpcBlock, block)) {
      throw new EngineError(
        "InvalidSubnet.Range",
        `The CIDR '${config.cidrBlock}' is outside the VPC's range ${vpcRes.config.cidrBlock}.`,
      );
    }
    const siblings = (await ctx.list("networking", "subnet")).filter(
      (s) => s.config.vpcId === config.vpcId && s.id !== existing?.id,
    );
    for (const s of siblings) {
      const other = parseCidr(s.config.cidrBlock as string);
      if (other && cidrOverlaps(block, other)) {
        throw new EngineError(
          "InvalidSubnet.Conflict",
          `The CIDR '${config.cidrBlock}' conflicts with subnet ${s.id} (${s.config.cidrBlock}).`,
          409,
        );
      }
    }
  },
  async derive({ config }) {
    const block = parseCidr(config.cidrBlock as string);
    return { availableIpCount: block ? usableHosts(block).count : 0 };
  },
};

const ruleItem: FieldDef[] = [
  {
    key: "protocol",
    label: "Protocol",
    type: "enum",
    required: true,
    default: "tcp",
    options: [
      { value: "tcp", label: "TCP" },
      { value: "udp", label: "UDP" },
      { value: "icmp", label: "ICMP" },
      { value: "all", label: "All traffic" },
    ],
  },
  { key: "fromPort", label: "From port", type: "number", min: 0, max: 65535, placeholder: "22" },
  { key: "toPort", label: "To port", type: "number", min: 0, max: 65535, placeholder: "22" },
  {
    key: "cidr",
    label: "Source / destination",
    type: "cidr",
    required: true,
    prefix: { min: 0, max: 32 },
    placeholder: "0.0.0.0/0",
  },
  { key: "description", label: "Description", type: "string", maxLength: 255 },
];

function checkRules(rules: unknown, direction: string) {
  if (!Array.isArray(rules)) return;
  rules.forEach((rule: Record<string, unknown>, index) => {
    const n = index + 1;
    if (rule.protocol === "tcp" || rule.protocol === "udp") {
      if (rule.fromPort === undefined || rule.toPort === undefined) {
        throw new EngineError(
          "InvalidParameterValue",
          `${direction} rule ${n}: ${String(rule.protocol).toUpperCase()} rules need a port range.`,
        );
      }
      if ((rule.fromPort as number) > (rule.toPort as number)) {
        throw new EngineError(
          "InvalidParameterValue",
          `${direction} rule ${n}: the start port must not be greater than the end port.`,
        );
      }
    }
  });
}

const securityGroup: ResourceTypeDef = {
  service: "networking",
  type: "security-group",
  label: "Security group",
  pluralLabel: "Security groups",
  description: "A stateful firewall attached to instances. Inbound traffic is denied unless a rule allows it.",
  idPrefix: "sg",
  notFoundCode: "InvalidGroup.NotFound",
  fields: [
    {
      key: "name",
      label: "Group name",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 255,
      pattern: "^(?!sg-)[A-Za-z0-9 ._\\-:/()#,@\\[\\]+=&;{}!$*]+$",
      patternMessage: "Group names can't start with 'sg-' and may only use letters, digits, spaces and ._-:/()#,@[]+=&;{}!$*.",
      placeholder: "web-servers",
    },
    {
      key: "description",
      label: "Description",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 255,
      placeholder: "Allow HTTP and SSH",
    },
    {
      key: "vpcId",
      label: "VPC",
      type: "ref",
      required: true,
      immutable: true,
      ref: { service: "networking", type: "vpc" },
    },
    {
      key: "inboundRules",
      label: "Inbound rules",
      type: "list",
      item: ruleItem,
      maxItems: 60,
      description: "Traffic allowed in. Everything else is blocked.",
    },
    {
      key: "outboundRules",
      label: "Outbound rules",
      type: "list",
      item: ruleItem,
      maxItems: 60,
      default: [{ protocol: "all", cidr: "0.0.0.0/0", description: "Allow all outbound" }],
      description: "Traffic allowed out. By default all outbound traffic is allowed.",
    },
  ],
  columns: [
    { label: "VPC", path: "config.vpcId", mono: true },
    { label: "Description", path: "config.description" },
    { label: "Inbound rules", path: "attributes.inboundRuleCount" },
  ],
  async validate({ config, existing, ctx }) {
    checkRules(config.inboundRules, "Inbound");
    checkRules(config.outboundRules, "Outbound");
    const groups = await ctx.list("networking", "security-group");
    const duplicate = groups.find(
      (g) => g.id !== existing?.id && g.config.vpcId === config.vpcId && g.name === config.name,
    );
    if (duplicate) {
      throw new EngineError(
        "InvalidGroup.Duplicate",
        `A security group named '${config.name}' already exists in ${config.vpcId}.`,
        409,
      );
    }
  },
  async derive({ config }) {
    return {
      inboundRuleCount: Array.isArray(config.inboundRules) ? config.inboundRules.length : 0,
      outboundRuleCount: Array.isArray(config.outboundRules) ? config.outboundRules.length : 0,
    };
  },
};

export const networkingService: ServiceDef = {
  id: "networking",
  label: "Virtual Network",
  modelledOn: "VPC",
  description: "Private networks, subnets, routing, gateways and firewalls.",
  category: "Networking",
  types: [vpc, subnet, internetGateway, routeTable, securityGroup],
};
