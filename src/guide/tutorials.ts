import { analyzeReachability, type ReachabilityInput, type ReachabilityResult } from "@/engine/analysis/reachability";
import { availabilityZones } from "@/engine/catalog";
import type { Engine } from "@/engine/engine";
import { check, resolvePrincipal } from "@/engine/iam/authorize";
import { systemOf, type Resource } from "@/engine/types";
import {
  bucketName,
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
import { activityCauses, healthySpread, loadHa, type HaState } from "./ha";
import { loadDb, type DbState } from "./db";
import { loadServerless, type ServerlessState } from "./serverless";
import { loadWatch, WATCHED_FUNCTION, type WatchState } from "./watch";
import { loadDns, TUTORIAL_DOMAIN, type DnsState } from "./dns";
import { listenersOf } from "@/engine/services/loadbalancing";

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
  /** The bucket for the website tutorial: one with website hosting on, else the newest. */
  siteBucket?: Resource;
  /** Keys at the top of `siteBucket`. */
  siteKeys(): Promise<string[]>;
  /** HTTP status the site's home page returns. */
  siteStatus(): Promise<number | null>;
  /** The IAM identity the console is acting as: "root", "user/dev"… */
  identity: string;
  /** The account's IAM users, groups and customer policies (loaded once, on demand). */
  iam(): Promise<{ users: Resource[]; groups: Resource[]; policies: Resource[] }>;
  /** Would this IAM user be allowed to do this? */
  can(user: string, action: string, resource: string): Promise<boolean>;
  /** Load balancing and Auto Scaling in the focus VPC (loaded once, on demand). */
  ha(): Promise<HaState>;
  /** The same, preloaded for tutorials that declare `needsHa`, so links and text can use it. */
  haState?: HaState;
  /** RDS in the focus VPC (loaded once, on demand). */
  db(): Promise<DbState>;
  /** The same, preloaded for tutorials that declare `needsDb`. */
  dbState?: DbState;
  /** Lambda and API Gateway (loaded once, on demand). */
  sls(): Promise<ServerlessState>;
  /** The same, preloaded for tutorials that declare `needsServerless`. */
  slsState?: ServerlessState;
  /** The function, logs, alarm and dashboard of the monitoring tutorial (loaded once, on demand). */
  watch(): Promise<WatchState>;
  /** The same, preloaded for tutorials that declare `needsWatch`. */
  watchState?: WatchState;
  /** The Route 53 tutorial's zone, records and health check (loaded once, on demand). */
  dns(): Promise<DnsState>;
  /** The same, preloaded for tutorials that declare `needsDns`. */
  dnsState?: DnsState;
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
  /** Load the load balancing and Auto Scaling state before resolving links and text. */
  needsHa?: boolean;
  /** Load the RDS state before resolving links and text. */
  needsDb?: boolean;
  /** Load the Lambda and API Gateway state before resolving links and text. */
  needsServerless?: boolean;
  /** Load the monitoring state before resolving links and text. */
  needsWatch?: boolean;
  /** Load the Route 53 state before resolving links and text. */
  needsDns?: boolean;
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

async function buildCtx(engine: Engine, accountId: string, region: string, identity = "root"): Promise<Ctx> {
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
  const siteBucket = s.buckets.find((b) => b.config.websiteEnabled) ?? s.buckets[0];
  let keys: Promise<string[]> | null = null;
  let iamData: ReturnType<Ctx["iam"]> | null = null;
  let haData: Promise<HaState> | null = null;
  let dbData: Promise<DbState> | null = null;
  let slsData: Promise<ServerlessState> | null = null;
  let watchData: Promise<WatchState> | null = null;
  let dnsData: Promise<DnsState> | null = null;
  const iamList = (type: string) => engine.list(accountId, { service: "iam", type, region: "global" });
  return {
    identity,
    ha() {
      haData ??= loadHa(engine, accountId, region, s, vpc);
      return haData;
    },
    db() {
      dbData ??= loadDb(engine, accountId, region, s, vpc, group);
      return dbData;
    },
    sls() {
      slsData ??= loadServerless(engine, accountId, region);
      return slsData;
    },
    watch() {
      watchData ??= loadWatch(engine, accountId, region);
      return watchData;
    },
    dns() {
      dnsData ??= loadDns(engine, accountId, instance?.attributes.publicIp as string | undefined);
      return dnsData;
    },
    iam() {
      iamData ??= Promise.all([iamList("user"), iamList("group"), iamList("policy")]).then(([users, groups, policies]) => ({ users, groups, policies }));
      return iamData;
    },
    async can(user, action, resource) {
      try {
        const p = await resolvePrincipal(engine, accountId, { kind: "user", name: user });
        return check(p, action, resource).decision === "allowed";
      } catch {
        return false;
      }
    },
    siteBucket,
    siteKeys() {
      keys ??= siteBucket
        ? engine.objects.list(accountId, siteBucket.id, { delimiter: "/" }).then((r) => r.objects.map((o) => o.key))
        : Promise.resolve([]);
      return keys;
    },
    async siteStatus() {
      return siteBucket ? (await engine.objects.website(siteBucket.id, "")).status : null;
    },
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
    nextId: "static-website",
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

// ---------- static website ----------

const SAMPLES = "/samples/website";
const siteName = (c: Ctx) => `${bucketName(c.s.accountId)}-site`;
const siteLink = (c: Ctx): GuideLink | undefined =>
  c.siteBucket ? { service: "storage", type: "bucket", mode: "detail", id: c.siteBucket.id } : undefined;

const STATIC_WEBSITE: TutorialDef = {
  id: "static-website",
  title: "Host a static website",
  level: "beginner",
  summary: "Put a web page in a storage bucket and publish it to the world: no servers, no networks, just files.",
  minutes: 8,
  nextId: "private-network",
  steps: [
    {
      id: "bucket",
      title: "Create a bucket for the site",
      why: "A bucket holds files (objects). Static website hosting serves those files straight to browsers, so there's no server to run or patch.",
      instructions: (c) => ["Click Take me there.", `The name is pre-filled (${siteName(c)}). Bucket names are shared by everyone, so it has to be unique.`, "Click Create bucket."],
      link: (c) => ({ service: "storage", type: "bucket", mode: "create", prefill: { name: siteName(c), versioning: "Disabled", blockPublicAccess: true } }),
      cli: (c) => `aws s3 mb s3://${siteName(c)}`,
      check: (c) => !!c.siteBucket,
    },
    {
      id: "upload",
      title: "Upload the pages",
      why: "Each file you upload becomes an object, named by its key: index.html, error.html, images/logo.png and so on.",
      instructions: (c) => [
        `Download the two sample pages: ${SAMPLES}/index.html and ${SAMPLES}/error.html (or use your own).`,
        `Open ${c.siteBucket ? c.siteBucket.id : "your bucket"} and, under Objects, click Upload and pick both files. You can also drag them onto the list.`,
      ],
      link: siteLink,
      cli: (c) => (c.siteBucket ? `aws s3 cp index.html s3://${c.siteBucket.id}/` : undefined),
      check: async (c) => {
        const keys = await c.siteKeys();
        return keys.includes(String(c.siteBucket?.config.indexDocument || "index.html")) || keys.includes("index.html");
      },
    },
    {
      id: "hosting",
      title: "Turn on static website hosting",
      why: "Hosting tells the bucket to answer web requests: the index document is served for the home page, and the error document for pages that don't exist.",
      instructions: [
        "On the bucket page, scroll to Edit settings.",
        "Tick Static website hosting. Index document: index.html. Error document: error.html.",
        "Click Save changes.",
      ],
      link: siteLink,
      cli: (c) => (c.siteBucket ? `aws s3 website s3://${c.siteBucket.id}/ --index-document index.html --error-document error.html` : undefined),
      check: (c) => c.siteBucket?.config.websiteEnabled === true,
    },
    {
      id: "public",
      title: "Let visitors read the files",
      why: "Buckets are private by default, and the website returns 403 Access Denied until you allow public reads. That takes two switches: turn off Block all public access, then add a public-read bucket policy.",
      instructions: [
        "Try Open website first: you'll see the 403 that real S3 shows.",
        "In Edit settings, untick Block all public access and tick Bucket policy: public read. Save.",
        "Only do this for buckets meant to be public, like a website. Leaking a private bucket is the most common cloud data breach.",
      ],
      link: siteLink,
      cli: (c) => (c.siteBucket ? `aws s3api delete-public-access-block --bucket ${c.siteBucket.id}` : undefined),
      check: (c) => !!c.siteBucket && !c.siteBucket.config.blockPublicAccess && c.siteBucket.config.publicRead === true,
    },
    {
      id: "live",
      title: "Visit your website",
      why: "All three pieces are in place: files, hosting and public read. Anyone with the link can see the page now.",
      instructions: [
        "On the bucket page, under Static website hosting, click Open website.",
        "Click the link on the page to see your error document.",
        "Change index.html on your computer, upload it again and refresh: the site updates instantly.",
      ],
      link: siteLink,
      check: async (c) => (await c.siteStatus()) === 200,
    },
  ],
};

TUTORIALS.push(STATIC_WEBSITE);

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
    nextId: "least-privilege",
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

// ---------- IAM ----------

const EC2_READ = "arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess";
const groupsOf = (u: Resource) => (u.config.groups as string[]) ?? [];
const policiesOf = (r: Resource) => (r.config.policyArns as string[]) ?? [];

/** The customer policy the learner wrote for one bucket: allows S3 actions on something other than "*". */
async function bucketPolicy(c: Ctx): Promise<Resource | undefined> {
  const { policies } = await c.iam();
  return policies.find((p) => {
    try {
      const doc = JSON.parse(String(p.config.document)) as { Statement: { Effect: string; Action: string | string[]; Resource: string | string[] }[] | object };
      const sts = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
      return sts.some(
        (st: { Effect?: string; Action?: string | string[]; Resource?: string | string[] }) =>
          st.Effect === "Allow" &&
          [st.Action ?? []].flat().some((a) => a.startsWith("s3:")) &&
          [st.Resource ?? []].flat().some((r) => r.startsWith("arn:aws:s3:::") && r !== "arn:aws:s3:::*"),
      );
    } catch {
      return false;
    }
  });
}

/** The bucket named in that policy, e.g. "team-assets" from arn:aws:s3:::team-assets/* */
async function policyBucket(c: Ctx): Promise<string | undefined> {
  const p = await bucketPolicy(c);
  const m = p ? /arn:aws:s3:::([^/"*]+)/.exec(String(p.config.document)) : null;
  return m?.[1];
}

const LEAST_PRIVILEGE: TutorialDef = {
  id: "least-privilege",
  title: "Least privilege with IAM",
  level: "intermediate",
  summary: "Give a teammate exactly the access they need: a user in a group, a read-only policy, a policy you write yourself, and AccessDenied when they go further.",
  minutes: 12,
  nextId: "serverless-api",
  steps: [
    {
      id: "group",
      title: "Create a developers group with read-only EC2 access",
      why: "Permissions belong to groups, not people: when someone joins or leaves, you change their groups, not a pile of policies. Start with read-only access.",
      instructions: ["Click Take me there.", "Pre-filled: name developers, policy AmazonEC2ReadOnlyAccess.", "Click Create group."],
      link: () => ({ service: "iam", type: "group", mode: "create", prefill: { name: "developers", policyArns: [EC2_READ] } }),
      cli: () => "aws iam create-group --group-name developers",
      check: async (c) => (await c.iam()).groups.some((g) => g.name === "developers" && policiesOf(g).length > 0),
    },
    {
      id: "user",
      title: "Create a user in the group",
      why: "The user dev gets every permission of the developers group, and nothing else. A new user with no group or policy can do nothing at all.",
      instructions: ["Click Take me there.", "Pre-filled: user name dev, group developers.", "Click Create user."],
      link: () => ({ service: "iam", type: "user", mode: "create", prefill: { name: "dev", groups: ["developers"] } }),
      cli: () => "aws iam create-user --user-name dev",
      check: async (c) => (await c.iam()).users.some((u) => u.name === "dev" && groupsOf(u).includes("developers")),
    },
    {
      id: "switch",
      title: "Act as dev",
      why: "Now see the account through dev's eyes. Everything you do in the console and the terminal is checked against dev's policies.",
      instructions: [
        "At the top right, open the menu that says Root user and choose user/dev.",
        "Open VPCs: you can see them (read-only access).",
        "Try Create VPC: you get UnauthorizedOperation, the same error AWS gives.",
        "Open Buckets: AccessDenied. dev has no S3 permissions at all yet.",
      ],
      check: (c) => c.identity === "user/dev",
    },
    {
      id: "policy",
      title: "Write a policy for one bucket",
      why: "dev needs to upload to the team's bucket, and only that one. You'll write the policy yourself: S3 actions, scoped to one bucket's ARN.",
      instructions: [
        "Switch back to Root user first: dev isn't allowed to create policies, which is the point.",
        "Click Take me there. The policy allows listing my-team-bucket and reading and uploading its files.",
        "Change my-team-bucket to the name of one of your buckets (or create a bucket with that name), then click Create policy.",
      ],
      link: () => ({
        service: "iam",
        type: "policy",
        mode: "create",
        prefill: {
          name: "team-bucket-access",
          description: "List, read and upload in the team bucket only",
          document: JSON.stringify(
            {
              Version: "2012-10-17",
              Statement: [
                { Sid: "ListTheBucket", Effect: "Allow", Action: "s3:ListBucket", Resource: "arn:aws:s3:::my-team-bucket" },
                { Sid: "ReadAndUpload", Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: "arn:aws:s3:::my-team-bucket/*" },
              ],
            },
            null,
            2,
          ),
        },
      }),
      check: async (c) => !!(await bucketPolicy(c)),
    },
    {
      id: "attach",
      title: "Attach it to the developers group",
      why: "Attach the policy to the group, so everyone in developers gets it, including people who join later.",
      instructions: ["Open the developers group.", "Under Permissions policies, tick your new policy and click Save changes."],
      link: () => ({ service: "iam", type: "group", mode: "list" }),
      cli: () => "aws iam attach-group-policy --group-name developers --policy-arn <your-policy-arn>",
      check: async (c) => {
        const p = await bucketPolicy(c);
        return !!p && (await c.iam()).groups.some((g) => g.name === "developers" && policiesOf(g).includes(String(p.attributes.arn)));
      },
    },
    {
      id: "verify",
      title: "Prove it: this bucket yes, others no",
      why: "Least privilege means both halves: dev can do the job, and nothing more. The permission checker shows the decision and the statement behind it.",
      instructions: [
        "Open the user dev and use Check permissions.",
        "Upload a file to your team bucket (s3:PutObject on arn:aws:s3:::<bucket>/report.pdf): Allowed, by your policy.",
        "Try another bucket's ARN, or s3:DeleteObject: denied, because no policy allows it.",
        "Then act as dev and upload a file to the bucket in the console to see it work for real.",
      ],
      link: () => ({ service: "iam", type: "user", mode: "list" }),
      check: async (c) => {
        const bucket = await policyBucket(c);
        if (!bucket) return false;
        return (
          (await c.can("dev", "s3:PutObject", `arn:aws:s3:::${bucket}/report.pdf`)) &&
          !(await c.can("dev", "s3:PutObject", `arn:aws:s3:::${bucket}-other/report.pdf`)) &&
          !(await c.can("dev", "s3:DeleteObject", `arn:aws:s3:::${bucket}/report.pdf`))
        );
      },
    },
  ],
};

TUTORIALS.push(LEAST_PRIVILEGE);

// ---------- advanced: load balancing and Auto Scaling ----------

const zoneOf = (r?: Resource) => String(r?.config.availabilityZone ?? "");

const HIGHLY_AVAILABLE: TutorialDef = {
  id: "highly-available-website",
  title: "A website that never goes down",
  level: "advanced",
  summary:
    "Put a load balancer in front of a group of servers in two zones. Stop a server and watch it get replaced while the site keeps answering, then turn up the traffic and watch it grow.",
  minutes: 20,
  needsHa: true,
  steps: [
    {
      id: "two-zones",
      title: "Public subnets in two zones",
      why: "An availability zone is a separate data centre. A load balancer runs in at least two of them, so a fire or power cut in one doesn't take your site down. It needs a public subnet in each.",
      instructions: (c) => {
        if (!c.vpc) return ["You need your own VPC with a public subnet first. Do 'Launch your first web server', then come back."];
        const zones = availabilityZones(c.region);
        const have = c.subnets.filter((x) => isPublicSubnet(c.s, x));
        const other = zones.find((z) => !have.some((x) => zoneOf(x) === z)) ?? zones[1];
        const waiting = c.subnets.find((x) => zoneOf(x) === other && !isPublicSubnet(c.s, x));
        if (waiting && c.table) {
          return [
            `${label(waiting)} is in ${other} but isn't public yet: its route table has no route to the internet gateway.`,
            `Open ${label(c.table)}, tick ${waiting.name || waiting.id} under Associated subnets, and save.`,
          ];
        }
        return [
          `Click Take me there to create a second public subnet in ${other}.`,
          `Then open ${c.table ? label(c.table) : "your public route table"} and tick the new subnet under Associated subnets, so it routes to the internet gateway.`,
        ];
      },
      link: (c) => {
        if (!c.vpc) return undefined;
        const zones = availabilityZones(c.region);
        const have = c.subnets.filter((x) => isPublicSubnet(c.s, x));
        const other = zones.find((z) => !have.some((x) => zoneOf(x) === z)) ?? zones[1];
        const waiting = c.subnets.find((x) => zoneOf(x) === other && !isPublicSubnet(c.s, x));
        if (waiting && c.table) return { service: "networking", type: "route-table", mode: "detail", id: c.table.id };
        return { service: "networking", type: "subnet", mode: "create", prefill: subnetPrefill(c, other, "public-b", true) };
      },
      check: async (c) => (await c.ha()).publicSubnets.length >= 2,
    },
    {
      id: "lb-group",
      title: "A security group for the load balancer",
      why: "The load balancer is the only thing the internet talks to now, so it gets its own firewall: HTTP on port 80 from anyone.",
      instructions: ["Click Take me there.", "Pre-filled: name lb, one inbound rule TCP 80 from 0.0.0.0/0.", "Click Create security group."],
      link: (c) => ({
        service: "networking",
        type: "security-group",
        mode: "create",
        prefill: {
          name: "lb",
          description: "Load balancer: HTTP from the internet",
          vpcId: c.vpc?.id,
          inboundRules: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0", description: "HTTP from anywhere" }],
        },
      }),
      cli: (c) => (c.vpc ? `aws ec2 create-security-group --group-name lb --description "Load balancer" --vpc-id ${c.vpc.id}` : undefined),
      check: async (c) => !!(await c.ha()).lbGroup,
    },
    {
      id: "app-group",
      title: "A security group for the servers: only the load balancer may call them",
      why: "Your servers shouldn't take requests from the internet directly, only from the load balancer. A rule that names the lb security group as its source says exactly that, and keeps working as servers come and go.",
      instructions: [
        "Click Take me there.",
        "Pre-filled: name app, one inbound rule TCP 80 whose source is the lb security group (not an IP range).",
        "Click Create security group.",
      ],
      link: (c) => ({
        service: "networking",
        type: "security-group",
        mode: "create",
        prefill: {
          name: "app",
          description: "Web servers: HTTP from the load balancer only",
          vpcId: c.vpc?.id,
          inboundRules: [{ protocol: "tcp", fromPort: 80, toPort: 80, sourceGroupId: c.haState?.lbGroup?.id, description: "HTTP from the load balancer" }],
        },
      }),
      check: async (c) => !!(await c.ha()).appGroup,
    },
    {
      id: "target-group",
      title: "Create a target group",
      why: "A target group is the list of servers the load balancer sends requests to, plus how it checks they're healthy: it asks each one for / on port 80, and only those that answer get traffic.",
      instructions: ["Click Take me there.", "Pre-filled: name web-servers, HTTP port 80, your VPC.", "Click Create target group. You'll leave it empty: Auto Scaling will fill it."],
      link: (c) => ({
        service: "loadbalancing",
        type: "target-group",
        mode: "create",
        prefill: { name: "web-servers", protocol: "HTTP", port: 80, vpcId: c.vpc?.id, healthCheckPath: "/" },
      }),
      cli: (c) => (c.vpc ? `aws elbv2 create-target-group --name web-servers --protocol HTTP --port 80 --vpc-id ${c.vpc.id}` : undefined),
      check: async (c) => !!(await c.ha()).targetGroup,
    },
    {
      id: "load-balancer",
      title: "Create the load balancer",
      why: "The load balancer gives your site one address that never changes, and spreads requests across the healthy servers in both zones.",
      instructions: [
        "Click Take me there.",
        "Pre-filled: internet-facing, your two public subnets, the lb security group, and a listener on HTTP 80 forwarding to web-servers.",
        "Click Create load balancer. It's 'provisioning' for a few seconds, then 'active'.",
      ],
      link: (c) => {
        const ha = c.haState;
        if (ha?.loadBalancer) return { service: "loadbalancing", type: "load-balancer", mode: "detail", id: ha.loadBalancer.id };
        return {
          service: "loadbalancing",
          type: "load-balancer",
          mode: "create",
          prefill: {
            name: "web-lb",
            scheme: "internet-facing",
            subnetIds: (ha?.publicSubnets ?? []).slice(0, 2).map((x) => x.id),
            securityGroupIds: ha?.lbGroup ? [ha.lbGroup.id] : [],
            listeners: ha?.targetGroup ? [{ protocol: "HTTP", port: 80, targetGroupId: ha.targetGroup.id }] : [],
          },
        };
      },
      cli: () => "aws elbv2 create-load-balancer --name web-lb --subnets <subnet-a> <subnet-b> --security-groups <lb-sg>",
      check: async (c) => {
        const ha = await c.ha();
        return ha.loadBalancer?.state === "active" && listenersOf(ha.loadBalancer).some((l) => Number(l.port) === 80 && l.targetGroupId === ha.targetGroup?.id);
      },
    },
    {
      id: "launch-template",
      title: "Save a launch template",
      why: "Auto Scaling launches servers by itself, so it needs a recipe: which image, which size, which security group, and a startup script that installs the web server.",
      instructions: [
        "Click Take me there.",
        "Pre-filled: Amazon Linux, t3.micro, the app security group, and a startup script that installs nginx.",
        "Click Create launch template.",
      ],
      link: (c) => {
        const ha = c.haState;
        if (ha?.template && ha.appGroup && ((ha.template.config.securityGroupIds as string[]) ?? []).includes(ha.appGroup.id)) {
          return { service: "compute", type: "launch-template", mode: "detail", id: ha.template.id };
        }
        return {
          service: "compute",
          type: "launch-template",
          mode: "create",
          prefill: {
            name: ha?.template ? "web-template-2" : "web-template",
            imageId: LINUX,
            instanceType: "t3.micro",
            securityGroupIds: ha?.appGroup ? [ha.appGroup.id] : [],
            associatePublicIp: "subnet-default",
            userData: "#!/bin/bash\ndnf install -y nginx\nsystemctl enable --now nginx",
          },
        };
      },
      cli: (c) =>
        `aws ec2 create-launch-template --launch-template-name web-template --launch-template-data '{"ImageId":"${LINUX}","InstanceType":"t3.micro","SecurityGroupIds":["${c.haState?.appGroup?.id ?? "<app-sg>"}"]}'`,
      check: async (c) => {
        const ha = await c.ha();
        return !!ha.template && !!ha.appGroup && ((ha.template.config.securityGroupIds as string[]) ?? []).includes(ha.appGroup.id);
      },
    },
    {
      id: "auto-scaling-group",
      title: "Create the Auto Scaling group",
      why: "The group keeps two servers running, one in each zone, and registers them with the target group. If one fails it's replaced; if traffic grows it adds more, up to four.",
      instructions: [
        "Click Take me there.",
        "Pre-filled: your launch template, both public subnets, min 2 / desired 2 / max 4, the web-servers target group, and ELB health checks.",
        "Click Create Auto Scaling group, then watch it launch two instances.",
      ],
      link: (c) => {
        const ha = c.haState;
        if (ha?.group) return { service: "autoscaling", type: "auto-scaling-group", mode: "detail", id: ha.group.id };
        return {
          service: "autoscaling",
          type: "auto-scaling-group",
          mode: "create",
          prefill: {
            name: "web-asg",
            launchTemplate: ha?.template?.name,
            subnetIds: (ha?.publicSubnets ?? []).slice(0, 2).map((x) => x.id),
            minSize: 2,
            desiredCapacity: 2,
            maxSize: 4,
            targetGroupIds: ha?.targetGroup ? [ha.targetGroup.id] : [],
            healthCheckType: "ELB",
            healthCheckGracePeriod: 30,
            simulatedTraffic: "normal",
          },
        };
      },
      cli: () =>
        "aws autoscaling create-auto-scaling-group --auto-scaling-group-name web-asg --launch-template LaunchTemplateName=web-template --min-size 2 --max-size 4 --desired-capacity 2 --vpc-zone-identifier <subnet-a>,<subnet-b> --target-group-arns <tg-arn> --health-check-type ELB",
      check: async (c) => {
        const ha = await c.ha();
        const g = ha.group;
        if (!g || !ha.targetGroup) return false;
        const zones = new Set(ha.publicSubnets.filter((x) => ((g.config.subnetIds as string[]) ?? []).includes(x.id)).map(zoneOf));
        return ((g.config.targetGroupIds as string[]) ?? []).includes(ha.targetGroup.id) && zones.size >= 2;
      },
    },
    {
      id: "healthy",
      title: "Watch it come alive",
      why: "New servers start as 'initial' while the load balancer checks them. Once they pass, they're 'healthy' and get requests, taking turns.",
      instructions: [
        "Open the target group: two targets go from initial to healthy in about 20 seconds.",
        "Then open the load balancer and click Send 6 requests: the answers alternate between two servers in two zones.",
      ],
      link: (c) => (c.haState?.targetGroup ? { service: "loadbalancing", type: "target-group", mode: "detail", id: c.haState.targetGroup.id } : undefined),
      check: async (c) => {
        const spread = healthySpread(await c.ha());
        return spread.count >= 2 && spread.zones >= 2;
      },
    },
    {
      id: "self-heal",
      title: "Break a server and watch it heal",
      why: "This is the point of it all. When a server fails, the load balancer stops sending it requests and the Auto Scaling group replaces it. Nobody has to wake up.",
      instructions: [
        "Open one of the group's instances and click Stop.",
        "Send requests to the load balancer: every answer still comes back 200, from the other server.",
        "Open the Auto Scaling group: the activity history shows it terminating the stopped server and launching a replacement. Wait until two targets are healthy again.",
      ],
      link: (c) => {
        const victim = c.haState?.members.find((i) => i.state === "running");
        return victim ? { service: "compute", type: "instance", mode: "detail", id: victim.id } : undefined;
      },
      check: async (c) => {
        const ha = await c.ha();
        const healed = activityCauses(ha.group).some((x) => x.includes("status check failure") || x.includes("health check failure"));
        const spread = healthySpread(ha);
        return healed && spread.count >= 2;
      },
    },
    {
      id: "scale",
      title: "Turn up the traffic",
      why: "A target tracking policy keeps average CPU near a target by adding servers when it's busy and removing them when it's quiet. You pay for what the traffic needs, not for the peak all the time.",
      instructions: [
        "Open the Auto Scaling group. Under Edit settings, set Target tracking: average CPU % to 50 and save.",
        "In Capacity and load, click Spike. Average CPU jumps far above 50%, and the group scales out to four servers.",
        "Click Idle and wait about 20 seconds: it scales back in.",
      ],
      link: (c) => (c.haState?.group ? { service: "autoscaling", type: "auto-scaling-group", mode: "detail", id: c.haState.group.id } : undefined),
      cli: () =>
        `aws autoscaling put-scaling-policy --auto-scaling-group-name web-asg --policy-name cpu50 --policy-type TargetTrackingScaling --target-tracking-configuration '{"PredefinedMetricSpecification":{"PredefinedMetricType":"ASGAverageCPUUtilization"},"TargetValue":50}'`,
      check: async (c) => activityCauses((await c.ha()).group).some((x) => x.includes("scaled out")),
    },
  ],
};

// ---------- intermediate: a managed database ----------

const MANAGED_DATABASE: TutorialDef = {
  id: "managed-database",
  title: "A managed database for your web app",
  level: "intermediate",
  summary:
    "Give your web server a PostgreSQL database the way production teams do: in private subnets, reachable only from the web server, backed up, with a standby in a second zone.",
  minutes: 15,
  nextId: "highly-available-website",
  needsDb: true,
  steps: [
    {
      id: "web-server",
      title: "Start with a running web server",
      why: "The database is for an app, so you need the app's server first. Its security group is what the database will trust.",
      instructions: (c) =>
        c.webServer
          ? [`You have ${label(c.webServer)} in a public subnet. Make sure it's running.`]
          : ["You need a running web server in a public subnet of your own VPC.", "Do 'Launch your first web server' first, then come back."],
      link: (c) => (c.webServer ? { service: "compute", type: "instance", mode: "detail", id: c.webServer.id } : undefined),
      check: (c) => c.webServer?.state === "running",
    },
    {
      id: "private-subnets",
      title: "Private subnets in two zones",
      why: "A database never belongs in a public subnet. RDS also needs subnets in two zones, so it has somewhere to put a standby if you ask for one.",
      instructions: (c) => {
        const have = c.dbState?.privateSubnets ?? [];
        const zone = availabilityZones(c.region).find((z) => !have.some((x) => zoneOf(x) === z)) ?? availabilityZones(c.region)[1];
        return [
          have.length ? `You have a private subnet in ${have.map(zoneOf).join(", ")}. Add one in ${zone}.` : `Create a private subnet in ${zone}, then another in a second zone.`,
          "Click Take me there: Auto-assign public IPv4 is off. Don't associate it with your public route table.",
        ];
      },
      link: (c) => {
        const have = c.dbState?.privateSubnets ?? [];
        const zone = availabilityZones(c.region).find((z) => !have.some((x) => zoneOf(x) === z)) ?? availabilityZones(c.region)[1];
        return c.vpc ? { service: "networking", type: "subnet", mode: "create", prefill: subnetPrefill(c, zone, `db-${zone.slice(-1)}`, false) } : undefined;
      },
      check: async (c) => (await c.db()).privateSubnets.length >= 2,
    },
    {
      id: "subnet-group",
      title: "Create a DB subnet group",
      why: "A DB subnet group tells RDS which subnets the database may use. Picking only private subnets is what keeps the database off the internet.",
      instructions: ["Click Take me there.", "Pre-filled: name app-db-subnets and your two private subnets.", "Click Create DB subnet group."],
      link: (c) => ({
        service: "rds",
        type: "db-subnet-group",
        mode: "create",
        prefill: { name: "app-db-subnets", description: "Private subnets for the app database", subnetIds: (c.dbState?.privateSubnets ?? []).map((x) => x.id) },
      }),
      cli: (c) =>
        `aws rds create-db-subnet-group --db-subnet-group-name app-db-subnets --db-subnet-group-description "App database" --subnet-ids ${(c.dbState?.privateSubnets ?? []).map((x) => x.id).join(" ") || "<subnet-a> <subnet-b>"}`,
      check: async (c) => !!(await c.db()).group,
    },
    {
      id: "db-group",
      title: "A security group that only lets the web server in",
      why: "The database's firewall allows PostgreSQL (port 5432) from one source: the web server's security group. Any server in that group can connect; nothing else can, not even other servers in the VPC.",
      instructions: (c) => [
        "Click Take me there.",
        `Pre-filled: name db, one inbound rule TCP 5432 whose source is ${c.group ? label(c.group) : "your web server's security group"}.`,
        "Click Create security group.",
      ],
      link: (c) => ({
        service: "networking",
        type: "security-group",
        mode: "create",
        prefill: {
          name: "db",
          description: "PostgreSQL from the web servers only",
          vpcId: c.vpc?.id,
          inboundRules: [{ protocol: "tcp", fromPort: 5432, toPort: 5432, sourceGroupId: c.group?.id, description: "PostgreSQL from the web servers" }],
        },
      }),
      check: async (c) => !!(await c.db()).dbGroup,
    },
    {
      id: "database",
      title: "Create the database",
      why: "RDS runs PostgreSQL for you: installation, patches, backups and failover are its job. You choose the size, the network and the master password.",
      instructions: [
        "Click Take me there.",
        "Pre-filled: PostgreSQL on db.t3.micro, 20 GiB, master user app, your subnet group and the db security group, not publicly accessible.",
        "Type a master password (8+ characters) and click Create database. It takes about 15 seconds to become available.",
      ],
      link: (c) => {
        const d = c.dbState;
        if (d?.database) return { service: "rds", type: "db-instance", mode: "detail", id: d.database.id };
        return {
          service: "rds",
          type: "db-instance",
          mode: "create",
          prefill: {
            name: "app-db",
            engine: "postgres",
            dbInstanceClass: "db.t3.micro",
            allocatedStorage: 20,
            masterUsername: "app",
            dbName: "app",
            dbSubnetGroupName: d?.group?.name,
            vpcSecurityGroupIds: d?.dbGroup ? [d.dbGroup.id] : [],
            publiclyAccessible: false,
            multiAZ: false,
            backupRetentionPeriod: 7,
          },
        };
      },
      cli: (c) =>
        `aws rds create-db-instance --db-instance-identifier app-db --engine postgres --db-instance-class db.t3.micro --allocated-storage 20 --master-username app --master-user-password '<choose one>' --db-name app --db-subnet-group-name app-db-subnets --vpc-security-group-ids ${c.dbState?.dbGroup?.id ?? "<db-sg>"} --no-publicly-accessible`,
      check: async (c) => {
        const db = (await c.db()).database;
        return db?.state === "available" && !db.config.publiclyAccessible;
      },
    },
    {
      id: "connect",
      title: "Prove it: the web server yes, the internet no",
      why: "This is the whole design in one check. The web server reaches the database through security group chaining; from the internet there's no address and no rule, so nothing gets in.",
      instructions: [
        "Open the database. Under Can it connect?, choose your web server and click Check connection: all green, with the psql command to use.",
        "Then choose The internet: it fails, because the database is private.",
      ],
      link: (c) => (c.dbState?.database ? { service: "rds", type: "db-instance", mode: "detail", id: c.dbState.database.id } : undefined),
      check: async (c) => {
        const p = await (await c.db()).proof(c.webServer);
        return p.fromWeb && !p.fromInternet;
      },
    },
    {
      id: "snapshot",
      title: "Take a snapshot",
      why: "Automated backups run every day, but before a risky change (a migration, a big delete) you take a snapshot yourself. Restoring always makes a new database, so nothing is overwritten.",
      instructions: ["Open the database and click Take snapshot under Backups and snapshots.", "Click Create snapshot. It's available after a few seconds."],
      link: (c) =>
        c.dbState?.database
          ? { service: "rds", type: "db-snapshot", mode: "create", prefill: { name: `${c.dbState.database.name}-first-backup`, dbInstanceIdentifier: c.dbState.database.name } }
          : undefined,
      cli: () => "aws rds create-db-snapshot --db-snapshot-identifier app-db-first-backup --db-instance-identifier app-db",
      check: async (c) => (await c.db()).snapshots.some((x) => x.state === "available"),
    },
    {
      id: "multi-az",
      title: "Survive a zone failure with Multi-AZ",
      why: "With Multi-AZ, RDS keeps a standby copy in the other zone. If the primary's zone fails, the standby takes over and the endpoint name points at it, so the app reconnects without any change.",
      instructions: [
        "Open the database. Under Edit settings, tick Multi-AZ and save. Wait until it's available again.",
        "Click Reboot with failover. Watch Runs in and Standby swap zones, while the endpoint stays exactly the same.",
      ],
      link: (c) => (c.dbState?.database ? { service: "rds", type: "db-instance", mode: "detail", id: c.dbState.database.id } : undefined),
      cli: () => "aws rds modify-db-instance --db-instance-identifier app-db --multi-az --apply-immediately",
      check: async (c) => Number((await c.db()).database?.attributes.failovers ?? 0) >= 1,
    },
  ],
};

// ---------- intermediate: serverless ----------

const LAMBDA_TRUST = JSON.stringify(
  { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] },
  null,
  2,
);

const HELLO_CODE = `export const handler = async (event) => {
  const name = event.queryStringParameters?.name ?? "world";
  console.log("Saying hello to", name);
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: \`Hello, \${name}!\` }),
  };
};
`;

const SERVERLESS_API: TutorialDef = {
  id: "serverless-api",
  title: "Your first serverless API",
  level: "intermediate",
  summary:
    "Write a Lambda function, put an HTTP API in front of it, and call it from your browser. No servers, no network setup: and you'll meet (and fix) the error almost everyone hits first.",
  minutes: 12,
  nextId: "watch-your-app",
  needsServerless: true,
  steps: [
    {
      id: "role",
      title: "Create an execution role for Lambda",
      why: "Every function runs as an IAM role. Its trust policy lets Lambda assume it; AWSLambdaBasicExecutionRole lets the function write its logs. Nothing else, until it needs more.",
      instructions: ["Click Take me there.", "Pre-filled: name lambda-basic, a trust policy for lambda.amazonaws.com, and AWSLambdaBasicExecutionRole.", "Click Create role."],
      link: () => ({
        service: "iam",
        type: "role",
        mode: "create",
        prefill: {
          name: "lambda-basic",
          description: "Lets Lambda functions run and write logs",
          trustPolicy: LAMBDA_TRUST,
          policyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
        },
      }),
      cli: () =>
        `aws iam create-role --role-name lambda-basic --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'`,
      check: async (c) => !!(await c.sls()).role,
    },
    {
      id: "function",
      title: "Create the function",
      why: "A Lambda function is just your code plus settings. It runs only when something calls it, and you pay only for those milliseconds.",
      instructions: (c) => [
        "Click Take me there.",
        `Pre-filled: name hello, Node.js 22, role ${c.slsState?.role?.name ?? "lambda-basic"}, and code that greets ?name= from the URL.`,
        "Read the code, then click Create function. It's Pending for a second, then Active.",
      ],
      link: (c) =>
        c.slsState?.fn
          ? { service: "lambda", type: "function", mode: "detail", id: c.slsState.fn.id }
          : {
              service: "lambda",
              type: "function",
              mode: "create",
              prefill: { name: "hello", runtime: "nodejs22.x", handler: "index.handler", role: c.slsState?.role?.name, files: { "index.mjs": HELLO_CODE } },
            },
      check: async (c) => (await c.sls()).fn?.state === "Active",
    },
    {
      id: "test",
      title: "Test it",
      why: "Before wiring anything to it, run the function on its own with a sample event. You see its answer, its log lines and how long it took, including the cold start.",
      instructions: [
        "On the function's page, under Test, choose the API Gateway HTTP API (GET /hello?name=Ada) template.",
        "Click Test. You should see Execution result: succeeded, the response, and your console.log line in the log output.",
        "Click Test again: no Init Duration this time. The function is warm.",
      ],
      link: (c) => (c.slsState?.fn ? { service: "lambda", type: "function", mode: "detail", id: c.slsState.fn.id } : undefined),
      check: async (c) => (((await c.sls()).fn?.attributes.invocations as { status: string }[] | undefined) ?? []).some((i) => i.status === "Succeeded"),
    },
    {
      id: "api",
      title: "Create an HTTP API",
      why: "API Gateway gives your function a public web address. An HTTP API is the simple, cheap kind.",
      instructions: ["Click Take me there.", "Pre-filled: name hello-api.", "Click Create API."],
      link: (c) => (c.slsState?.api ? { service: "apigateway", type: "api", mode: "detail", id: c.slsState.api.id } : { service: "apigateway", type: "api", mode: "create", prefill: { name: "hello-api" } }),
      cli: () => "aws apigatewayv2 create-api --name hello-api --protocol-type HTTP",
      check: async (c) => !!(await c.sls()).api,
    },
    {
      id: "stage",
      title: "Deploy it: the $default stage",
      why: "An API answers only once it has a stage. $default serves it at the root of its address, and deploys every change automatically.",
      instructions: ["Click Take me there (or Create $default stage on the API's page).", "Click Create stage."],
      link: (c) => (c.slsState?.api ? { service: "apigateway", type: "stage", mode: "create", prefill: { apiId: c.slsState.api.id, name: "$default" } } : undefined),
      check: async (c) => !!(await c.sls()).stage,
    },
    {
      id: "integration",
      title: "Connect the API to the function",
      why: "An integration says where requests go: here, the hello function. It passes the whole request in, and the function's answer back out.",
      instructions: ["Click Take me there.", "Pre-filled: your API and the hello function, payload format 2.0.", "Click Create integration."],
      link: (c) =>
        c.slsState?.api
          ? { service: "apigateway", type: "integration", mode: "create", prefill: { apiId: c.slsState.api.id, functionName: c.slsState.fn?.name ?? "hello" } }
          : undefined,
      check: async (c) => !!(await c.sls()).integration,
    },
    {
      id: "route",
      title: "Add the route GET /hello",
      why: "A route picks which requests go to the integration. GET /hello means: GET requests to /hello.",
      instructions: ["Click Take me there.", "Pre-filled: GET /hello and your integration.", "Click Create route."],
      link: (c) =>
        c.slsState?.api
          ? { service: "apigateway", type: "route", mode: "create", prefill: { apiId: c.slsState.api.id, routeKey: "GET /hello", integrationId: c.slsState.integration?.id } }
          : undefined,
      check: async (c) => !!(await c.sls()).route,
    },
    {
      id: "first-call",
      title: "Call it… and get a 500",
      why: "Everything looks connected, yet the call fails with Internal Server Error. This is the most common first serverless bug: API Gateway isn't allowed to invoke the function.",
      instructions: [
        "Open the API's page. Under Try it, the path is /hello?name=Ada: click Send.",
        "You get 500 {\"message\":\"Internal Server Error\"}. Read the Why line under it.",
      ],
      link: (c) => (c.slsState?.api ? { service: "apigateway", type: "api", mode: "detail", id: c.slsState.api.id } : undefined),
      check: async (c) => {
        const s = await c.sls();
        return s.permitted || s.requests.some((r) => r.status === 500);
      },
    },
    {
      id: "permission",
      title: "Let API Gateway invoke the function",
      why: "Two policies are involved. The execution role says what the function may do; the function's resource-based policy says who may call it. API Gateway needs a statement there. (The AWS console adds it for you; the CLI doesn't.)",
      instructions: [
        "Open the hello function. Under Resource-based policy, choose hello-api and click Add permission.",
        "Or from the terminal, the command below.",
      ],
      link: (c) => (c.slsState?.fn ? { service: "lambda", type: "function", mode: "detail", id: c.slsState.fn.id } : undefined),
      cli: (c) =>
        c.slsState?.api
          ? `aws lambda add-permission --function-name hello --statement-id apigateway-invoke --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${c.region}:<account-id>:${c.slsState.api.id}/*"`
          : undefined,
      check: async (c) => (await c.sls()).permitted,
    },
    {
      id: "success",
      title: "Call it again: it works",
      why: "Your function now has a real public address. Open it in a new tab, change ?name=, and call it with curl from the terminal too.",
      instructions: (c) => [
        "On the API's page, click Send again: 200 and {\"message\":\"Hello, Ada!\"}.",
        "Open the invoke URL in a new browser tab with /hello?name=YourName at the end.",
        c.slsState?.api ? `In the terminal: curl "https://${c.slsState.api.id}.execute-api.${c.region}.cloudlab.local/hello?name=CLI"` : "In the terminal: curl <your API's endpoint>/hello?name=CLI",
      ],
      link: (c) => (c.slsState?.api ? { service: "apigateway", type: "api", mode: "detail", id: c.slsState.api.id } : undefined),
      check: async (c) => (await c.sls()).requests.some((r) => r.status === 200),
    },
  ],
};


const ORDERS_CODE = `export const handler = async (event) => {
  console.log("New order:", JSON.stringify(event));
  if (!event.item) {
    // A bad order: this error shows up in the logs and in the Errors graph.
    throw new Error("Order has no item");
  }
  console.log("Saved order for", event.item);
  return { ok: true, item: event.item };
};
`;

const fnLink = (c: Ctx): GuideLink | undefined => (c.watchState?.fn ? { service: "lambda", type: "function", mode: "detail", id: c.watchState.fn.id } : undefined);

const WATCH_YOUR_APP: TutorialDef = {
  id: "watch-your-app",
  title: "Watch your app: logs, graphs and an alarm",
  level: "intermediate",
  summary:
    "Things break in production, and you want to know before your users tell you. Read a function's logs, find the error, see it on a graph, and set an alarm that goes off by itself when errors happen.",
  minutes: 10,
  nextId: "managed-database",
  needsWatch: true,
  steps: [
    {
      id: "role",
      title: "A role that can write logs",
      why: "Lambda writes your function's logs using its execution role. AWSLambdaBasicExecutionRole is what allows it (logs:CreateLogGroup, CreateLogStream, PutLogEvents). Without it, the function runs but its logs are lost.",
      instructions: (c) =>
        c.slsState?.role
          ? [`You already have ${c.slsState.role.name}. Nothing to do.`]
          : ["Click Take me there.", "Pre-filled: name lambda-basic, trusted by Lambda, with AWSLambdaBasicExecutionRole.", "Click Create role."],
      link: (c) =>
        c.slsState?.role
          ? { service: "iam", type: "role", mode: "detail", id: c.slsState.role.id }
          : {
              service: "iam",
              type: "role",
              mode: "create",
              prefill: {
                name: "lambda-basic",
                description: "Lets Lambda functions run and write logs",
                trustPolicy: LAMBDA_TRUST,
                policyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
              },
            },
      check: async (c) => !!(await c.sls()).role,
    },
    {
      id: "function",
      title: `Create the ${WATCHED_FUNCTION} function`,
      why: "A small function that saves orders, and fails when an order has no item. A real bug we can watch for.",
      instructions: ["Click Take me there.", `Pre-filled: name ${WATCHED_FUNCTION}, Node.js 22, and code that throws an error for an order without an item.`, "Click Create function."],
      link: (c) =>
        fnLink(c) ?? {
          service: "lambda",
          type: "function",
          mode: "create",
          prefill: { name: WATCHED_FUNCTION, runtime: "nodejs22.x", handler: "index.handler", role: c.slsState?.role?.name, files: { "index.mjs": ORDERS_CODE } },
        },
      check: async (c) => (await c.watch()).fn?.state === "Active",
    },
    {
      id: "run",
      title: "Send one good order and one bad one",
      why: "Logs and graphs only show what happened, so first make something happen: a success and a failure.",
      instructions: [
        `On ${WATCHED_FUNCTION}'s page, under Test, write the event {"item": "book"} and click Test. Succeeded.`,
        'Now test with {} (no item). It fails with "Order has no item".',
      ],
      link: fnLink,
      cli: () => `aws lambda invoke --function-name ${WATCHED_FUNCTION} --cli-binary-format raw-in-base64-out --payload '{}' out.json`,
      check: async (c) => {
        const runs = ((await c.watch()).fn?.attributes.invocations as { status: string }[] | undefined) ?? [];
        return runs.some((r) => r.status === "Succeeded") && runs.some((r) => r.status !== "Succeeded");
      },
    },
    {
      id: "logs",
      title: "Find the error in the logs",
      why: "Everything a function prints goes to CloudWatch Logs: the log group /aws/lambda/<name>, one log stream per running copy. Searching it is how you find out what went wrong.",
      instructions: (c) =>
        c.watchState?.fn?.attributes.logsDenied
          ? [`The function's logs aren't being saved: its role can't write them. Attach AWSLambdaBasicExecutionRole to ${String(c.watchState.fn.config.role)}, then run the tests again.`]
          : [
              `Open the log group /aws/lambda/${WATCHED_FUNCTION} (or click View logs in CloudWatch on the function's page).`,
              "Read the lines: START, your console.log output, END and REPORT (duration and memory) for each run.",
              'Type ERROR in the filter box and click Search: only the failed run\'s error is left.',
            ],
      link: (c) => (c.watchState?.logGroup ? { service: "logs", type: "log-group", mode: "detail", id: c.watchState.logGroup.id } : fnLink(c)),
      cli: () => `aws logs tail /aws/lambda/${WATCHED_FUNCTION} --since 1h`,
      check: async (c) => {
        const w = await c.watch();
        return !!w.logGroup && w.hasLogEvents && !w.fn?.attributes.logsDenied;
      },
    },
    {
      id: "graphs",
      title: "See it on the graphs",
      why: "Logs tell you what happened once; metrics show the trend. Lambda counts every run (Invocations), every failure (Errors) and how long each took (Duration), per minute.",
      instructions: [
        `Open ${WATCHED_FUNCTION}'s page and scroll to Monitoring.`,
        "Invocations shows 2, Errors shows 1. Hover a point to see its exact time and value.",
      ],
      link: fnLink,
      cli: () =>
        `aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Errors --dimensions Name=FunctionName,Value=${WATCHED_FUNCTION} --statistics Sum --period 60 --start-time <1 hour ago> --end-time <now>`,
      check: async (c) => (await c.watch()).hasMetrics,
    },
    {
      id: "alarm",
      title: "Create an alarm on errors",
      why: "Nobody stares at graphs all day. An alarm watches one metric for you and changes to ALARM when it crosses a line: here, more than 0 errors in a minute. (On AWS it would then email you through SNS.)",
      instructions: [
        "Click Take me there (or Create alarm under the Errors graph).",
        `Pre-filled: Errors of ${WATCHED_FUNCTION}, Sum over 1 minute, > 0. Missing data is notBreaching: no runs means no errors.`,
        "Click Create alarm. It starts as Insufficient data or OK.",
      ],
      link: (c) =>
        c.watchState?.alarm
          ? { service: "cloudwatch", type: "alarm", mode: "detail", id: c.watchState.alarm.id }
          : {
              service: "cloudwatch",
              type: "alarm",
              mode: "create",
              prefill: {
                name: `${WATCHED_FUNCTION}-errors`,
                description: `Any error in ${WATCHED_FUNCTION}`,
                namespace: "AWS/Lambda",
                metricName: "Errors",
                dimensions: [{ name: "FunctionName", value: WATCHED_FUNCTION }],
                statistic: "Sum",
                period: 60,
                evaluationPeriods: 1,
                comparisonOperator: "GreaterThanThreshold",
                threshold: 0,
                treatMissingData: "notBreaching",
              },
            },
      cli: () =>
        `aws cloudwatch put-metric-alarm --alarm-name ${WATCHED_FUNCTION}-errors --namespace AWS/Lambda --metric-name Errors --dimensions Name=FunctionName,Value=${WATCHED_FUNCTION} --statistic Sum --period 60 --evaluation-periods 1 --threshold 0 --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching`,
      check: async (c) => !!(await c.watch()).alarm,
    },
    {
      id: "fire",
      title: "Break it, and watch the alarm go off",
      why: "An alarm looks at complete minutes, so it reacts within about a minute of the problem. The Reason says exactly which value crossed the threshold.",
      instructions: [
        `Test ${WATCHED_FUNCTION} with {} again (a bad order).`,
        "Open the alarm and wait up to a minute: it turns In alarm, and the History shows the change.",
        "Later, with no more errors, it goes back to OK by itself.",
      ],
      link: (c) => (c.watchState?.alarm ? { service: "cloudwatch", type: "alarm", mode: "detail", id: c.watchState.alarm.id } : fnLink(c)),
      cli: () => `aws cloudwatch describe-alarms --alarm-names ${WATCHED_FUNCTION}-errors`,
      check: async (c) => (await c.watch()).alarmFired,
    },
    {
      id: "dashboard",
      title: "Put the graphs on a dashboard",
      why: "A dashboard is your own page of graphs, mixing any services: the first place to look when something seems wrong.",
      instructions: [
        "Click Take me there: a dashboard with Invocations and Errors is pre-filled. Click Create dashboard.",
        `Or, on ${WATCHED_FUNCTION}'s page, click Add to dashboard under any graph.`,
      ],
      link: (c) =>
        c.watchState?.dashboard
          ? { service: "cloudwatch", type: "dashboard", mode: "detail", id: c.watchState.dashboard.id }
          : {
              service: "cloudwatch",
              type: "dashboard",
              mode: "create",
              prefill: {
                name: "my-app",
                body: JSON.stringify(
                  {
                    widgets: [
                      { type: "metric", width: 12, height: 6, properties: { title: "Orders handled", stat: "Sum", period: 60, metrics: [["AWS/Lambda", "Invocations", "FunctionName", WATCHED_FUNCTION]] } },
                      { type: "metric", width: 12, height: 6, properties: { title: "Failed orders", stat: "Sum", period: 60, metrics: [["AWS/Lambda", "Errors", "FunctionName", WATCHED_FUNCTION]] } },
                    ],
                  },
                  null,
                  2,
                ),
              },
            },
      check: async (c) => !!(await c.watch()).dashboard,
    },
  ],
};


const serverIp = (c: Ctx) => (c.instance?.attributes.publicIp as string | undefined) ?? undefined;
const zoneName = (c: Ctx) => c.dnsState?.zone?.name ?? TUTORIAL_DOMAIN;
const zoneLink = (c: Ctx): GuideLink | undefined => (c.dnsState?.zone ? { service: "route53", type: "hosted-zone", mode: "detail", id: c.dnsState.zone.id } : undefined);

const REAL_NAME: TutorialDef = {
  id: "website-real-name",
  title: "Give your website a real name",
  level: "intermediate",
  summary:
    "Nobody remembers 3.91.12.7. Create a hosted zone for myshop.com, point www.myshop.com at your web server, make the bare domain work too (and meet the CNAME-at-apex rule), then add a health check that watches the site.",
  minutes: 10,
  nextId: "highly-available-website",
  needsDns: true,
  steps: [
    {
      id: "server",
      title: "Have a web server to name",
      why: "DNS only gives out addresses; something must answer at the address. This uses the web server from 'Launch your first web server'.",
      instructions: (c) =>
        c.instance
          ? [`Your server ${label(c.instance)} needs a public IP and port 80 open to the internet.`, "If this step isn't ticked, open it and run the HTTP reachability check to see what's missing."]
          : ["You don't have a web server yet. Do the tutorial 'Launch your first web server' first, then come back."],
      link: (c) => (c.instance ? { service: "compute", type: "instance", mode: "detail", id: c.instance.id } : { service: "compute", type: "instance", mode: "list" }),
      check: reachable,
    },
    {
      id: "zone",
      title: `Create a hosted zone for ${TUTORIAL_DOMAIN}`,
      why: "A hosted zone is where a domain's records live. Route 53 adds two right away: NS (which name servers answer for the domain) and SOA (who's in charge, and for how long answers may be cached). On AWS you'd also buy the domain and give the registrar these name servers; in CloudLab it works straight away.",
      instructions: ["Click Take me there.", `Pre-filled: ${TUTORIAL_DOMAIN}. Click Create hosted zone.`, "On its page, look at the NS and SOA records it came with."],
      link: (c) => zoneLink(c) ?? { service: "route53", type: "hosted-zone", mode: "create", prefill: { name: TUTORIAL_DOMAIN } },
      cli: () => `aws route53 create-hosted-zone --name ${TUTORIAL_DOMAIN} --caller-reference my-first-zone`,
      check: async (c) => !!(await c.dns()).zone,
    },
    {
      id: "www",
      title: (c) => `Point www.${zoneName(c)} at your server`,
      why: "An A record answers “what's the IPv4 address of this name?”. TTL is how long resolvers may remember the answer: 300 seconds means a change takes up to 5 minutes to reach everyone.",
      instructions: (c) => ["Click Take me there.", `Pre-filled: name www, type A, value ${serverIp(c) ?? "your server's public IP"}, TTL 300.`, "Click Create record."],
      link: (c) =>
        c.dnsState?.www
          ? { service: "route53", type: "record-set", mode: "detail", id: c.dnsState.www.id }
          : c.dnsState?.zone
            ? {
                service: "route53",
                type: "record-set",
                mode: "create",
                prefill: { zoneId: c.dnsState.zone.id, name: "www", type: "A", ttl: 300, values: [{ value: serverIp(c) ?? "" }], routingPolicy: "simple" },
              }
            : undefined,
      cli: (c) =>
        c.dnsState?.zone
          ? `aws route53 change-resource-record-sets --hosted-zone-id ${c.dnsState.zone.id} --change-batch '{"Changes":[{"Action":"CREATE","ResourceRecordSet":{"Name":"www.${zoneName(c)}","Type":"A","TTL":300,"ResourceRecords":[{"Value":"${serverIp(c) ?? "<ip>"}"}]}}]}'`
          : undefined,
      check: async (c) => !!(await c.dns()).www,
    },
    {
      id: "visit",
      title: (c) => `Open www.${zoneName(c)}`,
      why: "This is what a browser does: ask DNS for the address, then connect to it. If it fails, the test shows which half went wrong: the name or the server.",
      instructions: (c) => [
        `On the hosted zone's page, under Test a name, test www.${zoneName(c)}: the DNS answer, then HTTP 200 from your server.`,
        `Or in the terminal: dig www.${zoneName(c)}, then curl -i http://www.${zoneName(c)}`,
      ],
      link: zoneLink,
      cli: (c) => `curl -i http://www.${zoneName(c)}`,
      check: async (c) => (await c.dns()).visited,
    },
    {
      id: "apex",
      title: (c) => `Make ${zoneName(c)} work too`,
      why: "People also type the bare domain. A CNAME (“this name is really that name”) isn't allowed there: the apex already has NS and SOA records, and a CNAME can't share a name with anything. Route 53's alias records solve it: an A record that copies another name's addresses.",
      instructions: (c) => [
        `First, see the rule: create a record with an empty name, type CNAME, value www.${zoneName(c)}. Route 53 refuses: “not permitted at apex”.`,
        `Now click Take me there: an A record with Alias on, target www.${zoneName(c)}. Create it.`,
        `Test ${zoneName(c)}: the answer is an A record (TTL 60), no CNAME in sight.`,
      ],
      link: (c) =>
        c.dnsState?.apex
          ? { service: "route53", type: "record-set", mode: "detail", id: c.dnsState.apex.id }
          : c.dnsState?.zone
            ? { service: "route53", type: "record-set", mode: "create", prefill: { zoneId: c.dnsState.zone.id, name: "", type: "A", alias: true, aliasTarget: `www.${zoneName(c)}`, routingPolicy: "simple" } }
            : undefined,
      cli: (c) => `dig ${zoneName(c)}`,
      check: async (c) => !!(await c.dns()).apex,
    },
    {
      id: "health",
      title: "Watch the site with a health check",
      why: "A health check calls your server from the internet every 30 seconds. Attached to failover or weighted records, it makes Route 53 stop sending people to a server that's down.",
      instructions: (c) => [
        "Click Take me there.",
        `Pre-filled: HTTP to ${serverIp(c) ?? "your server's IP"} port 80, path /. Click Create health check.`,
        "Its page shows Healthy. Try closing port 80 in the server's security group: it turns Unhealthy within seconds. (Open it again afterwards.)",
      ],
      link: (c) =>
        c.dnsState?.healthCheck
          ? { service: "route53", type: "health-check", mode: "detail", id: c.dnsState.healthCheck.id }
          : { service: "route53", type: "health-check", mode: "create", prefill: { name: "web", type: "HTTP", ipAddress: serverIp(c), port: 80, resourcePath: "/" } },
      cli: (c) => `aws route53 create-health-check --caller-reference web-check --health-check-config Type=HTTP,IPAddress=${serverIp(c) ?? "<ip>"},Port=80,ResourcePath=/`,
      check: async (c) => (await c.dns()).healthy,
    },
  ],
};

TUTORIALS.push(SERVERLESS_API, WATCH_YOUR_APP, MANAGED_DATABASE, REAL_NAME, HIGHLY_AVAILABLE);

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
export async function viewTutorial(
  engine: Engine,
  accountId: string,
  region: string,
  id: string,
  identity = "root",
): Promise<TutorialView | null> {
  const t = TUTORIALS.find((x) => x.id === id);
  if (!t) return null;
  // Auto Scaling groups catch up whenever the region is looked at.
  await engine.ensureDefaults(accountId, region);
  const c = await buildCtx(engine, accountId, region, identity);
  if (t.needsHa) c.haState = await c.ha();
  if (t.needsDb) c.dbState = await c.db();
  if (t.needsServerless) c.slsState = await c.sls();
  if (t.needsDns) c.dnsState = await c.dns();
  if (t.needsWatch) {
    c.slsState = await c.sls();
    c.watchState = await c.watch();
  }
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
