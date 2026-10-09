import { analyzeReachability, reachabilityInput, type ReachabilityResult } from "@/engine/analysis/reachability";
import { availabilityZones } from "@/engine/catalog";
import type { Engine } from "@/engine/engine";
import type { Resource } from "@/engine/types";
import { focusVpc, freeSubnetCidr, label, takeSnapshot, type SgRule, type Snapshot } from "./snapshot";
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
  /** A route table in the focus VPC, preferring the one the public subnet uses. */
  table?: Resource;
  /** A security group in the focus VPC, preferring one that allows HTTP. */
  group?: Resource;
  /** Newest instance in the focus VPC. */
  instance?: Resource;
  /** HTTP reachability of `instance` from the internet (computed once, on demand). */
  reach(): Promise<ReachabilityResult | null>;
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
  const vpc = focusVpc(s);
  const subnets = vpc ? s.subnets.filter((x) => x.config.vpcId === vpc.id) : [];
  const publicSubnet = subnets.find((x) => x.config.mapPublicIpOnLaunch) ?? subnets[0];
  const gateway = vpc ? s.gateways.find((g) => g.config.vpcId === vpc.id) : undefined;
  const vpcTables = vpc ? s.routeTables.filter((t) => t.config.vpcId === vpc.id) : [];
  const table = vpcTables.find((t) => publicSubnet && subnetIds(t).includes(publicSubnet.id)) ?? vpcTables[0];
  const vpcGroups = vpc ? s.groups.filter((g) => g.config.vpcId === vpc.id) : [];
  const group = vpcGroups.find(allowsHttp) ?? vpcGroups[0];
  const instance = vpc ? s.instances.find((i) => i.attributes.vpcId === vpc.id) : undefined;

  let reach: Promise<ReachabilityResult | null> | null = null;
  return {
    s,
    region,
    vpc,
    subnets,
    publicSubnet,
    gateway,
    table,
    group,
    instance,
    reach() {
      reach ??= instance
        ? analyzeReachability(engine, accountId, instance.id, reachabilityInput.parse({ protocol: "tcp", port: 80 }))
        : Promise.resolve(null);
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
      {
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
      },
      {
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
      },
      {
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
      },
      {
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
      },
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
          `Open ${c.table ? label(c.table) : "your route table"}.`,
          "In Edit settings, delete the 0.0.0.0/0 route (the bin icon) and click Save changes.",
          `Then open ${c.instance ? label(c.instance) : "your instance"} and run the HTTP reachability check: see which link turns red.`,
        ],
        link: (c) => (c.table ? { service: "networking", type: "route-table", mode: "detail", id: c.table.id } : undefined),
        cli: (c) => (c.table ? `aws ec2 delete-route --route-table-id ${c.table.id} --destination-cidr-block 0.0.0.0/0` : undefined),
        check: (c) => failsAt(c, "route", "route-table", "gateway"),
      },
      {
        id: "fix-route",
        title: "Fix it: put the route back",
        why: "The reachability check said 'no route back to the source'. The fix is to restore the route to the internet gateway.",
        instructions: (c) => [
          `Open ${c.table ? label(c.table) : "your route table"}.`,
          `Add the route 0.0.0.0/0 → ${c.gateway?.id ?? "your internet gateway"} and save.`,
          "Run the reachability check again: it should be green.",
        ],
        link: (c) => (c.table ? { service: "networking", type: "route-table", mode: "detail", id: c.table.id } : undefined),
        cli: (c) =>
          c.table && c.gateway
            ? `aws ec2 create-route --route-table-id ${c.table.id} --destination-cidr-block 0.0.0.0/0 --gateway-id ${c.gateway.id}`
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
