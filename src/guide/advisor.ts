import { analyzeReachability, reachabilityInput, type ReachabilityResult } from "@/engine/analysis/reachability";
import { availabilityZones } from "@/engine/catalog";
import type { Engine } from "@/engine/engine";
import type { Resource } from "@/engine/types";
import {
  bucketName,
  coversPort,
  effectiveRouteTable,
  inboundRules,
  isPublicSubnet,
  routesToNat,
  focusVpc,
  freeSubnetCidr,
  isOwn,
  label,
  takeSnapshot,
  type SgRule,
  type Snapshot,
} from "./snapshot";
import type { Advice, Level, Milestone, Suggestion } from "./types";

/**
 * The "What's next?" advisor. It looks at what the learner has built in a
 * region and returns the single most useful next step, a few other ideas,
 * and progress milestones. Rules run in priority order: the first one that
 * applies is the next step.
 */

const TRANSITIONAL = ["pending", "stopping", "shutting-down", "rebooting"];

const DATABASE_PORTS = [
  { port: 5432, name: "PostgreSQL" },
  { port: 3306, name: "MySQL" },
  { port: 1433, name: "SQL Server" },
  { port: 27017, name: "MongoDB" },
  { port: 6379, name: "Redis" },
];

export async function advise(engine: Engine, accountId: string, region: string): Promise<Advice> {
  const s = await takeSnapshot(engine, accountId, region);

  const out: Suggestion[] = [];
  const push = (sg: Suggestion) => out.push(sg);

  const vpc = focusVpc(s);
  const vpcSubnets = vpc ? s.subnets.filter((x) => x.config.vpcId === vpc.id) : [];
  // The learner's own security groups; every VPC also has a "default" one made by the platform.
  const vpcGroups = vpc ? s.groups.filter((g) => g.config.vpcId === vpc.id && isOwn(g)) : [];
  const vpcInstances = vpc ? s.instances.filter((i) => i.attributes.vpcId === vpc.id) : [];
  const vpcGateway = vpc ? s.gateways.find((g) => g.config.vpcId === vpc.id) : undefined;
  const looseGateway = s.gateways.find((g) => !g.config.vpcId);
  const instance = vpcInstances[0];
  let reach: ReachabilityResult | null = null;

  // ---------- the beginner path: a public web server ----------
  if (!vpc) {
    push({
      id: "create-vpc",
      level: "beginner",
      title: "Create your own private network (VPC)",
      why: "Everything you build in the cloud lives inside a VPC: a private network that only you control. Think of it as the plot of land you'll build on.",
      steps: [
        "Open the Create VPC form.",
        "Give it a name like main.",
        "Keep the CIDR block 10.0.0.0/16. That's about 65,000 private addresses to share out later.",
        "Click Create VPC.",
      ],
      link: { service: "networking", type: "vpc", mode: "create", prefill: { name: "main", cidrBlock: "10.0.0.0/16" } },
      cli: "aws ec2 create-vpc --cidr-block 10.0.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=main}]'",
    });
  } else if (vpc.state !== "available") {
    push({
      id: "wait-vpc",
      level: "beginner",
      title: `Your VPC ${label(vpc)} is being created`,
      why: "Cloud resources take a moment to become ready. A VPC goes from 'pending' to 'available' in a second or two.",
      steps: ["Wait a moment. This guide will move on by itself."],
      link: { service: "networking", type: "vpc", mode: "detail", id: vpc.id },
      waiting: true,
    });
  } else if (vpcSubnets.length === 0) {
    const cidr = freeSubnetCidr(vpc, s.subnets) ?? "10.0.1.0/24";
    push({
      id: "create-subnet",
      level: "beginner",
      title: "Add a subnet to your VPC",
      why: `Servers don't live directly in a VPC; they live in subnets. A subnet is a slice of ${label(vpc)}'s addresses placed in one availability zone (one data centre).`,
      steps: [
        `Choose VPC ${label(vpc)}.`,
        `Use the CIDR block ${cidr}: 256 addresses carved out of ${vpc.config.cidrBlock}.`,
        `Pick availability zone ${availabilityZones(region)[0]}.`,
        "Tick Auto-assign public IPv4 so servers here can be given internet addresses.",
      ],
      link: {
        service: "networking",
        type: "subnet",
        mode: "create",
        prefill: { name: "public-a", vpcId: vpc.id, cidrBlock: cidr, availabilityZone: availabilityZones(region)[0], mapPublicIpOnLaunch: true },
      },
      cli: `aws ec2 create-subnet --vpc-id ${vpc.id} --cidr-block ${cidr} --availability-zone ${availabilityZones(region)[0]}`,
    });
  } else if (vpcGroups.length === 0 && !s.instances.some((i) => i.attributes.vpcId === vpc.id)) {
    push({
      id: "create-sg",
      level: "beginner",
      title: "Create a security group (a firewall for your server)",
      why: "A security group decides what traffic may reach your server. By default it blocks everything coming in, so you'll open just the port a website needs: HTTP on port 80.",
      steps: [
        "Name it web and describe it, e.g. 'Allow HTTP'.",
        `Choose VPC ${label(vpc)}.`,
        "Add an inbound rule: TCP, ports 80 to 80, from 0.0.0.0/0 (anyone on the internet).",
      ],
      link: {
        service: "networking",
        type: "security-group",
        mode: "create",
        prefill: {
          name: "web",
          description: "Allow HTTP",
          vpcId: vpc.id,
          inboundRules: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0", description: "HTTP from anywhere" }],
        },
      },
      cli: `aws ec2 create-security-group --group-name web --description "Allow HTTP" --vpc-id ${vpc.id}`,
    });
  } else if (!instance) {
    const subnet = vpcSubnets.find((x) => x.config.mapPublicIpOnLaunch) ?? vpcSubnets[0];
    const group = vpcGroups[0];
    push({
      id: "launch-instance",
      level: "beginner",
      title: "Launch your first server",
      why: "An instance is a virtual server. You'll put it in your subnet, protect it with your security group, and give it a public IP so it can be reached from the internet.",
      steps: [
        "Pick a machine image, e.g. Ubuntu Server 24.04 LTS.",
        "Keep instance type t3.micro (small and cheap in the real world).",
        `Choose subnet ${label(subnet)} and security group ${label(group)}.`,
        "Set Auto-assign public IP to Enable.",
      ],
      link: {
        service: "compute",
        type: "instance",
        mode: "create",
        prefill: {
          name: "web-1",
          imageId: "ami-0ubuntu24040lts01",
          instanceType: "t3.micro",
          subnetId: subnet.id,
          securityGroupIds: [group.id],
          associatePublicIp: "enable",
        },
      },
      cli: `aws ec2 run-instances --image-id ami-0ubuntu24040lts01 --instance-type t3.micro --subnet-id ${subnet.id} --security-group-ids ${group.id} --associate-public-ip-address`,
    });
  } else if (instance.state && TRANSITIONAL.includes(instance.state)) {
    push({
      id: "wait-instance",
      level: "beginner",
      title: `${label(instance)} is ${instance.state}`,
      why: "Servers take a few seconds to change state, just like a real machine booting or shutting down.",
      steps: ["Wait a few seconds. This guide refreshes automatically."],
      link: { service: "compute", type: "instance", mode: "detail", id: instance.id },
      waiting: true,
    });
  } else if (instance.state === "stopped") {
    push({
      id: "start-instance",
      level: "beginner",
      title: `Start ${label(instance)}`,
      why: "A stopped server keeps its disk and settings but can't serve anyone. Start it to bring it back.",
      steps: ["Open the instance and click Start."],
      link: { service: "compute", type: "instance", mode: "detail", id: instance.id },
      cli: `aws ec2 start-instances --instance-ids ${instance.id}`,
    });
  } else if (!instance.attributes.publicIp && vpcGateway) {
    // With a gateway in place, an Elastic IP fixes this without relaunching.
    const spare = s.addresses.find((a) => !a.config.instanceId);
    push({
      id: "needs-public-ip",
      level: "beginner",
      title: spare ? `Associate ${spare.attributes.publicIp} with your server` : "Your server has no public IP",
      why: `${label(instance)} only has a private address (${instance.attributes.privateIp}), which works inside the VPC but can't be reached from the internet. An Elastic IP gives it a fixed public address that also survives stop and start.`,
      steps: spare
        ? [`Open Elastic IP ${spare.id}, choose ${instance.id} as the associated instance and save.`]
        : ["Allocate an Elastic IP and choose this instance as its associated instance."],
      link: spare
        ? { service: "compute", type: "elastic-ip", mode: "detail", id: spare.id }
        : { service: "compute", type: "elastic-ip", mode: "create", prefill: { name: "web-ip", instanceId: instance.id } },
      cli: spare
        ? `aws ec2 associate-address --instance-id ${instance.id} --allocation-id ${spare.id}`
        : "aws ec2 allocate-address",
    });
  } else if (!instance.attributes.publicIp) {
    const subnet = vpcSubnets.find((x) => x.id === instance.config.subnetId) ?? vpcSubnets[0];
    push({
      id: "needs-public-ip",
      level: "beginner",
      title: "Your server has no public IP",
      why: `${label(instance)} only has a private address (${instance.attributes.privateIp}), which works inside the VPC but can't be reached from the internet. A public IP is given at launch time.`,
      steps: [
        "Launch a new instance with Auto-assign public IP set to Enable.",
        `Then terminate ${instance.id} if you no longer need it.`,
      ],
      link: {
        service: "compute",
        type: "instance",
        mode: "create",
        prefill: {
          name: "web-2",
          imageId: instance.config.imageId,
          instanceType: instance.config.instanceType,
          subnetId: subnet?.id,
          securityGroupIds: instance.config.securityGroupIds,
          associatePublicIp: "enable",
        },
      },
      cli: `aws ec2 run-instances --image-id ${instance.config.imageId} --subnet-id ${instance.config.subnetId} --security-group-ids ${(instance.config.securityGroupIds as string[]).join(" ")} --associate-public-ip-address`,
    });
  } else {
    reach = await analyzeReachability(engine, accountId, instance.id, reachabilityInput.parse({ protocol: "tcp", port: 80 }));
    const failed = reach.steps.find((st) => st.status === "fail");
    const subnetId = instance.config.subnetId as string;
    const table = s.routeTables.find((t) => ((t.config.subnetIds as string[]) ?? []).includes(subnetId));

    if (failed && (failed.id === "route-table" || failed.id === "route" || failed.id === "gateway")) {
      if (!vpcGateway && !looseGateway) {
        push({
          id: "create-igw",
          level: "beginner",
          title: "Create an internet gateway",
          why: "Your server has a public IP, but your VPC has no door to the internet. An internet gateway is that door.",
          steps: ["Create an internet gateway.", `Attach it to ${label(vpc)} in the same form.`],
          link: { service: "networking", type: "internet-gateway", mode: "create", prefill: { name: "main-igw", vpcId: vpc.id } },
          cli: "aws ec2 create-internet-gateway",
        });
      } else if (!vpcGateway && looseGateway) {
        push({
          id: "attach-igw",
          level: "beginner",
          title: `Attach ${label(looseGateway)} to your VPC`,
          why: "The internet gateway exists but isn't connected to any VPC, so it can't carry traffic yet.",
          steps: [`Open ${looseGateway.id}.`, `Under Edit settings, set Attached VPC to ${label(vpc)} and save.`],
          link: { service: "networking", type: "internet-gateway", mode: "detail", id: looseGateway.id },
          cli: `aws ec2 attach-internet-gateway --internet-gateway-id ${looseGateway.id} --vpc-id ${vpc.id}`,
        });
      } else if (!table) {
        // A table of their own that just isn't associated yet (not the VPC's main table).
        const unassociated = s.routeTables.find((t) => t.config.vpcId === vpc.id && isOwn(t));
        if (unassociated) {
          push({
            id: "associate-rt",
            level: "beginner",
            title: `Associate your subnet with ${label(unassociated)}`,
            why: "A route table only affects the subnets associated with it. Your server's subnet isn't using it yet.",
            steps: [`Open ${unassociated.id}.`, `Under Associated subnets, tick ${subnetId} and save.`],
            link: { service: "networking", type: "route-table", mode: "detail", id: unassociated.id },
            cli: `aws ec2 associate-route-table --route-table-id ${unassociated.id} --subnet-id ${subnetId}`,
          });
        } else {
          push({
            id: "create-rt",
            level: "beginner",
            title: "Create a route table that points to the internet",
            why: "A route table is a signpost: it tells traffic leaving your subnet where to go. You need a sign saying 'everything else (0.0.0.0/0) → internet gateway'.",
            steps: [
              `Choose VPC ${label(vpc)}.`,
              `Add a route: destination 0.0.0.0/0, target ${vpcGateway!.id}.`,
              `Associate subnet ${subnetId}.`,
            ],
            link: {
              service: "networking",
              type: "route-table",
              mode: "create",
              prefill: {
                name: "public-rt",
                vpcId: vpc.id,
                routes: [{ destination: "0.0.0.0/0", gatewayId: vpcGateway!.id }],
                subnetIds: [subnetId],
              },
            },
            cli: `aws ec2 create-route-table --vpc-id ${vpc.id}`,
          });
        }
      } else {
        push({
          id: "add-route",
          level: "beginner",
          title: `Add an internet route to ${label(table)}`,
          why: "Your subnet's route table only knows how to reach addresses inside the VPC. Add a route that sends everything else to the internet gateway.",
          steps: [`Open ${table.id}.`, `Add route: destination 0.0.0.0/0 → ${vpcGateway!.id}, then save.`],
          link: { service: "networking", type: "route-table", mode: "detail", id: table.id },
          cli: `aws ec2 create-route --route-table-id ${table.id} --destination-cidr-block 0.0.0.0/0 --gateway-id ${vpcGateway!.id}`,
        });
      }
    } else if (failed?.id === "security-group") {
      const group = s.groups.find((g) => ((instance.config.securityGroupIds as string[]) ?? []).includes(g.id));
      push({
        id: "allow-http",
        level: "beginner",
        title: "Open port 80 in your security group",
        why: "Everything else is in place, but your firewall still blocks web traffic. Add a rule allowing HTTP on port 80.",
        steps: [`Open ${group ? label(group) : "the security group"}.`, "Add an inbound rule: TCP 80–80 from 0.0.0.0/0, then save."],
        link: group ? { service: "networking", type: "security-group", mode: "detail", id: group.id } : undefined,
        cli: group
          ? `aws ec2 authorize-security-group-ingress --group-id ${group.id} --protocol tcp --port 80 --cidr 0.0.0.0/0`
          : undefined,
      });
    }
  }

  const reachable = reach?.reachable === true;

  // ---------- mistakes worth flagging, whatever the level ----------
  for (const g of s.groups.filter(isOwn)) {
    const open = DATABASE_PORTS.find((db) => inboundRules(g).some((r) => r.cidr === "0.0.0.0/0" && coversPort(r, db.port)));
    if (!open) continue;
    push({
      id: `db-open-${g.id}`,
      level: "intermediate",
      title: `${label(g)} lets the whole internet reach ${open.name}`,
      why: `A rule allows port ${open.port} from 0.0.0.0/0. Databases exposed like this are found by scanners within hours. Only your app servers should reach the database.`,
      steps: [
        `Open ${g.id} and delete the ${open.name} rule from 0.0.0.0/0.`,
        `Add it back with your web servers' security group as the source instead of an address range.`,
      ],
      link: { service: "networking", type: "security-group", mode: "detail", id: g.id },
      cli: `aws ec2 revoke-security-group-ingress --group-id ${g.id} --protocol tcp --port ${open.port} --cidr 0.0.0.0/0`,
    });
  }
  for (const nat of s.natGateways) {
    const subnet = s.subnets.find((x) => x.id === nat.config.subnetId);
    if (!subnet || isPublicSubnet(s, subnet)) continue;
    push({
      id: `nat-private-${nat.id}`,
      level: "intermediate",
      title: `${label(nat)} can't reach the internet`,
      why: `It's in ${label(subnet)}, which has no route to an internet gateway. A NAT gateway forwards traffic to the internet gateway, so it has to sit in a public subnet; otherwise private servers behind it get nowhere.`,
      steps: ["Create a new NAT gateway in a public subnet.", "Point the private route table's 0.0.0.0/0 route at the new one.", `Delete ${nat.id}.`],
      link: { service: "networking", type: "nat-gateway", mode: "create" },
    });
  }
  for (const i of s.instances) {
    const subnet = s.subnets.find((x) => x.id === i.config.subnetId);
    if (!i.attributes.publicIp || !subnet || !routesToNat(s, subnet)) continue;
    push({
      id: `private-public-ip-${i.id}`,
      level: "intermediate",
      title: `${label(i)} has a public IP in a private subnet`,
      why: "Its subnet sends traffic through a NAT gateway, so the public IP is useless today. Worse, if someone later routes that subnet to an internet gateway, this server is suddenly exposed. Private servers shouldn't have one.",
      steps: ["Launch a replacement with Auto-assign public IP set to Disable.", `Then terminate ${i.id}.`],
      link: { service: "compute", type: "instance", mode: "detail", id: i.id },
    });
  }
  for (const eip of s.addresses) {
    if (eip.config.instanceId || eip.attributes.natGatewayId) continue;
    push({
      id: `unused-eip-${eip.id}`,
      level: "intermediate",
      title: `Use or release ${eip.attributes.publicIp}`,
      why: "This Elastic IP isn't attached to anything. In a real account an idle Elastic IP is billed every hour, so teams release the ones they don't need.",
      steps: ["Associate it with an instance or a NAT gateway, or delete it to release it."],
      link: { service: "compute", type: "elastic-ip", mode: "detail", id: eip.id },
      cli: `aws ec2 release-address --allocation-id ${eip.id}`,
    });
  }

  // ---------- storage ----------
  if (s.buckets.length === 0) {
    const name = bucketName(accountId);
    push({
      id: "create-bucket",
      level: "beginner",
      title: "Create a storage bucket",
      why: "Buckets store files: images, backups, website assets. Bucket names are shared by everyone on the platform, so yours has to be unique.",
      steps: ["Open the Create bucket form.", `Use a unique name such as ${name}.`, "Keep Block all public access ticked."],
      link: { service: "storage", type: "bucket", mode: "create", prefill: { name, versioning: "Disabled", blockPublicAccess: true } },
      cli: `aws s3 mb s3://${name}`,
    });
  }

  // ---------- intermediate: tidy and harden ----------
  if (reachable && vpc && instance) {
    push({
      id: "check-reachability",
      level: "beginner",
      title: "See your server's reachability for yourself",
      why: "Your server is reachable over HTTP. Run the reachability check to see every link in the chain that makes it work.",
      steps: [`Open ${label(instance)}.`, "In Reachability check, click HTTP, then try SSH and Ping."],
      link: { service: "compute", type: "instance", mode: "detail", id: instance.id },
    });

    const sshOpen = vpcGroups.find((g) =>
      ((g.config.inboundRules as SgRule[]) ?? []).some(
        (r) => r.cidr === "0.0.0.0/0" && (r.protocol === "all" || (r.protocol === "tcp" && (r.fromPort ?? 0) <= 22 && (r.toPort ?? 0) >= 22)),
      ),
    );
    if (sshOpen) {
      push({
        id: "restrict-ssh",
        level: "intermediate",
        title: "Lock SSH down to your own IP",
        why: `${label(sshOpen)} lets anyone on the internet try to log in over SSH (port 22). Real servers get attacked within minutes like this. Only allow your own address.`,
        steps: [`Open ${sshOpen.id}.`, "Change the SSH rule's source from 0.0.0.0/0 to your IP, e.g. 198.51.100.7/32.", "Save, then rerun the reachability check for SSH from 0.0.0.0/0. It should now fail."],
        link: { service: "networking", type: "security-group", mode: "detail", id: sshOpen.id },
      });
    }

    if (vpcSubnets.length === 1) {
      const cidr = freeSubnetCidr(vpc, s.subnets);
      const az = availabilityZones(region)[1];
      if (cidr) {
        push({
          id: "private-subnet",
          level: "intermediate",
          title: "Add a private subnet",
          why: "Databases and internal services shouldn't be reachable from the internet. A private subnet has no route to the internet gateway, so nothing outside can get in.",
          steps: [`Create a subnet in ${label(vpc)} with CIDR ${cidr} in ${az}.`, "Leave Auto-assign public IPv4 off.", "Don't associate it with your public route table."],
          link: { service: "networking", type: "subnet", mode: "create", prefill: { name: "private-b", vpcId: vpc.id, cidrBlock: cidr, availabilityZone: az, mapPublicIpOnLaunch: false } },
          cli: `aws ec2 create-subnet --vpc-id ${vpc.id} --cidr-block ${cidr} --availability-zone ${az}`,
        });
      }
    }

    push({
      id: "resize",
      level: "intermediate",
      title: "Resize your server",
      why: "Need more power? You change an instance's type, but only while it's stopped. This is how real teams scale up a single server.",
      steps: [`Stop ${instance.id}.`, "When it shows stopped, change Instance type to t3.small and save.", "Start it again."],
      link: { service: "compute", type: "instance", mode: "detail", id: instance.id },
      cli: `aws ec2 stop-instances --instance-ids ${instance.id}`,
    });

    push({
      id: "use-cli",
      level: "intermediate",
      title: "Do it from the terminal",
      why: "Most real cloud work happens in the CLI and in scripts. Everything you clicked has a command.",
      steps: ["Open the Terminal.", "Run aws ec2 describe-instances to see your server as the API sees it."],
      cli: "aws ec2 describe-instances",
    });
  }

  for (const b of s.buckets) {
    if (!b.config.blockPublicAccess) {
      push({
        id: `block-public-${b.id}`,
        level: "intermediate",
        title: `Block public access on ${b.id}`,
        why: "Public buckets are the most common cause of cloud data leaks. Unless you're hosting a public website, keep them blocked.",
        steps: [`Open ${b.id}.`, "Tick Block all public access and save."],
        link: { service: "storage", type: "bucket", mode: "detail", id: b.id },
      });
    }
    if (b.config.versioning === "Disabled") {
      push({
        id: `versioning-${b.id}`,
        level: "intermediate",
        title: `Turn on versioning for ${b.id}`,
        why: "Versioning keeps every old copy of a file, so an accidental overwrite or delete can be undone.",
        steps: [`Open ${b.id}.`, "Set Versioning to Enabled and save. Note: it can be suspended later, never disabled."],
        link: { service: "storage", type: "bucket", mode: "detail", id: b.id },
        cli: `aws s3api put-bucket-versioning --bucket ${b.id} --versioning-configuration Status=Enabled`,
      });
    }
  }

  // ---------- advanced ----------
  if (reachable && vpc && instance) {
    const azs = new Set(vpcInstances.map((i) => i.attributes.availabilityZone));
    if (azs.size < 2) {
      push({
        id: "multi-az",
        level: "advanced",
        title: "Survive a data-centre outage (multi-AZ)",
        why: "All your servers are in one availability zone. If that data centre has a problem, your site goes down. Production systems run copies in at least two zones.",
        steps: [
          "Create a second public subnet in another availability zone and associate it with your public route table.",
          "Launch a second web server there with the same security group.",
          "Check both are reachable.",
        ],
        link: { service: "networking", type: "subnet", mode: "create", prefill: { vpcId: vpc.id, availabilityZone: availabilityZones(region)[1], mapPublicIpOnLaunch: true } },
      });
    }
    push({
      id: "break-it",
      level: "advanced",
      title: "Break it on purpose, then fix it",
      why: "The fastest way to understand networking is to break one link and see what happens. This is how you learn to troubleshoot.",
      steps: [
        "Remove the 0.0.0.0/0 route from your public route table.",
        "Run the reachability check: see exactly which link fails.",
        "Put the route back and confirm it's reachable again.",
      ],
      link: routeTableLink(s, instance),
    });
  }

  // Always have something to suggest.
  if (out.length === 0) {
    push({
      id: "explore",
      level: "advanced",
      title: "You've done everything this guide knows about",
      why: "Your setup covers networking, compute and storage. More services and guided tutorials are on the way.",
      steps: ["Try rebuilding the whole setup from the Terminal, without the console."],
      cli: "help",
    });
  }

  const ownVpcIds = new Set(s.vpcs.filter(isOwn).map((v) => v.id));
  const milestones: Milestone[] = [
    { id: "vpc", label: "Private network (VPC)", done: s.vpcs.some((v) => isOwn(v) && v.state === "available") },
    { id: "subnet", label: "Subnet", done: s.subnets.some((x) => ownVpcIds.has(x.config.vpcId as string)) },
    { id: "firewall", label: "Security group", done: s.groups.some(isOwn) },
    { id: "server", label: "Server running", done: s.instances.some((i) => i.state === "running") },
    { id: "internet", label: "Internet gateway & route", done: !!reach && !["route-table", "route", "gateway"].some((id) => reach!.steps.find((x) => x.id === id)?.status === "fail") },
    { id: "reachable", label: "Reachable over HTTP", done: reachable },
    { id: "storage", label: "Storage bucket", done: s.buckets.length > 0 },
  ];

  const level: Level = !reachable || s.buckets.length === 0 ? "beginner" : out[0].level === "advanced" ? "advanced" : "intermediate";
  const [next, ...rest] = out;
  return { region, level, next, more: rest.slice(0, 3), milestones };
}

/** Link to the route table the instance's subnet uses, if any. */
function routeTableLink(s: Snapshot, instance: Resource) {
  const subnet = s.subnets.find((x) => x.id === instance.config.subnetId);
  const t = subnet ? effectiveRouteTable(s, subnet) : undefined;
  return t ? { service: "networking", type: "route-table", mode: "detail" as const, id: t.id } : undefined;
}
