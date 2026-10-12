import { createHash, randomUUID } from "node:crypto";
import { analyzeDbConnection } from "@/engine/analysis/dbconnect";
import { targetHealth } from "@/engine/analysis/health";
import { analyzeReachability } from "@/engine/analysis/reachability";
import { REGIONS } from "@/engine/catalog";
import type { Engine } from "@/engine/engine";
import { check, resolvePrincipal } from "@/engine/iam/authorize";
import { accountNumber } from "@/engine/ids";
import { addPermission, allowsService } from "@/engine/lambda/invoke";
import { publish } from "@/engine/sns/publish";
import { checkFilterPolicy, matchesFilter } from "@/engine/services/sns";
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

const FULFIL_CODE = `export const handler = async (event) => {
  for (const record of event.Records) {
    const order = JSON.parse(record.Sns.Message);
    console.log("Packing order", order.id, "for", order.customer);
  }
};
`;

const order = (id: number, type: string) => ({
  message: JSON.stringify({ id, customer: "asha@example.com", items: ["book"] }),
  attributes: { type: { DataType: "String", StringValue: type }, amount: { DataType: "Number", StringValue: "499" } },
});

const SILENT_ORDERS: ChallengeDef = {
  id: "silent-orders",
  title: "Orders are placed, but nothing gets packed",
  level: "intermediate",
  minutes: 10,
  summary: "The shop publishes every order to an SNS topic. The packing function hasn't run once since the move to the new account.",
  story:
    "The warehouse: “We haven't had a single packing slip since yesterday's move to the new AWS account.” The shop publishes each order to the SNS topic orders, with the attribute type = order (refunds go to the same topic with type = refund). The Lambda function fulfil is subscribed and should run for every order. Nobody sees an error anywhere: the shop's publish calls all succeed.",
  goal: "A message with type = order runs fulfil. Refunds (type = refund) must still not reach fulfil, and only the orders topic may invoke it.",
  tools: ["The topic orders → Recent deliveries (and its Publish message panel)", "The subscription to fulfil: its filter policy and Delivery to the function", "aws sns get-subscription-attributes, aws lambda get-policy"],
  hints: [
    "Publishing succeeds even if nobody receives the message. Look at what happened to each copy: the topic's Recent deliveries says why.",
    "Two things stand between the topic and the function: the subscription's filter policy (compare its values with what the shop sends, letter by letter) and the function's permission for SNS.",
    'Edit the subscription\'s filter policy to {"type": ["order"]} (matching is case-sensitive). Then on the subscription page, click Allow this topic to invoke the function (or aws lambda add-permission with --principal sns.amazonaws.com --source-arn <topic ARN>). Publish a test order to check.',
  ],
  explanation:
    "Two separate things silenced the orders. First, the filter policy asked for type = \"Order\", but the shop sends \"order\": filter matching is exact and case-sensitive, so every message was filtered out, which isn't an error for SNS. Second, after the move nobody re-added the function's permission: in the new account, its resource-based policy had no statement letting sns.amazonaws.com invoke it, so even matching messages would have failed (SNS retries, then gives up, visible only in NumberOfNotificationsFailed). Publish returning a MessageId only means SNS accepted the message, never that anyone got it.",
  async setup(b) {
    const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
    await b.make("iam", "role", { name: "fulfil-role", trustPolicy: trust, policyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"] }, "global");
    const fn = await b.make("lambda", "function", { name: "fulfil", runtime: "nodejs22.x", handler: "index.handler", role: "fulfil-role", files: { "index.mjs": FULFIL_CODE } });
    const topic = await b.make("sns", "topic", { name: "orders", displayName: "MyShop orders" });
    await b.make("sns", "subscription", { topicArn: topic.id, protocol: "lambda", endpoint: fn.id, filterPolicy: '{\n  "type": ["Order"]\n}' });
    // Yesterday's traffic, so the delivery log tells the story.
    await publish(b.engine, b.accountId, topic, order(1041, "order"));
    await publish(b.engine, b.accountId, topic, order(1042, "refund"));
    await publish(b.engine, b.accountId, topic, order(1043, "order"));
  },
  async facts(engine, accountId) {
    const topic = await named(engine, accountId, "sns", "topic", "orders");
    return [
      `Topic: ${topic?.id ?? "orders"}`,
      `How the shop publishes: aws sns publish --topic-arn ${topic?.id ?? "<orders ARN>"} --message '{"id":1044,…}' --message-attributes 'type={DataType=String,StringValue=order}'`,
    ];
  },
  async check(engine, accountId) {
    const topic = await named(engine, accountId, "sns", "topic", "orders");
    const fn = await named(engine, accountId, "lambda", "function", "fulfil");
    if (!topic || !fn) return { solved: false, status: "The topic orders or the function fulfil is missing." };
    const subs = (await list(engine, accountId, "sns", "subscription")).filter(
      (s) => s.config.topicArn === topic.id && s.config.protocol === "lambda" && String(s.config.endpoint).split(":").slice(0, 7).join(":") === fn.id && s.state === "confirmed",
    );
    if (subs.length === 0) return { solved: false, status: "fulfil isn't subscribed to the topic any more." };
    const wants = (type: string) =>
      subs.some((s) => {
        if (!s.config.filterPolicy) return true;
        try {
          return matchesFilter(checkFilterPolicy(String(s.config.filterPolicy)), order(0, type).attributes).match;
        } catch {
          return false;
        }
      });
    if (!wants("order")) return { solved: false, status: "Orders still don't make it past the subscription." };
    if (wants("refund")) return { solved: false, status: "Orders get through now, but so do refunds: the warehouse would ship refunded orders." };
    if (!allowsService(fn, "sns.amazonaws.com", topic.id)) return { solved: false, status: "Orders pass the filter now, but every delivery to the function fails." };
    if (allowsService(fn, "sns.amazonaws.com", `arn:aws:sns:${CHALLENGE_REGION}:${accountNumber(accountId)}:some-other-topic`)) {
      return { solved: false, status: "It works, but now any SNS topic may invoke fulfil. Scope the permission to the orders topic." };
    }
    return { solved: true };
  },
};

const DOUBLE_CHARGED: ChallengeDef = {
  id: "double-charged",
  title: "Customers are being charged twice",
  level: "intermediate",
  minutes: 10,
  summary: "A worker takes payments off a queue. Some customers are charged two or three times, and one payment is retried forever.",
  story:
    "Support: “Three customers were charged twice for the same order today, one of them three times.” The website puts each payment job in the SQS queue payments; a worker takes them one at a time, calls the bank (about 45 seconds per payment, the bank is slow), then deletes the message. The worker's logs also show the same broken payment (order 9001, card number missing) failing again and again since this morning.",
  goal: "Each payment is processed once, and a message that keeps failing is set aside after at most 5 tries instead of being retried forever. Don't delete the queue.",
  tools: ["The queue payments: its settings, and Receive messages (look at received N×)", "aws sqs get-queue-attributes --queue-url <url> --attribute-names All", "aws sqs receive-message … --attribute-names ApproximateReceiveCount"],
  hints: [
    "A received message is only hidden for the queue's visibility timeout. If the worker hasn't deleted it by then, it becomes visible again and gets processed again.",
    "Compare the visibility timeout of payments with how long one payment takes. And for the broken message: what moves a message aside after N failed receives?",
    "Edit payments: set the visibility timeout above 45 seconds (60 or more), set its dead-letter queue to payments-dlq, and Maximum receives to 5 or less.",
  ],
  explanation:
    "The queue's visibility timeout was 5 seconds, but a payment takes about 45. Five seconds after the worker took a message, the queue assumed it had failed and handed it out again, so slow payments were charged twice or three times. The fix is a visibility timeout longer than the work takes (AWS suggests several times longer; workers can also extend it with ChangeMessageVisibility). Separately, order 9001 can never succeed; with no redrive policy it was retried forever. A dead-letter queue with maxReceiveCount takes it out of the line after a few tries so someone can look at it. Standard queues can still deliver a message twice in rare cases, so a payment worker should also be idempotent (skip an order it has already charged).",
  async setup(b) {
    await b.make("sqs", "queue", { name: "payments-dlq" });
    const q = await b.make("sqs", "queue", { name: "payments", visibilityTimeout: 5 });
    const now = b.engine.now().getTime();
    const msg = (order: number, receiveCount: number, ageMin: number) => {
      const body = JSON.stringify({ orderId: order, amount: 499, card: order === 9001 ? null : "tok_visa" });
      return {
        messageId: randomUUID(),
        body,
        md5: createHash("md5").update(body).digest("hex"),
        attributes: {},
        sentAt: now - ageMin * 60_000,
        visibleAt: now,
        receiveCount,
        firstReceivedAt: now - ageMin * 60_000,
        senderId: accountNumber(b.accountId),
      };
    };
    await b.engine.setAttributes(b.accountId, q.id, { messages: [msg(9001, 37, 240), msg(1187, 2, 1), msg(1188, 3, 1)] });
  },
  async facts(engine, accountId) {
    const q = await named(engine, accountId, "sqs", "queue", "payments");
    return [`Queue: ${q?.id ?? "payments"}`, "One payment takes about 45 seconds (the bank's API is slow)."];
  },
  async check(engine, accountId) {
    const q = await named(engine, accountId, "sqs", "queue", "payments");
    if (!q) return { solved: false, status: "The queue payments is gone: the website has nowhere to send payments." };
    const vt = Number(q.config.visibilityTimeout);
    const dlq = q.config.deadLetterQueue ? await engine.get(accountId, String(q.config.deadLetterQueue)).catch(() => null) : null;
    const max = Number(q.config.maxReceiveCount ?? 10);
    if (vt <= 45) return { solved: false, status: "Payments are still handed out again before the worker can finish them." };
    if (!dlq) return { solved: false, status: "No more double charges, but the broken payment is still retried forever." };
    if (max > 5) return { solved: false, status: "Broken payments are set aside now, but only after more than 5 tries." };
    return { solved: true };
  },
};

const ORDERS_BY_CUSTOMER: ChallengeDef = {
  id: "orders-by-customer",
  title: "“My orders” gets slower every week",
  level: "intermediate",
  minutes: 8,
  summary: "The orders table is keyed by order ID. Showing one customer's orders reads the whole table, and the bill and the wait keep growing.",
  story:
    "The mobile team: “The My orders screen took 0.2 s at launch, now it's 4 s, and the DynamoDB bill doubled again.” The table ShopOrders has the partition key orderId. To show a customer's orders, the app runs a Scan with the filter customerId = :me. Every new order makes every customer's screen slower.",
  goal: "Make it possible to fetch one customer's orders, newest first, with a Query instead of a Scan. Keep the table and its data (orders are still looked up by orderId too).",
  tools: ["ShopOrders → Explore items: run the app's Scan and compare Items read with Items returned", "aws dynamodb describe-table --table-name ShopOrders", "aws dynamodb scan --table-name ShopOrders --filter-expression … (look at ScannedCount)"],
  hints: [
    "A filter is applied after reading. The app reads every order in the table to show 10 of them. Query only reads one partition, but it can only ask by a key.",
    "You can't change a table's key after creating it, but you can add a global secondary index with a different key.",
    "Edit ShopOrders → Global secondary indexes → add one with partition key customerId (String) and sort key createdAt (String). Then the app can Query that index, newest first.",
  ],
  explanation:
    "DynamoDB is fast when every read is a Query or GetItem by key. The table was designed for 'find order X' (orderId), so 'find customer Y's orders' could only be a Scan: it reads every item (and you pay for every one), then throws most away with the filter. That cost grows with the table, not with the answer. A global secondary index on customerId + createdAt stores the same orders grouped by customer and sorted by date, so the screen becomes a Query that reads only that customer's orders. Design keys around your access patterns, and add an index for each new question.",
  async setup(b) {
    const t = await b.make("dynamodb", "table", { name: "ShopOrders", partitionKey: "orderId", partitionKeyType: "S", billingMode: "PAY_PER_REQUEST" });
    const items: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 240; i++) {
      const id = `ord-${String(10000 + i)}`;
      items[JSON.stringify([{ S: id }, null])] = {
        orderId: { S: id },
        customerId: { S: `cust-${String(1 + (i % 24)).padStart(3, "0")}` },
        createdAt: { S: new Date(Date.UTC(2026, 8, 1) + i * 3 * 3600_000).toISOString() },
        total: { N: String(100 + ((i * 37) % 900)) },
        status: { S: i % 5 === 0 ? "delivered" : "placed" },
      };
    }
    await b.engine.setAttributes(b.accountId, t.id, { items, itemCount: 240, tableSizeBytes: 240 * 120 });
  },
  async facts() {
    return [
      "Table: ShopOrders (partition key orderId), 240 orders from 24 customers",
      `The app's query: aws dynamodb scan --table-name ShopOrders --filter-expression "customerId = :me" --expression-attribute-values '{":me":{"S":"cust-007"}}'`,
    ];
  },
  async check(engine, accountId) {
    const t = await named(engine, accountId, "dynamodb", "table", "ShopOrders");
    if (!t) return { solved: false, status: "The table ShopOrders is gone, and the orders with it." };
    if (Number(t.attributes.itemCount ?? 0) < 200) return { solved: false, status: "Orders are missing from ShopOrders: keep the data." };
    const gsis = (t.config.globalSecondaryIndexes as { partitionKey: string; partitionKeyType?: string; sortKey?: string }[] | undefined) ?? [];
    const byCustomer = gsis.find((g) => g.partitionKey === "customerId");
    if (!byCustomer) return { solved: false, status: "A customer's orders can still only be found by reading the whole table." };
    if ((byCustomer.partitionKeyType ?? "S") !== "S") return { solved: false, status: "The index's customerId is the wrong type: the values are strings." };
    if (byCustomer.sortKey !== "createdAt") return { solved: false, status: "You can query by customer now, but not newest first: the index has no sort key by date." };
    return { solved: true };
  },
};

const NETWORK_STACK = `AWSTemplateFormatVersion: "2010-09-09"
Description: Network for the new shop
Resources:
  ShopVpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.40.0.0/16
      Tags: [{ Key: Name, Value: shop-vpc }]
  PublicSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref ShopVpc
      CidrBlock: 10.4.1.0/24
      MapPublicIpOnLaunch: true
  PrivateSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref ShopVpc
      CidrBlock: 10.40.11.0/24
Outputs:
  VpcId:
    Value: !Ref ShopVpc
`;

const STACK_ROLLED_BACK: ChallengeDef = {
  id: "stack-rolled-back",
  title: "The network stack won't deploy",
  level: "advanced",
  minutes: 10,
  summary: "A teammate's CloudFormation stack ends in ROLLBACK_COMPLETE every time, and now it can't even be updated.",
  story:
    "A teammate wrote a template for the new shop's network (a VPC with a public and a private subnet) and created the stack shop-network. It went to ROLLBACK_COMPLETE, nothing was left behind, and now every update attempt says the stack “can not be updated”. They're sure the template is fine because CloudFormation accepted it.",
  goal: "The stack shop-network exists and is in CREATE_COMPLETE (or UPDATE_COMPLETE), with its VPC 10.40.0.0/16 and both subnets.",
  tools: ["shop-network → Events (and the Why it failed box)", "aws cloudformation describe-stack-events --stack-name shop-network", "aws cloudformation get-template --stack-name shop-network"],
  hints: [
    "CloudFormation only checks a template's format up front. Whether each resource can be created is up to the service: read the CREATE_FAILED event for the service's own error.",
    "PublicSubnet failed with InvalidSubnet.Range. Compare its CidrBlock with the VPC's: is it inside 10.40.0.0/16? And a stack in ROLLBACK_COMPLETE can't be updated at all.",
    "Copy the template (get-template, or the Template field), fix PublicSubnet's CidrBlock to 10.40.1.0/24, delete the stack, and create shop-network again with the fixed template.",
  ],
  explanation:
    "The template was valid YAML with valid references, so CreateStack accepted it. Creating the resources is where it failed: PublicSubnet's 10.4.1.0/24 (a typo for 10.40.1.0/24) isn't inside the VPC's 10.40.0.0/16, EC2 refused it with InvalidSubnet.Range, and CloudFormation rolled back everything it had made. A stack whose very first create failed ends in ROLLBACK_COMPLETE, a dead end: it can only be deleted, then created again. The first CREATE_FAILED event (not the last one) always names the real cause.",
  async setup(b) {
    await b.make("cloudformation", "stack", { name: "shop-network", templateBody: NETWORK_STACK });
  },
  async facts(engine, accountId) {
    const s = await named(engine, accountId, "cloudformation", "stack", "shop-network");
    return [`Stack: shop-network (${s?.state ?? "missing"})`];
  },
  async check(engine, accountId) {
    const s = await named(engine, accountId, "cloudformation", "stack", "shop-network");
    if (!s) return { solved: false, status: "There's no stack named shop-network right now." };
    if (!["CREATE_COMPLETE", "UPDATE_COMPLETE"].includes(String(s.state))) return { solved: false, status: `shop-network is in ${s.state}.` };
    const resources = (s.attributes.resources as { type: string; resourceId?: string }[] | undefined) ?? [];
    const vpcRes = resources.find((r) => r.type === "AWS::EC2::VPC");
    const vpc = vpcRes?.resourceId ? await engine.get(accountId, vpcRes.resourceId).catch(() => null) : null;
    if (!vpc || vpc.config.cidrBlock !== "10.40.0.0/16") return { solved: false, status: "The stack is up, but its VPC isn't 10.40.0.0/16." };
    if (resources.filter((r) => r.type === "AWS::EC2::Subnet").length < 2) return { solved: false, status: "The stack is up, but it doesn't have both subnets." };
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

const ACL_REPLIES: ChallengeDef = {
  id: "acl-replies",
  title: "The site broke after the security review",
  level: "advanced",
  minutes: 10,
  summary: "The security team added a network ACL that “allows web traffic”. Since then, every visit times out.",
  story:
    "Change log, Tuesday: “Security review: added network ACL web-acl to the web subnet. Inbound: HTTP from anywhere, SSH from the office. Outbound: only HTTP and HTTPS.” Since then, the shop at shop-web times out for everyone. The security group hasn't changed, and the server is fine.",
  goal: "Customers can open the shop on port 80 again. web-acl must stay on the web subnet, and must not allow all inbound traffic.",
  tools: ["shop-web's Reachability panel (HTTP from the internet): read every step", "VPC → Network ACLs → web-acl", "How a reply finds its way back to a visitor"],
  hints: [
    "Run the HTTP reachability check: the request gets in. Look at what happens to the server's answer on its way back out.",
    "The visitor's browser sent the request from a random high port, and the reply goes back to that port. Network ACLs are stateless: they check the reply like any other outbound packet.",
    "Edit web-acl: add an outbound rule (e.g. 120) allowing TCP 1024–65535 to 0.0.0.0/0. Keep the inbound rules as they are.",
  ],
  explanation:
    "Security groups are stateful: once a request is allowed in, its reply is allowed out automatically. Network ACLs are stateless: every packet is checked on its own, in both directions. The reply to a visitor goes to the visitor's ephemeral port (somewhere in 1024–65535), and web-acl's outbound rules only allowed ports 80 and 443, which is what you'd allow for the server's own requests, not for replies. Adding the ephemeral range outbound fixes it. Every ACL that allows a service in needs this matching rule out.",
  async setup(b) {
    const { vpc, pub } = await b.network({ publicAzs: ["us-east-1a"] });
    const sg = await b.group("web-sg", vpc.id, [
      { protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0", description: "HTTP" },
      { protocol: "tcp", fromPort: 22, toPort: 22, cidr: "198.51.100.0/24", description: "SSH from the office" },
    ]);
    await b.instance("shop-web", pub[0].id, [sg.id]);
    await b.make("networking", "network-acl", {
      name: "web-acl",
      vpcId: vpc.id,
      inboundRules: [
        { ruleNumber: 100, protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0", action: "allow" },
        { ruleNumber: 110, protocol: "tcp", fromPort: 22, toPort: 22, cidr: "198.51.100.0/24", action: "allow" },
      ],
      outboundRules: [
        { ruleNumber: 100, protocol: "tcp", fromPort: 80, toPort: 80, cidr: "0.0.0.0/0", action: "allow" },
        { ruleNumber: 110, protocol: "tcp", fromPort: 443, toPort: 443, cidr: "0.0.0.0/0", action: "allow" },
      ],
      subnetIds: [pub[0].id],
    });
  },
  async facts(engine, accountId) {
    const web = await named(engine, accountId, "compute", "instance", "shop-web");
    return [web ? `Shop address: http://${String(web.attributes.publicIp)}` : "Shop server: shop-web", "Changed on Tuesday: network ACL web-acl"];
  },
  async check(engine, accountId) {
    const web = await named(engine, accountId, "compute", "instance", "shop-web");
    const acl = await named(engine, accountId, "networking", "network-acl", "web-acl");
    if (!web || web.state !== "running") return { solved: false, status: "shop-web isn't running." };
    if (!acl || !((acl.config.subnetIds as string[] | undefined) ?? []).includes(String(web.config.subnetId))) {
      return { solved: false, status: "web-acl must stay on the web subnet: the security team requires it." };
    }
    const inbound = (acl.config.inboundRules as { protocol: string; cidr: string; action: string }[] | undefined) ?? [];
    if (inbound.some((r) => r.action === "allow" && r.protocol === "all" && r.cidr === "0.0.0.0/0")) {
      return { solved: false, status: "web-acl now allows all inbound traffic. Fix what's really missing instead." };
    }
    const r = await analyzeReachability(engine, accountId, web.id, { protocol: "tcp", port: 80, source: "0.0.0.0/0" });
    return r.reachable ? { solved: true } : { solved: false, status: "Visitors still time out." };
  },
};

const PEERING_ONE_WAY: ChallengeDef = {
  id: "peering-one-way",
  title: "The VPCs are peered, but the app can't connect",
  level: "intermediate",
  minutes: 8,
  summary: "Peering is active, routes were added, security groups allow it. The app still times out connecting to the database in the other VPC.",
  story:
    "From the platform team: “We peered app-vpc with data-vpc yesterday (pcx is active), added the route, and the database's security group allows 10.0.0.0/16 on 5432. But app-server still can't reach db-server: connection timed out.” Both servers are private, in their own VPCs.",
  goal: "app-server can connect to db-server on TCP 5432 over the peering connection.",
  tools: ["db-server's Reachability panel → From another instance → app-server, PostgreSQL", "The peering connection's page (routes on each side)", "Both VPCs' route tables"],
  hints: [
    "Run the check from app-server to db-server on port 5432 and find the first failing step.",
    "A connection is two-way: db-server's reply has to find its way back to 10.0.x.x. Where does data-vpc's route table send that range?",
    "Add a route to data-vpc's route table: 10.0.0.0/16 → the peering connection. (Only app-vpc's side had one.)",
  ],
  explanation:
    "Peering needs routes on both sides. app-vpc's route table sent 10.1.0.0/16 to the peering connection, so requests arrived; but data-vpc's table had no route for 10.0.0.0/16, so db-server's replies had nowhere to go and the client timed out. It's the most common peering mistake, because the side you configure first looks right on its own. Also remember peering isn't transitive: a third VPC peered with data-vpc still couldn't reach app-vpc.",
  async setup(b) {
    const make = async (name: string, cidr: string, port: number | null, from: string) => {
      const base = cidr.split(".").slice(0, 2).join(".");
      const vpc = await b.make("networking", "vpc", { name, cidrBlock: cidr });
      const subnet = await b.make("networking", "subnet", { name: `${name}-private`, vpcId: vpc.id, cidrBlock: `${base}.1.0/24`, availabilityZone: "us-east-1a" });
      const table = await b.make("networking", "route-table", { name: `${name}-rt`, vpcId: vpc.id, subnetIds: [subnet.id], routes: [] });
      const sg = await b.group(`${name}-sg`, vpc.id, port ? [{ protocol: "tcp", fromPort: port, toPort: port, cidr: from, description: "From the other VPC" }] : []);
      return { vpc, subnet, table, sg };
    };
    const app = await make("app-vpc", "10.0.0.0/16", null, "");
    const data = await make("data-vpc", "10.1.0.0/16", 5432, "10.0.0.0/16");
    await b.instance("app-server", app.subnet.id, [app.sg.id]);
    await b.instance("db-server", data.subnet.id, [data.sg.id]);
    const pcx = await b.make("networking", "peering-connection", { name: "app-to-data", vpcId: app.vpc.id, peerVpcId: data.vpc.id });
    await b.engine.runAction(b.accountId, pcx.id, "accept");
    await b.engine.update(b.accountId, app.table.id, { routes: [{ destination: "10.1.0.0/16", vpcPeeringConnectionId: pcx.id }] });
  },
  async facts(engine, accountId) {
    const db = await named(engine, accountId, "compute", "instance", "db-server");
    return [`Database: db-server${db ? ` (${String(db.attributes.privateIp)}:5432)` : ""}`, "app-vpc: 10.0.0.0/16 · data-vpc: 10.1.0.0/16"];
  },
  async check(engine, accountId) {
    const app = await named(engine, accountId, "compute", "instance", "app-server");
    const db = await named(engine, accountId, "compute", "instance", "db-server");
    if (!app || !db) return { solved: false, status: "app-server or db-server is gone." };
    const r = await analyzeReachability(engine, accountId, db.id, { protocol: "tcp", port: 5432, from: app.id, source: "0.0.0.0/0" });
    return r.reachable ? { solved: true } : { solved: false, status: "app-server still can't connect to db-server on 5432." };
  },
};

const CHALLENGES: ChallengeDef[] = [SITE_DOWN, NO_UPDATES, ACCESS_DENIED, DB_CONNECT, API_500, DISK_ZONE, PEERING_ONE_WAY, ACL_REPLIES, SILENT_ORDERS, DOUBLE_CHARGED, ORDERS_BY_CUSTOMER, UNHEALTHY, STACK_ROLLED_BACK];

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
