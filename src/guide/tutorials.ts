import { analyzeReachability, type ReachabilityInput, type ReachabilityResult } from "@/engine/analysis/reachability";
import { availabilityZones } from "@/engine/catalog";
import type { Engine } from "@/engine/engine";
import { systemOf, type Resource } from "@/engine/types";
import {
  coversPort,
  effectiveRouteTable,
  focusVpc,
  freeSubnetCidr,
  inboundRules,
  isOwn,
  isPublicSubnet,
  label,
  routesToNat,
  takeSnapshot,
  type SgRule,
  type Snapshot,
} from "./snapshot";
import type { GuideLink, Level, TutorialInfo, TutorialView } from "./types";

/**
 * Guided tutorials: full journeys from the first step to the last. Each step
 * explains why, says what to do, links to the right (pre-filled) form, gives
 * the CLI command, and has a check that looks at the learner's real
 * resources. Adding a tutorial means adding an entry to TUTORIALS.
 */

/** What a step's text and check can look at: the snapshot plus the resources the learner is working with. */
interface Ctx {
  s: Snapshot;
  region: string;
  vpc?: Resource;
  /** Subnets of the focus VPC. */
  subnets: Resource[];
  /** The subnet with auto-assign public IP on, else the first one. */
  publicSubnet?: Resource;
  /** Internet gateway attached to the focus VPC. */
  gateway?: Resource;
  /** One of the learner's own route tables in the focus VPC, preferring the one the public subnet uses. */
  table?: Resource;
  /** The route table the instance's subnet actually uses (explicit, else the VPC's main table). */
  liveTable?: Resource;
  /** A security group in the focus VPC, preferring one that allows HTTP. */
  group?: Resource;
  /** Newest instance in the focus VPC. */
  instance?: Resource;
  /** HTTP reachability of `instance` from the internet (computed once, on demand). */
  reach(): Promise<ReachabilityResult | null>;

  // ---- for the intermediate tutorials ----
  /** A subnet that is public by routing (0.0.0.0/0 → attached internet gateway), else `publicSubnet`. */
  pubSub?: Resource;
  /** A subnet with no route to an internet gateway, preferring one that routes to a NAT gateway. */
  privateSubnet?: Resource;
  /** NAT gateway in the focus VPC, preferring one in a public subnet. */
  nat?: Resource;
  /** An Elastic IP not attached to anything. */
  spareEip?: Resource;
  keyPair?: Resource;
  /** The VPC's "default" security group. */
  defaultGroup?: Resource;
  /** Newest instance in a private subnet. */
  privateInstance?: Resource;
  /** A group allowing SSH from an address range, preferring one named "bastion". */
  bastionGroup?: Resource;
  /** A running instance in a public subnet using the bastion group. */
  bastion?: Resource;
  /** A group allowing PostgreSQL (5432) from another security group. */
  dbGroup?: Resource;
  /** Instance in a public subnet using the web group (`group`). */
  webServer?: Resource;
  /** Instance in a private subnet using the database group. */
  dbServer?: Resource;
  /** Runs a reachability check (memoised per instance and input). */
  check(instance: Resource | undefined, input: ReachabilityInput): Promise<ReachabilityResult | null>;
}

type Dyn<T> = T | ((c: Ctx) => T);

interface StepDef {
  id: string;
  title: Dyn<string>;
  why: string;
  instructions: Dyn<string[]>;
  link?: (c: Ctx) => GuideLink | undefined;
  cli?: (c: Ctx) => string | undefined;
  check: (c: Ctx) => boolean | Promise<boolean>;
}

interface TutorialDef {
  id: string;
  title: string;
  level: Level;
  summary: string;
  minutes: number;
  nextId?: string;
  steps: StepDef[];
}

const resolve = <T,>(v: Dyn<T>, c: Ctx): T => (typeof v === "function" ? (v as (c: Ctx) => T)(c) : v);

const allowsHttp = (g: Resource) =>
  ((g.config.inboundRules as SgRule[]) ?? []).some(
    (r) =>
      r.cidr === "0.0.0.0/0" &&
      (r.protocol === "all" || (r.protocol === "tcp" && (r.fromPort ?? -1) <= 80 && (r.toPort ?? -1) >= 80)),
  );

const routes = (t: Resource) => (t.config.routes as { destination: string; gatewayId: string }[]) ?? [];
const subnetIds = (t: Resource) => (t.config.subnetIds as string[]) ?? [];

async function buildCtx(engine: Engine, accountId: string, region: string): Promise<Ctx> {
  const s = await takeSnapshot(engine, accountId, region);
  // Tutorials teach building your own network, so the platform's default VPC is ignored.
  const vpc = focusVpc(s, false);
  const subnets = vpc ? s.subnets.filter((x) => x.config.vpcId === vpc.id) : [];
  const publicSubnet = subnets.find((x) => x.config.mapPublicIpOnLaunch) ?? subnets[0];
  const gateway = vpc ? s.gateways.find((g) => g.config.vpcId === vpc.id) : undefined;
  const vpcTables = vpc ? s.routeTables.filter((t) => t.config.vpcId === vpc.id && isOwn(t)) : [];
  const table = vpcTables.find((t) => publicSubnet && subnetIds(t).includes(publicSubnet.id)) ?? vpcTables[0];
  const vpcGroups = vpc ? s.groups.filter((g) => g.config.vpcId === vpc.id && isOwn(g)) : [];
  const group = vpcGroups.find(allowsHttp) ?? vpcGroups[0];
  const instance = vpc ? s.instances.find((i) => i.attributes.vpcId === vpc.id) : undefined;
  const instanceSubnet = instance ? s.subnets.find((x) => x.id === instance.config.subnetId) : undefined;
  const liveTable = instanceSubnet ? effectiveRouteTable(s, instanceSubnet) : undefined;

  const ownGroups = vpcGroups;
  const usesGroup = (i: Resource, g?: Resource) => !!g && ((i.config.securityGroupIds as string[]) ?? []).includes(g.id);
  const subnetOf = (i: Resource) => s.subnets.find((x) => x.id === i.config.subnetId);
  const inPublic = (i: Resource) => {
    const sub = subnetOf(i);
    return !!sub && isPublicSubnet(s, sub);
  };
  const vpcInstances = vpc ? s.instances.filter((i) => i.attributes.vpcId === vpc.id) : [];
  const routedPublic = subnets.filter((x) => isPublicSubnet(s, x));
  const pubSub = routedPublic.find((x) => x.config.mapPublicIpOnLaunch) ?? routedPublic[0] ?? publicSubnet;
  const privates = subnets.filter((x) => !isPublicSubnet(s, x) && x.id !== pubSub?.id);
  const privateSubnet = privates.find((x) => routesToNat(s, x)) ?? privates[0];
  const vpcNats = vpc ? s.natGateways.filter((n) => n.attributes.vpcId === vpc.id) : [];
  const nat = vpcNats.find((n) => routedPublic.some((x) => x.id === n.config.subnetId)) ?? vpcNats[0];
  const sshFromRange = (g: Resource) => inboundRules(g).some((r) => !!r.cidr && coversPort(r, 22));
  const bastionGroup = ownGroups.find((g) => g.name === "bastion" && sshFromRange(g)) ?? ownGroups.find(sshFromRange);
  const dbGroup = ownGroups.find((g) => inboundRules(g).some((r) => !!r.sourceGroupId && coversPort(r, 5432)));
  const privateInstances = vpcInstances.filter((i) => !inPublic(i));

  let reach: Promise<ReachabilityResult | null> | null = null;
  const checks = new Map<string, Promise<ReachabilityResult | null>>();
  return {
    pubSub,
    privateSubnet,
    nat,
    spareEip: s.addresses.find((a) => !a.config.instanceId && !a.attributes.natGatewayId),
    keyPair: s.keyPairs[0],
    defaultGroup: vpc ? s.groups.find((g) => g.config.vpcId === vpc.id && systemOf(g).isDefault) : undefined,
    privateInstance: privateInstances.find((i) => !usesGroup(i, dbGroup)) ?? privateInstances[0],
    bastionGroup,
    bastion: vpcInstances.find((i) => inPublic(i) && usesGroup(i, bastionGroup)),
    dbGroup,
    webServer: vpcInstances.find((i) => inPublic(i) && usesGroup(i, group)),
    dbServer: privateInstances.find((i) => usesGroup(i, dbGroup)),
    check(target, input) {
      if (!target) return Promise.resolve(null);
      const key = `${target.id}:${JSON.stringify(input)}`;
      if (!checks.has(key)) checks.set(key, analyzeReachability(engine, accountId, target.id, input).catch(() => null));
      return checks.get(key)!;
    },
    s,
    region,
    vpc,
    subnets,
    publicSubnet,
    gateway,
    table,
    liveTable,
    group,
    instance,
    reach() {
      reach ??= instance ? analyzeReachability(engine, accountId, instance.id, { protocol: "tcp", port: 80 }) : Promise.resolve(null);
      return reach;
    },
  };
}

const failsAt = async (c: Ctx, ...ids: string[]) => {
  const r = await c.reach();
  return !!r && r.steps.some((st) => st.status === "fail" && ids.includes(st.id));
};
const reachable = async (c: Ctx) => (await c.reach())?.reachable === true;

// ---------- shared steps ----------

const createVpcStep: StepDef = {
  id: "vpc",
  title: "Create a VPC",
  why: "A VPC (Virtual Private Cloud) is your own private network in the cloud. Everything else you build lives inside it, so it always comes first.",
  instructions: [
    "Click Take me there. The form is already filled in.",
    "Name: main. CIDR block: 10.0.0.0/16, a range of about 65,000 private addresses.",
    "Click Create VPC and wait a second for it to become 'available'.",
  ],
  link: () => ({ service: "networking", type: "vpc", mode: "create", prefill: { name: "main", cidrBlock: "10.0.0.0/16" } }),
  cli: () => "aws ec2 create-vpc --cidr-block 10.0.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=main}]'",
  check: (c) => c.vpc?.state === "available",
};

function subnetPrefill(c: Ctx, az: string, name: string, isPublic: boolean) {
  return {
    name,
    vpcId: c.vpc?.id,
    cidrBlock: (c.vpc && freeSubnetCidr(c.vpc, c.s.subnets)) ?? "10.0.1.0/24",
    availabilityZone: az,
    mapPublicIpOnLaunch: isPublic,
  };
}

const publicSubnetStep: StepDef = {
    id: "public-subnet",
    title: "Create a public subnet",
    why: "Your server needs a subnet to live in, and that subnet should give it a public IP so the internet can address it.",
    instructions: (c) => [
      "Click Take me there.",
      `Pre-filled: VPC ${c.vpc ? label(c.vpc) : "main"}, a free /24 range, zone ${availabilityZones(c.region)[0]}, Auto-assign public IPv4 ticked.`,
      "Click Create subnet.",
    ],
    link: (c) => ({ service: "networking", type: "subnet", mode: "create", prefill: subnetPrefill(c, availabilityZones(c.region)[0], "public-a", true) }),
    cli: (c) => {
      const p = subnetPrefill(c, availabilityZones(c.region)[0], "public-a", true);
      return c.vpc ? `aws ec2 create-subnet --vpc-id ${c.vpc.id} --cidr-block ${p.cidrBlock} --availability-zone ${p.availabilityZone}` : undefined;
    },
    check: (c) => c.subnets.some((x) => x.config.mapPublicIpOnLaunch === true),
  };

const gatewayStep: StepDef = {
    id: "gateway",
    title: "Create and attach an internet gateway",
    why: "A VPC is sealed off from the internet by default. An internet gateway is the door between your VPC and the internet. Without it, nothing gets in or out.",
    instructions: (c) => {
      const loose = c.s.gateways.find((g) => !g.config.vpcId);
      return loose
        ? [`You already have ${label(loose)}, but it isn't attached.`, `Open it and set Attached VPC to ${c.vpc ? label(c.vpc) : "your VPC"}.`]
        : ["Click Take me there.", `Attached VPC is pre-selected: ${c.vpc ? label(c.vpc) : "your VPC"}.`, "Click Create internet gateway."];
    },
    link: (c) => {
      const loose = c.s.gateways.find((g) => !g.config.vpcId);
      return loose
        ? { service: "networking", type: "internet-gateway", mode: "detail", id: loose.id }
        : { service: "networking", type: "internet-gateway", mode: "create", prefill: { name: "main-igw", vpcId: c.vpc?.id } };
    },
    cli: () => "aws ec2 create-internet-gateway",
    check: (c) => !!c.gateway,
  };

const publicRouteStep: StepDef = {
    id: "route-table",
    title: "Route internet traffic to the gateway",
    why: "Having a door isn't enough: traffic needs a signpost. A route table says where traffic leaving a subnet should go. The route 0.0.0.0/0 → internet gateway means 'anything not inside the VPC goes to the internet'.",
    instructions: (c) => {
      const sub = c.publicSubnet ? label(c.publicSubnet) : "your public subnet";
      if (c.table) {
        return [
          `Open ${label(c.table)}.`,
          `Make sure it has the route 0.0.0.0/0 → ${c.gateway?.id ?? "your gateway"}.`,
          `Make sure ${sub} is ticked under Associated subnets, then save.`,
        ];
      }
      return [
        "Click Take me there.",
        `Pre-filled: the route 0.0.0.0/0 → ${c.gateway?.id ?? "your gateway"} and the association with ${sub}.`,
        "Click Create route table.",
      ];
    },
    link: (c) =>
      c.table
        ? { service: "networking", type: "route-table", mode: "detail", id: c.table.id }
        : {
            service: "networking",
            type: "route-table",
            mode: "create",
            prefill: {
              name: "public-rt",
              vpcId: c.vpc?.id,
              routes: c.gateway ? [{ destination: "0.0.0.0/0", gatewayId: c.gateway.id }] : [],
              subnetIds: c.publicSubnet ? [c.publicSubnet.id] : [],
            },
          },
    cli: (c) => (c.vpc ? `aws ec2 create-route-table --vpc-id ${c.vpc.id}` : undefined),
    check: (c) =>
      !!c.gateway &&
      !!c.publicSubnet &&
      c.s.routeTables.some(
        (t) =>
          subnetIds(t).includes(c.publicSubnet!.id) &&
          routes(t).some((r) => r.destination === "0.0.0.0/0" && r.gatewayId === c.gateway!.id),
      ),
  };

const webGroupStep: StepDef = {
    id: "security-group",
    title: "Create a firewall that allows web traffic",
    why: "A security group is a firewall around your server. Inbound traffic is blocked unless a rule allows it, so you'll allow exactly one thing: HTTP on port 80 from anyone.",
    instructions: [
      "Click Take me there.",
      "Pre-filled: name web, and one inbound rule TCP 80–80 from 0.0.0.0/0.",
      "Click Create security group.",
    ],
    link: (c) => ({
      service: "networking",
      type: "security-group",
      mode: "create",
      prefill: {
        name: c.s.groups.some((g) => g.name === "web" && g.config.vpcId === c.vpc?.id) ? "web-http" : "web",
        description: "Allow HTTP",
        vpcId: c.vpc?.id,
        inboundRules: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0", description: "HTTP from anywhere" }],
      },
    }),
    cli: (c) => (c.vpc ? `aws ec2 create-security-group --group-name web --description "Allow HTTP" --vpc-id ${c.vpc.id}` : undefined),
    check: (c) => !!c.group && allowsHttp(c.group),
  };

// ---------- tutorials ----------

const TUTORIALS: TutorialDef[] = [
  {
    id: "first-network",
    title: "Your first private network",
    level: "beginner",
    summary: "Create a VPC, split it into subnets across two data centres, and learn what makes a subnet public.",
    minutes: 5,
    nextId: "first-web-server",
    steps: [
      createVpcStep,
      {
        id: "subnet-a",
        title: "Add your first subnet",
        why: "A subnet is a slice of your VPC's address range placed in one availability zone (one data centre). Servers are always launched into a subnet, never straight into the VPC.",
        instructions: (c) => {
          const p = subnetPrefill(c, availabilityZones(c.region)[0], "public-a", false);
          return [
            "Click Take me there.",
            `It's pre-filled: VPC ${c.vpc ? label(c.vpc) : "main"}, CIDR ${p.cidrBlock} (256 addresses), zone ${p.availabilityZone}.`,
            "Leave Auto-assign public IPv4 off for now. You'll turn it on in the last step.",
            "Click Create subnet.",
          ];
        },
        link: (c) => ({ service: "networking", type: "subnet", mode: "create", prefill: subnetPrefill(c, availabilityZones(c.region)[0], "public-a", false) }),
        cli: (c) => {
          const p = subnetPrefill(c, availabilityZones(c.region)[0], "public-a", false);
          return c.vpc ? `aws ec2 create-subnet --vpc-id ${c.vpc.id} --cidr-block ${p.cidrBlock} --availability-zone ${p.availabilityZone}` : undefined;
        },
        check: (c) => c.subnets.length >= 1,
      },
      {
        id: "subnet-b",
        title: "Add a second subnet in another zone",
        why: "Availability zones are separate data centres. Spreading subnets across two zones means one data centre failing doesn't take everything down. This is the first habit of reliable systems.",
        instructions: (c) => {
          const az = availabilityZones(c.region)[1];
          const p = subnetPrefill(c, az, "private-b", false);
          return [
            "Click Take me there.",
            `It's pre-filled with zone ${az} and CIDR ${p.cidrBlock}, which doesn't overlap your first subnet.`,
            "Click Create subnet. Try changing the CIDR to your first subnet's range to see the overlap error, if you're curious.",
          ];
        },
        link: (c) => ({ service: "networking", type: "subnet", mode: "create", prefill: subnetPrefill(c, availabilityZones(c.region)[1], "private-b", false) }),
        cli: (c) => {
          const az = availabilityZones(c.region)[1];
          const p = subnetPrefill(c, az, "private-b", false);
          return c.vpc ? `aws ec2 create-subnet --vpc-id ${c.vpc.id} --cidr-block ${p.cidrBlock} --availability-zone ${az}` : undefined;
        },
        check: (c) => new Set(c.subnets.map((x) => x.config.availabilityZone)).size >= 2,
      },
      {
        id: "public-ip",
        title: "Turn on auto-assign public IP for one subnet",
        why: "Servers launched into a subnet with auto-assign public IP get an internet address automatically. That's one ingredient of a 'public' subnet; the other is a route to the internet, which the next tutorial covers.",
        instructions: (c) => [
          `Open ${c.subnets[0] ? label(c.subnets[0]) : "your first subnet"}.`,
          "In Edit settings, tick Auto-assign public IPv4 and click Save changes.",
        ],
        link: (c) => (c.subnets[0] ? { service: "networking", type: "subnet", mode: "detail", id: c.subnets[0].id } : undefined),
        cli: (c) => (c.subnets[0] ? `aws ec2 modify-subnet-attribute --subnet-id ${c.subnets[0].id} --map-public-ip-on-launch` : undefined),
        check: (c) => c.subnets.some((x) => x.config.mapPublicIpOnLaunch === true),
      },
    ],
  },
  {
    id: "first-web-server",
    title: "Launch your first web server",
    level: "beginner",
    summary: "Build everything a public website needs: network, internet gateway, routing, firewall and a server, then prove it's reachable.",
    minutes: 12,
    nextId: "troubleshoot-reachability",
    steps: [
      createVpcStep,
      publicSubnetStep,
      gatewayStep,
      publicRouteStep,
      webGroupStep,
      {
        id: "instance",
        title: "Launch the server",
        why: "Now the server itself. It goes into your public subnet, behind your web firewall, with a public IP. It takes a few seconds to boot: watch it go from pending to running.",
        instructions: (c) => [
          "Click Take me there.",
          `Pre-filled: Ubuntu 24.04, t3.micro, subnet ${c.publicSubnet ? label(c.publicSubnet) : ""}, security group ${c.group ? label(c.group) : ""}, public IP enabled.`,
          "Click Create instance and wait until it shows running.",
        ],
        link: (c) => ({
          service: "compute",
          type: "instance",
          mode: "create",
          prefill: {
            name: "web-1",
            imageId: "ami-0ubuntu24040lts01",
            instanceType: "t3.micro",
            subnetId: c.publicSubnet?.id,
            securityGroupIds: c.group ? [c.group.id] : [],
            associatePublicIp: "enable",
          },
        }),
        cli: (c) =>
          c.publicSubnet && c.group
            ? `aws ec2 run-instances --image-id ami-0ubuntu24040lts01 --instance-type t3.micro --subnet-id ${c.publicSubnet.id} --security-group-ids ${c.group.id} --associate-public-ip-address`
            : undefined,
        check: (c) => c.instance?.state === "running" && !!c.instance.attributes.publicIp,
      },
      {
        id: "reachable",
        title: "Prove it's reachable from the internet",
        why: "The reachability check follows a request from the internet to your server through every piece you built. If all links pass, a real visitor's browser would get through.",
        instructions: (c) => [
          `Open ${c.instance ? label(c.instance) : "your instance"}.`,
          "In Reachability check, click HTTP. Every link should be green.",
          "If something fails, the check tells you exactly what and how to fix it.",
        ],
        link: (c) => (c.instance ? { service: "compute", type: "instance", mode: "detail", id: c.instance.id } : undefined),
        check: reachable,
      },
    ],
  },
  {
    id: "troubleshoot-reachability",
    title: "Why can't I reach my server?",
    level: "beginner",
    summary: "Break a working web server on purpose, twice, and learn to find and fix the problem like an engineer on call.",
    minutes: 8,
    nextId: "private-network",
    steps: [
      {
        id: "working",
        title: "Start with a working web server",
        why: "To learn troubleshooting, you need something that works first. You'll break it on purpose and watch exactly how it fails.",
        instructions: [
          "You need a server that passes the HTTP reachability check.",
          "If you don't have one, do 'Launch your first web server' first, then come back.",
        ],
        link: (c) => (c.instance ? { service: "compute", type: "instance", mode: "detail", id: c.instance.id } : undefined),
        check: reachable,
      },
      {
        id: "break-route",
        title: "Break it: remove the internet route",
        why: "One of the most common real outages: someone edits a route table and traffic can no longer find its way back to the internet.",
        instructions: (c) => [
          `Open ${c.liveTable ? label(c.liveTable) : "your route table"}.`,
          "In Edit settings, delete the 0.0.0.0/0 route (the bin icon) and click Save changes.",
          `Then open ${c.instance ? label(c.instance) : "your instance"} and run the HTTP reachability check: see which link turns red.`,
        ],
        link: (c) => (c.liveTable ? { service: "networking", type: "route-table", mode: "detail", id: c.liveTable.id } : undefined),
        cli: (c) => (c.liveTable ? `aws ec2 delete-route --route-table-id ${c.liveTable.id} --destination-cidr-block 0.0.0.0/0` : undefined),
        check: (c) => failsAt(c, "route", "route-table", "gateway"),
      },
      {
        id: "fix-route",
        title: "Fix it: put the route back",
        why: "The reachability check said 'no route back to the source'. The fix is to restore the route to the internet gateway.",
        instructions: (c) => [
          `Open ${c.liveTable ? label(c.liveTable) : "your route table"}.`,
          `Add the route 0.0.0.0/0 → ${c.gateway?.id ?? "your internet gateway"} and save.`,
          "Run the reachability check again: it should be green.",
        ],
        link: (c) => (c.liveTable ? { service: "networking", type: "route-table", mode: "detail", id: c.liveTable.id } : undefined),
        cli: (c) =>
          c.liveTable && c.gateway
            ? `aws ec2 create-route --route-table-id ${c.liveTable.id} --destination-cidr-block 0.0.0.0/0 --gateway-id ${c.gateway.id}`
            : undefined,
        check: reachable,
      },
      {
        id: "break-firewall",
        title: "Break it again: close the firewall",
        why: "The other classic: the network is fine, but the firewall blocks the port. The symptoms look the same from outside, so you need the check to tell them apart.",
        instructions: (c) => [
          `Open ${c.group ? label(c.group) : "your security group"}.`,
          "Delete the inbound HTTP (port 80) rule and save.",
          "Run the reachability check: this time a different link fails.",
        ],
        link: (c) => (c.group ? { service: "networking", type: "security-group", mode: "detail", id: c.group.id } : undefined),
        cli: (c) =>
          c.group ? `aws ec2 revoke-security-group-ingress --group-id ${c.group.id} --protocol tcp --port 80 --cidr 0.0.0.0/0` : undefined,
        check: (c) => failsAt(c, "security-group"),
      },
      {
        id: "fix-firewall",
        title: "Fix it: allow HTTP again",
        why: "Add back exactly the rule you need, no more. Opening everything ('all traffic') would also work, but it's how real systems get hacked.",
        instructions: (c) => [
          `Open the security group of ${c.instance ? label(c.instance) : "your instance"}.`,
          "Add an inbound rule: TCP 80–80 from 0.0.0.0/0, and save.",
          "Run the reachability check: all green. You've just debugged two real outages.",
        ],
        link: (c) => {
          const id = (c.instance?.config.securityGroupIds as string[] | undefined)?.[0];
          return id ? { service: "networking", type: "security-group", mode: "detail", id } : undefined;
        },
        cli: (c) => {
          const id = (c.instance?.config.securityGroupIds as string[] | undefined)?.[0];
          return id ? `aws ec2 authorize-security-group-ingress --group-id ${id} --protocol tcp --port 80 --cidr 0.0.0.0/0` : undefined;
        },
        check: reachable,
      },
    ],
  },
];

// ---------- intermediate tutorials ----------

const LINUX = "ami-0lab2023linux0001";
const ok = async (p: Promise<ReachabilityResult | null>) => (await p)?.reachable === true;
const blocked = async (p: Promise<ReachabilityResult | null>) => (await p)?.reachable === false;
const firstGroup = (i?: Resource) => (i?.config.securityGroupIds as string[] | undefined)?.[0];

const privateSubnetStep: StepDef = {
  id: "private-subnet",
  title: "Create a private subnet",
  why: "Databases and internal services shouldn't be reachable from the internet. A private subnet is simply one whose route table has no route to the internet gateway. Nothing outside can get in.",
  instructions: (c) => [
    "Click Take me there.",
    `Pre-filled: VPC ${c.vpc ? label(c.vpc) : "main"}, a free range in ${availabilityZones(c.region)[0]}, Auto-assign public IPv4 off.`,
    "Click Create subnet. Don't associate it with your public route table.",
  ],
  link: (c) => ({ service: "networking", type: "subnet", mode: "create", prefill: subnetPrefill(c, availabilityZones(c.region)[0], "private-a", false) }),
  cli: (c) => {
    const p = subnetPrefill(c, availabilityZones(c.region)[0], "private-a", false);
    return c.vpc ? `aws ec2 create-subnet --vpc-id ${c.vpc.id} --cidr-block ${p.cidrBlock} --availability-zone ${p.availabilityZone}` : undefined;
  },
  check: (c) => !!c.privateSubnet && c.privateSubnet.config.mapPublicIpOnLaunch !== true,
};

const INTERMEDIATE: TutorialDef[] = [
  {
    id: "private-network",
    title: "Public and private subnets with a NAT gateway",
    level: "intermediate",
    summary:
      "The layout most companies use: web servers in a public subnet, everything else in a private one that can reach the internet for updates but can't be reached from it.",
    minutes: 15,
    nextId: "bastion-host",
    steps: [
      createVpcStep,
      publicSubnetStep,
      gatewayStep,
      publicRouteStep,
      privateSubnetStep,
      {
        id: "nat-eip",
        title: "Allocate an Elastic IP for the NAT gateway",
        why: "A NAT gateway sends your private servers' traffic out from one fixed public address. That address is an Elastic IP.",
        instructions: ["Click Take me there.", "Leave Associated instance as None: the NAT gateway will use it.", "Click Create Elastic IP."],
        link: (c) => (c.spareEip ? { service: "compute", type: "elastic-ip", mode: "detail", id: c.spareEip.id } : { service: "compute", type: "elastic-ip", mode: "create", prefill: { name: "nat-ip" } }),
        cli: () => "aws ec2 allocate-address",
        check: (c) => !!c.spareEip || !!c.nat,
      },
      {
        id: "nat",
        title: "Create a NAT gateway in the public subnet",
        why: "The NAT gateway is the private subnet's way out. It must live in the public subnet, because it forwards traffic to the internet gateway itself. It takes a few seconds to become available.",
        instructions: (c) => [
          "Click Take me there.",
          `Pre-filled: subnet ${c.pubSub ? label(c.pubSub) : "your public subnet"}, Elastic IP ${c.spareEip?.attributes.publicIp ?? "the one you just allocated"}.`,
          "Click Create NAT gateway and wait for it to become available.",
        ],
        link: (c) =>
          c.nat
            ? { service: "networking", type: "nat-gateway", mode: "detail", id: c.nat.id }
            : { service: "networking", type: "nat-gateway", mode: "create", prefill: { name: "main-nat", subnetId: c.pubSub?.id, allocationId: c.spareEip?.id } },
        cli: (c) =>
          c.pubSub ? `aws ec2 create-nat-gateway --subnet-id ${c.pubSub.id} --allocation-id ${c.spareEip?.id ?? "<eipalloc-id>"}` : undefined,
        check: (c) => !!c.nat && c.nat.state === "available" && !!c.pubSub && c.nat.config.subnetId === c.pubSub.id,
      },
      {
        id: "private-route",
        title: "Route the private subnet through the NAT gateway",
        why: "The private subnet needs its own route table: 0.0.0.0/0 → NAT gateway. Servers there can now start connections out, but there's still no way in.",
        instructions: (c) => [
          "Click Take me there.",
          `Pre-filled: the route 0.0.0.0/0 → ${c.nat?.id ?? "your NAT gateway"} and the association with ${c.privateSubnet ? label(c.privateSubnet) : "your private subnet"}.`,
          "Click Create route table.",
        ],
        link: (c) => ({
          service: "networking",
          type: "route-table",
          mode: "create",
          prefill: {
            name: "private-rt",
            vpcId: c.vpc?.id,
            routes: c.nat ? [{ destination: "0.0.0.0/0", natGatewayId: c.nat.id }] : [],
            subnetIds: c.privateSubnet ? [c.privateSubnet.id] : [],
          },
        }),
        cli: (c) => (c.vpc ? `aws ec2 create-route-table --vpc-id ${c.vpc.id}` : undefined),
        check: (c) => !!c.privateSubnet && !!routesToNat(c.s, c.privateSubnet),
      },
      {
        id: "private-server",
        title: "Launch a server in the private subnet",
        why: "This stands in for an internal service or database. It gets a private address only: no public IP, no way in from the internet.",
        instructions: (c) => [
          "Click Take me there.",
          `Pre-filled: subnet ${c.privateSubnet ? label(c.privateSubnet) : "private-a"}, the VPC's default security group, public IP disabled.`,
          "Click Create instance and wait until it's running.",
        ],
        link: (c) => ({
          service: "compute",
          type: "instance",
          mode: "create",
          prefill: {
            name: "app-1",
            imageId: LINUX,
            instanceType: "t3.micro",
            subnetId: c.privateSubnet?.id,
            securityGroupIds: c.defaultGroup ? [c.defaultGroup.id] : [],
            associatePublicIp: "disable",
          },
        }),
        cli: (c) =>
          c.privateSubnet ? `aws ec2 run-instances --image-id ${LINUX} --subnet-id ${c.privateSubnet.id} --no-associate-public-ip-address` : undefined,
        check: (c) => c.privateInstance?.state === "running" && !c.privateInstance.attributes.publicIp,
      },
      {
        id: "prove",
        title: "Prove it: out yes, in no",
        why: "This is the whole point of the design. The private server can download updates through the NAT gateway, and nobody on the internet can connect to it.",
        instructions: (c) => [
          `Open ${c.privateInstance ? label(c.privateInstance) : "the private server"}.`,
          "In Reachability check, choose Out to the internet and click HTTPS: all green, through the NAT gateway.",
          "Then choose From the internet and click HTTPS: it fails, and the check explains why.",
        ],
        link: (c) => (c.privateInstance ? { service: "compute", type: "instance", mode: "detail", id: c.privateInstance.id } : undefined),
        check: async (c) =>
          (await ok(c.check(c.privateInstance, { direction: "outbound", protocol: "tcp", port: 443 }))) &&
          (await blocked(c.check(c.privateInstance, { protocol: "tcp", port: 443 }))),
      },
    ],
  },
  {
    id: "bastion-host",
    title: "Reach a private server through a bastion host",
    level: "intermediate",
    summary: "SSH into one hardened public server, and from there into private ones, using a key pair and security group chaining.",
    minutes: 10,
    nextId: "web-and-database",
    steps: [
      {
        id: "private-ready",
        title: "Start with a private server",
        why: "You need a server in a private subnet to reach. The previous tutorial builds one.",
        instructions: ["You need a running server in a private subnet.", "If you don't have one, do 'Public and private subnets with a NAT gateway' first."],
        link: (c) => (c.privateInstance ? { service: "compute", type: "instance", mode: "detail", id: c.privateInstance.id } : undefined),
        check: (c) => c.privateInstance?.state === "running" && !!c.pubSub && isPublicSubnet(c.s, c.pubSub),
      },
      {
        id: "key-pair",
        title: "Create a key pair",
        why: "SSH logins use a key pair instead of a password. The platform keeps the public half; you download the private half once and keep it safe.",
        instructions: ["Click Take me there.", "Name it lab-key and click Create key pair.", "Your browser downloads lab-key.pem. In real life, run chmod 400 lab-key.pem before using it."],
        link: (c) => (c.keyPair ? { service: "compute", type: "key-pair", mode: "detail", id: c.keyPair.id } : { service: "compute", type: "key-pair", mode: "create", prefill: { name: "lab-key", keyType: "ed25519" } }),
        cli: () => "aws ec2 create-key-pair --key-name lab-key --key-type ed25519 --query KeyMaterial --output text > lab-key.pem",
        check: (c) => !!c.keyPair,
      },
      {
        id: "bastion-sg",
        title: "Create the bastion's security group",
        why: "The bastion is the only server that accepts SSH from outside. Its group allows port 22 and nothing else.",
        instructions: [
          "Click Take me there.",
          "Pre-filled: name bastion, one inbound rule TCP 22 from 0.0.0.0/0.",
          "In real life, replace 0.0.0.0/0 with your own IP, e.g. 198.51.100.7/32. Then click Create security group.",
        ],
        link: (c) =>
          c.bastionGroup
            ? { service: "networking", type: "security-group", mode: "detail", id: c.bastionGroup.id }
            : {
                service: "networking",
                type: "security-group",
                mode: "create",
                prefill: {
                  name: "bastion",
                  description: "SSH from admins",
                  vpcId: c.vpc?.id,
                  inboundRules: [{ protocol: "tcp", fromPort: 22, toPort: 22, cidr: "0.0.0.0/0", description: "SSH (use your IP/32 in real life)" }],
                },
              },
        cli: (c) => (c.vpc ? `aws ec2 create-security-group --group-name bastion --description "SSH from admins" --vpc-id ${c.vpc.id}` : undefined),
        check: (c) => !!c.bastionGroup,
      },
      {
        id: "bastion",
        title: "Launch the bastion host",
        why: "A small server in the public subnet, with a public IP, your key pair and the bastion group. It's the single front door for admins.",
        instructions: (c) => [
          "Click Take me there.",
          `Pre-filled: subnet ${c.pubSub ? label(c.pubSub) : "public"}, group ${c.bastionGroup ? label(c.bastionGroup) : "bastion"}, key pair ${c.keyPair?.name ?? "lab-key"}, public IP enabled.`,
          "Click Create instance and wait until it's running.",
        ],
        link: (c) => ({
          service: "compute",
          type: "instance",
          mode: "create",
          prefill: {
            name: "bastion",
            imageId: LINUX,
            instanceType: "t3.micro",
            subnetId: c.pubSub?.id,
            securityGroupIds: c.bastionGroup ? [c.bastionGroup.id] : [],
            associatePublicIp: "enable",
            keyName: c.keyPair?.name,
          },
        }),
        cli: (c) =>
          c.pubSub && c.bastionGroup
            ? `aws ec2 run-instances --image-id ${LINUX} --subnet-id ${c.pubSub.id} --security-group-ids ${c.bastionGroup.id} --key-name ${c.keyPair?.name ?? "lab-key"} --associate-public-ip-address`
            : undefined,
        check: (c) => c.bastion?.state === "running" && !!c.bastion.attributes.publicIp && !!c.bastion.config.keyName,
      },
      {
        id: "allow-from-bastion",
        title: "Let the bastion into the private server",
        why: "Instead of allowing an IP address, allow the bastion's security group. Any server in that group can connect, and it keeps working when IPs change. This is called security group chaining.",
        instructions: (c) => {
          const g = firstGroup(c.privateInstance);
          return [
            `Open the private server's security group${g ? ` ${g}` : ""}.`,
            `Add an inbound rule: TCP 22, and under …or security group choose ${c.bastionGroup ? label(c.bastionGroup) : "bastion"}. Leave the CIDR empty.`,
            "Save changes.",
          ];
        },
        link: (c) => {
          const g = firstGroup(c.privateInstance);
          return g ? { service: "networking", type: "security-group", mode: "detail", id: g } : undefined;
        },
        cli: (c) => {
          const g = firstGroup(c.privateInstance);
          return g && c.bastionGroup
            ? `aws ec2 authorize-security-group-ingress --group-id ${g} --protocol tcp --port 22 --source-group ${c.bastionGroup.id}`
            : undefined;
        },
        check: (c) => ok(c.check(c.privateInstance, { from: c.bastion?.id ?? "none", protocol: "tcp", port: 22 })),
      },
      {
        id: "prove",
        title: "Prove both hops, and that the back door is shut",
        why: "SSH reaches the bastion from the internet, and the private server from the bastion, but never the private server straight from the internet.",
        instructions: (c) => [
          `Open ${c.privateInstance ? label(c.privateInstance) : "the private server"}. In Reachability check, choose From another instance, pick the bastion and click SSH: green.`,
          "Choose From the internet and click SSH: red.",
          `On a real machine you'd now run: ssh -i lab-key.pem -J ec2-user@${c.bastion?.attributes.publicIp ?? "<bastion-ip>"} ec2-user@${c.privateInstance?.attributes.privateIp ?? "<private-ip>"}`,
        ],
        link: (c) => (c.privateInstance ? { service: "compute", type: "instance", mode: "detail", id: c.privateInstance.id } : undefined),
        check: async (c) =>
          (await ok(c.check(c.bastion, { protocol: "tcp", port: 22 }))) &&
          (await ok(c.check(c.privateInstance, { from: c.bastion?.id ?? "none", protocol: "tcp", port: 22 }))) &&
          (await blocked(c.check(c.privateInstance, { protocol: "tcp", port: 22 }))),
      },
    ],
  },
  {
    id: "web-and-database",
    title: "Web and database tiers",
    level: "intermediate",
    summary: "A public web server talks to a private database, and only the web server may: a two-tier app secured with chained security groups.",
    minutes: 12,
    steps: [
      {
        id: "network-ready",
        title: "Start with public and private subnets",
        why: "The web tier goes in the public subnet and the database in the private one. 'Public and private subnets with a NAT gateway' builds both.",
        instructions: ["You need a public subnet (route to an internet gateway) and a private subnet in the same VPC.", "If you don't have them, do 'Public and private subnets with a NAT gateway' first."],
        check: (c) => !!c.pubSub && isPublicSubnet(c.s, c.pubSub) && !!c.privateSubnet,
      },
      webGroupStep,
      {
        id: "db-sg",
        title: "Create a database group that only trusts the web tier",
        why: "The database accepts PostgreSQL (port 5432) from members of the web group, and from nothing else. No IP ranges to keep up to date.",
        instructions: (c) => [
          "Click Take me there.",
          `Pre-filled: name database, one inbound rule TCP 5432 from security group ${c.group ? label(c.group) : "web"}.`,
          "Click Create security group.",
        ],
        link: (c) =>
          c.dbGroup
            ? { service: "networking", type: "security-group", mode: "detail", id: c.dbGroup.id }
            : {
                service: "networking",
                type: "security-group",
                mode: "create",
                prefill: {
                  name: "database",
                  description: "PostgreSQL from the web tier",
                  vpcId: c.vpc?.id,
                  inboundRules: c.group ? [{ protocol: "tcp", fromPort: 5432, toPort: 5432, sourceGroupId: c.group.id, description: "From web tier" }] : [],
                },
              },
        cli: (c) =>
          c.vpc ? `aws ec2 create-security-group --group-name database --description "PostgreSQL from the web tier" --vpc-id ${c.vpc.id}` : undefined,
        check: (c) =>
          !!c.dbGroup && !!c.group && inboundRules(c.dbGroup).some((r) => r.sourceGroupId === c.group!.id && coversPort(r, 5432)),
      },
      {
        id: "web-server",
        title: "Launch the web server",
        why: "The web tier: public subnet, web group, public IP. Visitors reach it over HTTP.",
        instructions: (c) => [
          "Click Take me there.",
          `Pre-filled: subnet ${c.pubSub ? label(c.pubSub) : "public"}, group ${c.group ? label(c.group) : "web"}, public IP enabled.`,
          "Click Create instance.",
        ],
        link: (c) => ({
          service: "compute",
          type: "instance",
          mode: "create",
          prefill: {
            name: "web-1",
            imageId: "ami-0ubuntu24040lts01",
            instanceType: "t3.micro",
            subnetId: c.pubSub?.id,
            securityGroupIds: c.group ? [c.group.id] : [],
            associatePublicIp: "enable",
          },
        }),
        cli: (c) =>
          c.pubSub && c.group
            ? `aws ec2 run-instances --image-id ami-0ubuntu24040lts01 --subnet-id ${c.pubSub.id} --security-group-ids ${c.group.id} --associate-public-ip-address`
            : undefined,
        check: (c) => c.webServer?.state === "running" && !!c.webServer.attributes.publicIp,
      },
      {
        id: "db-server",
        title: "Launch the database server",
        why: "The data tier: private subnet, database group, no public IP. It can still fetch updates through the NAT gateway.",
        instructions: (c) => [
          "Click Take me there.",
          `Pre-filled: subnet ${c.privateSubnet ? label(c.privateSubnet) : "private"}, group ${c.dbGroup ? label(c.dbGroup) : "database"}, public IP disabled.`,
          "Click Create instance.",
        ],
        link: (c) => ({
          service: "compute",
          type: "instance",
          mode: "create",
          prefill: {
            name: "db-1",
            imageId: LINUX,
            instanceType: "t3.small",
            subnetId: c.privateSubnet?.id,
            securityGroupIds: c.dbGroup ? [c.dbGroup.id] : [],
            associatePublicIp: "disable",
          },
        }),
        cli: (c) =>
          c.privateSubnet && c.dbGroup
            ? `aws ec2 run-instances --image-id ${LINUX} --instance-type t3.small --subnet-id ${c.privateSubnet.id} --security-group-ids ${c.dbGroup.id} --no-associate-public-ip-address`
            : undefined,
        check: (c) => c.dbServer?.state === "running" && !c.dbServer.attributes.publicIp,
      },
      {
        id: "prove",
        title: "Prove only the web tier reaches the database",
        why: "Three checks tell the whole story: visitors reach the web server, the web server reaches the database, and nobody else does.",
        instructions: (c) => [
          `Open ${c.dbServer ? label(c.dbServer) : "the database server"}. In Reachability check, choose From another instance, pick ${c.webServer ? label(c.webServer) : "the web server"} and click PostgreSQL: green.`,
          "Choose From the internet, set port 5432 and click Check: red, twice over (no public IP, and the group doesn't allow it).",
          "Bonus: launch a server in the private subnet without the web group and check PostgreSQL from it. It's blocked too.",
        ],
        link: (c) => (c.dbServer ? { service: "compute", type: "instance", mode: "detail", id: c.dbServer.id } : undefined),
        check: async (c) =>
          (await ok(c.check(c.webServer, { protocol: "tcp", port: 80 }))) &&
          (await ok(c.check(c.dbServer, { from: c.webServer?.id ?? "none", protocol: "tcp", port: 5432 }))) &&
          (await blocked(c.check(c.dbServer, { protocol: "tcp", port: 5432 }))),
      },
    ],
  },
];

TUTORIALS.push(...INTERMEDIATE);

const info = (t: TutorialDef): TutorialInfo => ({
  id: t.id,
  title: t.title,
  level: t.level,
  summary: t.summary,
  minutes: t.minutes,
  stepCount: t.steps.length,
  nextId: t.nextId,
});

export function listTutorials(): TutorialInfo[] {
  return TUTORIALS.map(info);
}

/** A tutorial with every step's text resolved for the learner's resources and its check evaluated. */
export async function viewTutorial(engine: Engine, accountId: string, region: string, id: string): Promise<TutorialView | null> {
  const t = TUTORIALS.find((x) => x.id === id);
  if (!t) return null;
  const c = await buildCtx(engine, accountId, region);
  const steps = await Promise.all(
    t.steps.map(async (st) => ({
      id: st.id,
      title: resolve(st.title, c),
      why: st.why,
      instructions: resolve(st.instructions, c),
      link: st.link?.(c),
      cli: st.cli?.(c),
      passes: await st.check(c),
    })),
  );
  return { ...info(t), region, steps };
}
