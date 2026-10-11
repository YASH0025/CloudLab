import { analyzeDbConnection } from "@/engine/analysis/dbconnect";
import { targetHealth } from "@/engine/analysis/health";
import { analyzeReachability } from "@/engine/analysis/reachability";
import { REGIONS } from "@/engine/catalog";
import type { Engine } from "@/engine/engine";
import { check, resolvePrincipal } from "@/engine/iam/authorize";
import { accountNumber } from "@/engine/ids";
import { addPermission, allowsService } from "@/engine/lambda/invoke";
import type { Resource } from "@/engine/types";
import type { Level } from "./types";

/**
 * Challenges: a broken setup and a symptom, and no instructions. The learner
 * investigates with the console's own tools (reachability checks, the
 * terminal, IAM's permission checker…) and fixes it; the challenge passes when
 * the setup works. Each one is built in a separate challenge account, so the
 * learner's own lab is never touched.
 */

export const CHALLENGE_REGION = "us-east-1";

export interface ChallengeInfo {
  id: string;
  title: string;
  level: Level;
  /** Rough time for someone at that level. */
  minutes: number;
  /** One line for the list. */
  summary: string;
}

export interface ChallengeView extends ChallengeInfo {
  region: string;
  /** The problem, as someone would report it. */
  story: string;
  /** What "fixed" means, including any rules (e.g. don't open other ports). */
  goal: string;
  /** Facts about this run: addresses, names, commands people tried. */
  facts: string[];
  /** Where to start looking, without saying what's wrong. */
  tools: string[];
  /** The hints revealed so far. */
  hints: string[];
  hintCount: number;
  solved: boolean;
  /** Why it broke and how it shows up in real life: only once solved. */
  explanation?: string;
  /** What's still wrong, in general terms, while unsolved. */
  status?: string;
}

interface ChallengeDef extends ChallengeInfo {
  story: string;
  goal: string;
  tools: string[];
  hints: [string, string, string];
  explanation: string;
  setup(b: Builder): Promise<void>;
  facts(engine: Engine, accountId: string): Promise<string[]>;
  check(engine: Engine, accountId: string): Promise<{ solved: boolean; status?: string }>;
}

// ---------- building blocks ----------

class Builder {
  constructor(
    readonly engine: Engine,
    readonly accountId: string,
  ) {}

  make(service: string, type: string, config: Record<string, unknown>, region = CHALLENGE_REGION) {
    return this.engine.create(this.accountId, { service, type, region, config }, { settled: true });
  }

  /** A VPC with public subnets (routed to an internet gateway) and optional private ones. */
  async network(opts: { publicAzs: string[]; privateAzs?: string[] }) {
    const vpc = await this.make("networking", "vpc", { name: "shop-vpc", cidrBlock: "10.0.0.0/16" });
    const igw = await this.make("networking", "internet-gateway", { name: "shop-igw", vpcId: vpc.id });
    const pub = [];
    for (const [i, az] of opts.publicAzs.entries()) {
      pub.push(
        await this.make("networking", "subnet", {
          name: `public-${az.slice(-1)}`,
          vpcId: vpc.id,
          cidrBlock: `10.0.${1 + i}.0/24`,
          availabilityZone: az,
          mapPublicIpOnLaunch: true,
        }),
      );
    }
    const priv = [];
    for (const [i, az] of (opts.privateAzs ?? []).entries()) {
      priv.push(await this.make("networking", "subnet", { name: `private-${az.slice(-1)}`, vpcId: vpc.id, cidrBlock: `10.0.${11 + i}.0/24`, availabilityZone: az }));
    }
    await this.make("networking", "route-table", {
      name: "public-rt",
      vpcId: vpc.id,
      routes: [{ destination: "0.0.0.0/0", gatewayId: igw.id }],
      subnetIds: pub.map((s) => s.id),
    });
    return { vpc, igw, pub, priv };
  }

  group(name: string, vpcId: string, inboundRules: Record<string, unknown>[]) {
    return this.make("networking", "security-group", {
      name,
      description: name,
      vpcId,
      inboundRules,
      outboundRules: [{ protocol: "all", cidr: "0.0.0.0/0" }],
    });
  }

  instance(name: string, subnetId: string, groupIds: string[]) {
    return this.make("compute", "instance", { name, imageId: "ami-0lab2023linux0001", instanceType: "t3.micro", subnetId, securityGroupIds: groupIds });
  }
}

const list = (engine: Engine, accountId: string, service: string, type: string, region = CHALLENGE_REGION) => engine.list(accountId, { service, type, region });
const named = async (engine: Engine, accountId: string, service: string, type: string, name: string) =>
  (await list(engine, accountId, service, type)).find((r) => r.name === name && r.state !== "terminated");
const running = async (engine: Engine, accountId: string) => (await list(engine, accountId, "compute", "instance")).filter((i) => i.state === "running");

interface Rule {
  protocol: string;
  fromPort?: number;
  toPort?: number;
  cidr?: string;
  sourceGroupId?: string;
}
const rulesOf = (g: Resource) => (g.config.inboundRules as Rule[] | undefined) ?? [];
const wideOpen = (r: Rule) => r.cidr === "0.0.0.0/0" && (r.protocol === "all" || (r.fromPort ?? 0) <= 0 || (r.toPort ?? 0) - (r.fromPort ?? 0) > 1000);

async function can(engine: Engine, accountId: string, user: string, action: string, resource: string): Promise<boolean> {
  try {
    const p = await resolvePrincipal(engine, accountId, { kind: "user", name: user });
    return check(p, action, resource).decision === "allowed";
  } catch {
    return false;
  }
}

/** A short random suffix, for names that must be unique across every account (S3 buckets). */
const suffix = () => Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("");

// ---------- the challenges ----------

const SITE_DOWN: ChallengeDef = {
  id: "site-down",
  title: "The shop is down",
  level: "beginner",
  minutes: 5,
  summary: "Customers get a timeout. The server is running, and the site works from the office.",
  story:
    "Support ticket, 9:12 AM: “Our online shop won't load for any customer. The browser spins and then says the site took too long to respond.” The developer on call checked: the server shop-web is running, the app is up, and the site opens fine from the office network.",
  goal: "Customers anywhere on the internet can open the shop on port 80. Don't open any other ports to the whole internet.",
  tools: ["The instance's Reachability panel (HTTP, from the internet)", "curl http://<public IP> in the terminal", "The instance's security groups"],
  hints: [
    "A timeout (rather than an error page) means the request is dropped on the way, before any app sees it. What stands between the internet and an instance and silently drops traffic?",
    "Open shop-web's security group, web-sg, and read its inbound rules. Who exactly is allowed to reach port 80?",
    "The HTTP rule only allows 10.0.0.0/16, the VPC itself. Edit web-sg: change that rule's source to 0.0.0.0/0 (anywhere), or add a rule TCP 80 from 0.0.0.0/0.",
  ],
  explanation:
    "Security groups deny everything that no rule allows, and they drop it silently, which is why customers saw a timeout instead of an error. The rule for port 80 only allowed 10.0.0.0/16: the VPC's own addresses (the office reaches the server over a VPN, so it looked fine there). Someone “tightened” the group thinking 10.0.0.0/16 meant “our network”. In real life: when a site times out for everyone but works internally, check the security group's sources first.",
  async setup(b) {
    const { vpc, pub } = await b.network({ publicAzs: ["us-east-1a"] });
    const sg = await b.group("web-sg", vpc.id, [
      { protocol: "tcp", fromPort: 80, toPort: 80, cidr: "10.0.0.0/16", description: "HTTP" },
      { protocol: "tcp", fromPort: 22, toPort: 22, cidr: "198.51.100.0/24", description: "SSH from the office" },
    ]);
    await b.instance("shop-web", pub[0].id, [sg.id]);
  },
  async facts(engine, accountId) {
    const web = await named(engine, accountId, "compute", "instance", "shop-web");
    const ip = web?.attributes.publicIp;
    return [ip ? `Shop address: http://${String(ip)}` : "Shop server: shop-web", "Office network: 198.51.100.0/24"];
  },
  async check(engine, accountId) {
    const servers = await running(engine, accountId);
    if (servers.length === 0) return { solved: false, status: "No server is running." };
    for (const s of servers) {
      const r = await analyzeReachability(engine, accountId, s.id, { protocol: "tcp", port: 80, source: "0.0.0.0/0" });
      if (!r.reachable) continue;
      const groups = await Promise.all(((s.config.securityGroupIds as string[]) ?? []).map((id) => engine.get(accountId, id).catch(() => null)));
      if (groups.some((g) => g && rulesOf(g).some(wideOpen))) return { solved: false, status: "The site loads, but the server is now open on (almost) every port to the whole internet. Open only port 80." };
      return { solved: true };
    }
    return { solved: false, status: "Customers still can't reach the shop on port 80." };
  },
};

const NO_UPDATES: ChallengeDef = {
  id: "no-updates",
  title: "The server can't download updates",
  level: "intermediate",
  minutes: 8,
  summary: "A private server hangs on every download. The network team says “it has a route to the internet”.",
  story:
    "Message from a developer: “On shop-app (the server in the private subnet), sudo dnf update just hangs and then times out. Same for pip install. The network team says the subnet has a route to the internet, so it must be the server.” shop-app must stay private: no public IP.",
  goal: "shop-app can reach the internet (HTTPS, port 443) for downloads, while staying private: no public IP, and nothing on the internet can reach it.",
  tools: ["shop-app's Reachability panel (Outbound, TCP 443)", "The route table of shop-app's subnet", "VPC → NAT gateways"],
  hints: [
    "The subnet does have a 0.0.0.0/0 route. Look at where it points, and think about what that kind of target needs from the instance.",
    "An internet gateway only works for instances with a public IP. Private servers reach out through something else, and there is one already in the public subnet.",
    "Edit the route table private-rt: change the 0.0.0.0/0 route's target from the internet gateway to the NAT gateway shop-nat.",
  ],
  explanation:
    "An internet gateway translates between an instance's public IP and the internet, so an instance without one can't use it: its packets leave with a private address and the replies have nowhere to go. A NAT gateway sits in a public subnet with its own Elastic IP and sends traffic out on behalf of private instances, while nothing on the internet can start a connection to them. The private route table pointed at the internet gateway: “a route to the internet” on paper, useless for this server.",
  async setup(b) {
    const { vpc, igw, pub, priv } = await b.network({ publicAzs: ["us-east-1a"], privateAzs: ["us-east-1a"] });
    const eip = await b.make("compute", "elastic-ip", { name: "shop-nat-ip" });
    await b.make("networking", "nat-gateway", { name: "shop-nat", subnetId: pub[0].id, allocationId: eip.id });
    await b.make("networking", "route-table", { name: "private-rt", vpcId: vpc.id, routes: [{ destination: "0.0.0.0/0", gatewayId: igw.id }], subnetIds: [priv[0].id] });
    const sg = await b.group("app-sg", vpc.id, [{ protocol: "tcp", fromPort: 8080, toPort: 8080, cidr: "10.0.0.0/16", description: "App, from inside the VPC" }]);
    await b.instance("shop-app", priv[0].id, [sg.id]);
  },
  async facts(engine, accountId) {
    const app = await named(engine, accountId, "compute", "instance", "shop-app");
    return [`Server: shop-app${app ? ` (${String(app.attributes.privateIp)}, no public IP)` : ""}`, "Failing: sudo dnf update → Connection timed out"];
  },
  async check(engine, accountId) {
    const app = await named(engine, accountId, "compute", "instance", "shop-app");
    if (!app || app.state !== "running") return { solved: false, status: "shop-app isn't running." };
    if (app.attributes.publicIp) return { solved: false, status: "shop-app has a public IP now. It must stay private: take that away and fix the route instead." };
    const r = await analyzeReachability(engine, accountId, app.id, { direction: "outbound", protocol: "tcp", port: 443, source: "0.0.0.0/0" });
    return r.reachable ? { solved: true } : { solved: false, status: "Downloads from shop-app still time out." };
  },
};

const ACCESS_DENIED: ChallengeDef = {
  id: "access-denied",
  title: "Access Denied on the reports bucket",
  level: "intermediate",
  minutes: 8,
  summary: "An analyst can list the bucket but not download a file, though the policy “allows s3:GetObject”.",
  story:
    "Ticket from dev (an analyst): “I can see the files in the reports bucket, but downloading q3.csv fails with AccessDenied.” Their group, analysts, has the customer policy reports-read, which clearly allows s3:GetObject on the bucket. IT asks you to fix it, without giving dev any more access than reading reports.",
  goal: "dev can download objects from the reports bucket, and still can't upload, delete or do anything else.",
  tools: ["IAM → Policies → reports-read (its JSON)", "The permission checker on the user dev", "Switch to the identity user/dev (top bar) and try it in the terminal"],
  hints: [
    "Use the permission checker on dev, or switch to user/dev and try aws s3 cp. Compare what's being asked for with what the policy names.",
    "s3:GetObject acts on objects, not on the bucket. An object's ARN is arn:aws:s3:::<bucket>/<key>. Which ARN does the policy's GetObject statement use?",
    "Edit the policy reports-read: in the GetObject statement, change the Resource from arn:aws:s3:::<bucket> to arn:aws:s3:::<bucket>/* (keep ListBucket on the bucket itself).",
  ],
  explanation:
    "IAM matches the action and the resource. s3:ListBucket acts on the bucket (arn:aws:s3:::reports-…), but s3:GetObject acts on each object (arn:aws:s3:::reports-…/q3.csv). The policy gave GetObject on the bucket's ARN, which matches no object, so every download was denied while listing worked. This is one of the most common IAM mistakes; the fix is the /* at the end, and nothing broader than that.",
  async setup(b) {
    const bucket = `reports-${accountNumber(b.accountId).slice(-4)}-${suffix()}`;
    await b.make("storage", "bucket", { name: bucket });
    await b.engine.objects.put(b.accountId, bucket, "q3.csv", Buffer.from("region,revenue\nnorth,120000\nsouth,98000\n"), "text/csv");
    await b.engine.objects.put(b.accountId, bucket, "q2.csv", Buffer.from("region,revenue\nnorth,110000\nsouth,91000\n"), "text/csv");
    const doc = {
      Version: "2012-10-17",
      Statement: [
        { Sid: "ListReports", Effect: "Allow", Action: "s3:ListBucket", Resource: `arn:aws:s3:::${bucket}` },
        { Sid: "ReadReports", Effect: "Allow", Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}` },
      ],
    };
    const policy = await b.make("iam", "policy", { name: "reports-read", description: "Read the reports bucket", document: JSON.stringify(doc, null, 2) }, "global");
    await b.make("iam", "group", { name: "analysts", policyArns: [String(policy.attributes.arn)] }, "global");
    await b.make("iam", "user", { name: "dev", groups: ["analysts"] }, "global");
  },
  async facts(engine, accountId) {
    const bucket = (await list(engine, accountId, "storage", "bucket"))[0];
    return [bucket ? `Bucket: s3://${bucket.id}` : "Bucket: reports-…", `Failing: aws s3 cp s3://${bucket?.id ?? "<bucket>"}/q3.csv . → AccessDenied`];
  },
  async check(engine, accountId) {
    const bucket = (await list(engine, accountId, "storage", "bucket"))[0];
    if (!bucket) return { solved: false, status: "The reports bucket is gone." };
    const obj = `arn:aws:s3:::${bucket.id}/q3.csv`;
    if (!(await can(engine, accountId, "dev", "s3:GetObject", obj))) return { solved: false, status: "dev still can't download q3.csv." };
    const extra = [
      ["s3:PutObject", obj],
      ["s3:DeleteObject", obj],
      ["s3:DeleteBucket", `arn:aws:s3:::${bucket.id}`],
      ["iam:CreateUser", "*"],
      ["ec2:RunInstances", "*"],
    ];
    for (const [action, resource] of extra) {
      if (await can(engine, accountId, "dev", action, resource)) return { solved: false, status: `dev can download now, but also has ${action}. Give dev only what reading reports needs.` };
    }
    return { solved: true };
  },
};

const DB_CONNECT: ChallengeDef = {
  id: "db-connect",
  title: "The app can't reach its database",
  level: "intermediate",
  minutes: 8,
  summary: "Connection timed out from the web server. The database is up, and its firewall “allows the web servers”.",
  story:
    "Alert from the shop app on shop-web: “could not connect to server: Connection timed out. Is the server running on host shop-db… and accepting TCP/IP connections on port 5432?” RDS shows shop-db as available. The database's security group, db-sg, has a rule allowing traffic from web-sg, so the team is puzzled.",
  goal: "shop-web can connect to the PostgreSQL database shop-db. The database stays private: nothing on the internet may reach it.",
  tools: ["shop-db's Connectivity panel (test from shop-web)", "The security group db-sg", "shop-db's endpoint and port"],
  hints: [
    "Run the database's connection test from shop-web and see which link fails. Then check every part of the rule that should allow it, not just the source.",
    "The rule's source (web-sg) is right. Look at the port: which port does PostgreSQL listen on, and which port does the rule open?",
    "Edit db-sg: change the rule from TCP 3306 (MySQL's port) to TCP 5432 (PostgreSQL), keeping web-sg as the source.",
  ],
  explanation:
    "The rule was copied from an older MySQL setup and still opened port 3306, while PostgreSQL listens on 5432. Security groups match protocol, port and source together, so the connection on 5432 matched nothing and was dropped: a timeout, not “connection refused”. Chaining by security group (source = web-sg) was the right idea, and it's better than IP addresses because it keeps working when servers are replaced.",
  async setup(b) {
    const { vpc, pub, priv } = await b.network({ publicAzs: ["us-east-1a"], privateAzs: ["us-east-1a", "us-east-1b"] });
    const web = await b.group("web-sg", vpc.id, [{ protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0", description: "HTTP" }]);
    const db = await b.group("db-sg", vpc.id, [{ protocol: "tcp", fromPort: 3306, toPort: 3306, sourceGroupId: web.id, description: "Database, from the web servers" }]);
    await b.make("rds", "db-subnet-group", { name: "shop-db-subnets", description: "Private subnets for the shop database", subnetIds: priv.map((s) => s.id) });
    await b.make("rds", "db-instance", {
      name: "shop-db",
      engine: "postgres",
      dbInstanceClass: "db.t3.micro",
      allocatedStorage: 20,
      masterUsername: "shop",
      masterUserPassword: "challenge-password-1",
      dbName: "shop",
      dbSubnetGroupName: "shop-db-subnets",
      vpcSecurityGroupIds: [db.id],
      publiclyAccessible: false,
      multiAZ: false,
      backupRetentionPeriod: 7,
    });
    await b.instance("shop-web", pub[0].id, [web.id]);
  },
  async facts(engine, accountId) {
    const db = await named(engine, accountId, "rds", "db-instance", "shop-db");
    return [db ? `Database endpoint: ${String(db.attributes.endpoint ?? "shop-db")}:${String(db.attributes.port ?? 5432)}` : "Database: shop-db", "Engine: PostgreSQL"];
  },
  async check(engine, accountId) {
    const db = await named(engine, accountId, "rds", "db-instance", "shop-db");
    const web = await named(engine, accountId, "compute", "instance", "shop-web");
    if (!db || !web) return { solved: false, status: "shop-db or shop-web is missing." };
    if (db.config.publiclyAccessible) return { solved: false, status: "shop-db is publicly accessible now. Keep it private." };
    const groups = await Promise.all(((db.config.vpcSecurityGroupIds as string[]) ?? []).map((id) => engine.get(accountId, id).catch(() => null)));
    if (groups.some((g) => g && rulesOf(g).some((r) => r.cidr === "0.0.0.0/0"))) return { solved: false, status: "The database's security group allows the whole internet. Only the web servers should get in." };
    const r = await analyzeDbConnection(engine, accountId, db, { from: web.id });
    return r.reachable ? { solved: true } : { solved: false, status: "shop-web still can't connect to shop-db." };
  },
};

const ORDERS_CODE = `export const handler = async () => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify([{ id: 1, item: "book" }, { id: 2, item: "pen" }]),
});
`;

const API_500: ChallengeDef = {
  id: "api-500",
  title: "Every API call returns 500",
  level: "intermediate",
  minutes: 8,
  summary: "It worked yesterday. Then the API was recreated, and now GET /orders always fails.",
  story:
    "The mobile team: “Since this morning, every call to GET /orders returns 500 Internal Server Error.” Yesterday someone deleted the old API by mistake and recreated it as shop-api, with the same route and the same Lambda function, orders. Testing orders from the Lambda console works perfectly.",
  goal: "GET /orders on shop-api returns 200 with the orders, and only API Gateway (for this API) may invoke the function.",
  tools: ["shop-api's Try it panel (and the Why line under a failure)", "The function orders → Resource-based policy", "aws lambda get-policy --function-name orders"],
  hints: [
    "The function works and the route exists, so look at the link between them: is API Gateway allowed to call the function?",
    "There is a permission statement for API Gateway. Read its condition: which API's ARN does it name? Compare it with shop-api's ID.",
    "The statement only allows the old, deleted API. On the function orders, add a permission for shop-api (Resource-based policy → choose shop-api → Add permission), and remove the stale statement.",
  ],
  explanation:
    "A Lambda function's resource-based policy says who may invoke it. The statement for API Gateway had a condition, AWS:SourceArn = arn:aws:execute-api:…:<old-api-id>/*, so only the old API could call it. The new API got a new ID, matched nothing, and every request failed with 500 (API Gateway reports a failed invocation that way). Scoping the permission to one API is good practice; it just has to be updated whenever the API is recreated.",
  async setup(b) {
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
    await b.make("iam", "role", { name: "orders-role", trustPolicy: trust, policyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"] }, "global");
    const fn = await b.make("lambda", "function", { name: "orders", runtime: "nodejs22.x", handler: "index.handler", role: "orders-role", files: { "index.mjs": ORDERS_CODE } });
    const api = await b.make("apigateway", "api", { name: "shop-api", protocolType: "HTTP" });
    await b.make("apigateway", "stage", { apiId: api.id, name: "$default" });
    const integration = await b.make("apigateway", "integration", { apiId: api.id, functionName: "orders" });
    await b.make("apigateway", "route", { apiId: api.id, routeKey: "GET /orders", integrationId: integration.id });
    const oldApi = "k3j9x0q2ab";
    await addPermission(b.engine, b.accountId, fn, {
      statementId: "apigateway-orders",
      action: "lambda:InvokeFunction",
      principal: "apigateway.amazonaws.com",
      sourceArn: `arn:aws:execute-api:${CHALLENGE_REGION}:${accountNumber(b.accountId)}:${oldApi}/*/*/orders`,
    });
  },
  async facts(engine, accountId) {
    const api = await named(engine, accountId, "apigateway", "api", "shop-api");
    return [api ? `API: ${String(api.attributes.apiEndpoint)}/orders` : "API: shop-api", "Old API (deleted): k3j9x0q2ab"];
  },
  async check(engine, accountId) {
    const api = await named(engine, accountId, "apigateway", "api", "shop-api");
    const fn = await named(engine, accountId, "lambda", "function", "orders");
    if (!api || !fn) return { solved: false, status: "shop-api or the function orders is missing." };
    const routes = await list(engine, accountId, "apigateway", "route");
    if (!routes.some((r) => r.config.apiId === api.id && r.config.routeKey === "GET /orders")) return { solved: false, status: "shop-api has no GET /orders route any more." };
    const source = `arn:aws:execute-api:${CHALLENGE_REGION}:${accountNumber(accountId)}:${api.id}/$default/GET/orders`;
    if (!allowsService(fn, "apigateway.amazonaws.com", source)) return { solved: false, status: "Calls to GET /orders still fail." };
    // Not "anyone may invoke it": the statement must stay tied to this API.
    if (allowsService(fn, "apigateway.amazonaws.com", `arn:aws:execute-api:${CHALLENGE_REGION}:${accountNumber(accountId)}:zzzzzzzzzz/$default/GET/orders`)) {
      return { solved: false, status: "It works, but now any API Gateway API may invoke orders. Scope the permission to shop-api." };
    }
    return { solved: true };
  },
};

const UNHEALTHY: ChallengeDef = {
  id: "unhealthy-targets",
  title: "Every server behind the load balancer is unhealthy",
  level: "advanced",
  minutes: 12,
  summary: "Customers get 502s. Both servers work when tested directly, and their firewall “uses security group chaining”.",
  story:
    "Launch day: the new load balancer shop-alb returns 502 Bad Gateway for everyone, and the target group web-tg shows both servers as unhealthy (Request timed out). Each server answers fine when the team tests it from inside. The servers' security group, web-sg, only allows HTTP “from the security group”, which is what the docs recommend.",
  goal: "Both servers in web-tg are healthy and the load balancer serves the site. The servers must not accept HTTP from the internet directly: only through the load balancer.",
  tools: ["web-tg's Targets panel (health and reason)", "shop-alb's Send test traffic", "The security groups web-sg and alb-sg"],
  hints: [
    "Health checks come from the load balancer itself. For a target to be healthy, the load balancer must be able to reach it on the target group's port.",
    "web-sg allows port 80 from a security group. Which one? Health checks come from the load balancer's nodes, which use alb-sg.",
    "Edit web-sg: change the HTTP rule's source from web-sg (itself) to alb-sg. Then wait about 10 seconds for the next health checks.",
  ],
  explanation:
    "“Allow from a security group” means: from network interfaces that have that group. web-sg allowed port 80 from web-sg, i.e. from the web servers themselves, which is why tests from one server to another worked. The load balancer's nodes have alb-sg, so its health checks were dropped, timed out, and every target went unhealthy; with no healthy targets the ALB returns 502/504. The right chain is alb-sg → web-sg: the internet reaches only the load balancer, and only the load balancer reaches the servers.",
  async setup(b) {
    const { vpc, pub } = await b.network({ publicAzs: ["us-east-1a", "us-east-1b"] });
    const alb = await b.group("alb-sg", vpc.id, [{ protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0", description: "HTTP from anywhere" }]);
    const web = await b.group("web-sg", vpc.id, []);
    await b.engine.update(b.accountId, web.id, {
      inboundRules: [
        { protocol: "tcp", fromPort: 80, toPort: 80, sourceGroupId: web.id, description: "HTTP from the security group" },
        { protocol: "tcp", fromPort: 22, toPort: 22, cidr: "198.51.100.0/24", description: "SSH from the office" },
      ],
    });
    const one = await b.instance("web-1", pub[0].id, [web.id]);
    const two = await b.instance("web-2", pub[1].id, [web.id]);
    const tg = await b.make("loadbalancing", "target-group", { name: "web-tg", protocol: "HTTP", port: 80, vpcId: vpc.id, healthCheckPath: "/", targets: [one.id, two.id] });
    await b.make("loadbalancing", "load-balancer", {
      name: "shop-alb",
      scheme: "internet-facing",
      subnetIds: pub.map((s) => s.id),
      securityGroupIds: [alb.id],
      listeners: [{ protocol: "HTTP", port: 80, targetGroupId: tg.id }],
    });
  },
  async facts(engine, accountId) {
    const lb = await named(engine, accountId, "loadbalancing", "load-balancer", "shop-alb");
    return [lb ? `Site: http://${String(lb.attributes.dnsName)}` : "Load balancer: shop-alb", "Servers: web-1 (us-east-1a), web-2 (us-east-1b)"];
  },
  async check(engine, accountId) {
    const tg = await named(engine, accountId, "loadbalancing", "target-group", "web-tg");
    if (!tg) return { solved: false, status: "The target group web-tg is gone." };
    const health = await targetHealth(engine, accountId, tg, engine.now());
    const healthy = health.filter((t) => t.state === "healthy").length;
    if (healthy < 2) return { solved: false, status: `${healthy} of ${health.length} targets are healthy.` };
    for (const s of await running(engine, accountId)) {
      const direct = await analyzeReachability(engine, accountId, s.id, { protocol: "tcp", port: 80, source: "0.0.0.0/0" });
      if (direct.reachable && s.name.startsWith("web-")) return { solved: false, status: `The targets are healthy, but ${s.name} also accepts HTTP straight from the internet. Only the load balancer should reach it.` };
    }
    return { solved: true };
  },
};

const REPORTS = "month,revenue\nAugust,218000\nSeptember,231000\n";

const DISK_ZONE: ChallengeDef = {
  id: "disk-wrong-zone",
  title: "The restored disk won't attach",
  level: "intermediate",
  minutes: 8,
  summary: "Last night's backup was restored as a new volume, but it can't be attached to the server that needs it.",
  story:
    "Incident, 7:40 AM: the disk holding the monthly reports failed overnight. The on-call engineer restored the nightly snapshot, reports-nightly, as a new volume called reports-restore, but attaching it to the reports server shop-app fails, and the finance team needs their files by 9.",
  goal: "shop-app has a volume attached that holds /data/reports.csv from the nightly backup.",
  tools: ["Try attaching reports-restore to shop-app (edit the volume, or aws ec2 attach-volume) and read the error", "Where each thing lives: the volume's and the instance's Availability Zones", "The snapshot reports-nightly"],
  hints: [
    "Attach it and read the error word by word. Then compare the Availability Zone of the volume with the instance's.",
    "A volume can never move to another zone, and an instance can't either. But a snapshot isn't tied to any zone.",
    "Restore reports-nightly again, this time in the instance's zone (us-east-1a), and attach that volume to shop-app as /dev/sdf. Then delete reports-restore so you don't pay for it.",
  ],
  explanation:
    "EBS volumes live in one Availability Zone and can only attach to instances in that same zone (InvalidVolume.ZoneMismatch). The engineer restored the snapshot into us-east-1b, where the old server used to run, while shop-app runs in us-east-1a. Snapshots are stored regionally, so the fix is simply to restore again into the right zone. It's the standard way to move a disk between zones, and a reason to always note which zone a restore is for.",
  async setup(b) {
    const { vpc, pub } = await b.network({ publicAzs: ["us-east-1a"] });
    const sg = await b.group("app-sg", vpc.id, [{ protocol: "tcp", fromPort: 22, toPort: 22, cidr: "198.51.100.0/24", description: "SSH from the office" }]);
    await b.instance("shop-app", pub[0].id, [sg.id]);
    const old = await b.make("compute", "volume", { name: "reports-data", availabilityZone: "us-east-1b", size: 20, volumeType: "gp3" });
    await b.engine.setAttributes(b.accountId, old.id, { files: [{ path: "/data/reports.csv", content: REPORTS, modifiedAt: old.createdAt }] });
    const snap = await b.make("compute", "snapshot", { name: "reports-nightly", volumeId: old.id, description: "Nightly backup of reports-data" });
    await b.engine.remove(b.accountId, old.id);
    await b.make("compute", "volume", { name: "reports-restore", availabilityZone: "us-east-1b", snapshotId: snap.id, volumeType: "gp3" });
  },
  async facts(engine, accountId) {
    const app = await named(engine, accountId, "compute", "instance", "shop-app");
    return [`Server: shop-app${app ? ` (${app.id})` : ""}`, "Wanted on the server as: /dev/sdf → /data"];
  },
  async check(engine, accountId) {
    const app = await named(engine, accountId, "compute", "instance", "shop-app");
    if (!app || app.state === "terminated") return { solved: false, status: "shop-app is gone." };
    const vols = (await list(engine, accountId, "compute", "volume")).filter((v) => v.config.instanceId === app.id && v.state === "in-use");
    const ok = vols.some((v) => ((v.attributes.files as { path: string; content: string }[] | undefined) ?? []).some((f) => f.path === "/data/reports.csv" && f.content === REPORTS));
    return ok ? { solved: true } : { solved: false, status: "shop-app still has no disk with the reports attached." };
  },
};

const CHALLENGES: ChallengeDef[] = [SITE_DOWN, NO_UPDATES, ACCESS_DENIED, DB_CONNECT, API_500, DISK_ZONE, UNHEALTHY];

const info = (c: ChallengeDef): ChallengeInfo => ({ id: c.id, title: c.title, level: c.level, minutes: c.minutes, summary: c.summary });

export const listChallenges = (): ChallengeInfo[] => CHALLENGES.map(info);

/** Points for a solve: 100, minus 10, 20 and 30 for the first, second and third hint. */
export function challengeScore(hintsUsed: number): number {
  return 100 - [0, 10, 30, 60][Math.max(0, Math.min(3, hintsUsed))];
}

/** Wipes the challenge account and builds the broken setup. */
export async function startChallenge(engine: Engine, accountId: string, id: string): Promise<boolean> {
  const c = CHALLENGES.find((x) => x.id === id);
  if (!c) return false;
  for (const region of [...REGIONS.map((r) => r.code), "global"]) await engine.resetRegion(accountId, region);
  await engine.ensureDefaults(accountId, CHALLENGE_REGION);
  await c.setup(new Builder(engine, accountId));
  return true;
}

/** The challenge as the learner sees it: the story, the hints asked for so far, and whether it's fixed. */
export async function viewChallenge(engine: Engine, accountId: string, id: string, hintsUsed: number): Promise<ChallengeView | null> {
  const c = CHALLENGES.find((x) => x.id === id);
  if (!c) return null;
  await engine.ensureDefaults(accountId, CHALLENGE_REGION);
  const [facts, result] = await Promise.all([c.facts(engine, accountId), c.check(engine, accountId)]);
  return {
    ...info(c),
    region: CHALLENGE_REGION,
    story: c.story,
    goal: c.goal,
    facts,
    tools: c.tools,
    hints: c.hints.slice(0, Math.max(0, Math.min(3, hintsUsed))),
    hintCount: c.hints.length,
    solved: result.solved,
    ...(result.solved ? { explanation: c.explanation } : { status: result.status }),
  };
}
