import { analyzeDbConnection } from "@/engine/analysis/dbconnect";
import type { Engine } from "@/engine/engine";
import type { Resource } from "@/engine/types";
import { coversPort, inboundRules, isOwn, isPublicSubnet, type Snapshot } from "./snapshot";

/** What the managed-database tutorial looks at, in the focus VPC. */
export interface DbState {
  /** Private subnets of the VPC, one per zone, sorted by zone. */
  privateSubnets: Resource[];
  /** A DB subnet group in the VPC made only of private subnets, in two zones or more. */
  group?: Resource;
  /** A security group allowing 5432 from the web servers' group. */
  dbGroup?: Resource;
  database?: Resource;
  snapshots: Resource[];
  /** Whether the web server can connect, and the internet can't (computed on demand). */
  proof(webServer?: Resource): Promise<{ fromWeb: boolean; fromInternet: boolean }>;
}

export async function loadDb(engine: Engine, accountId: string, region: string, s: Snapshot, vpc: Resource | undefined, webGroup?: Resource): Promise<DbState> {
  const none: DbState = { privateSubnets: [], snapshots: [], proof: async () => ({ fromWeb: false, fromInternet: false }) };
  if (!vpc) return none;
  const list = (type: string) => engine.list(accountId, { service: "rds", type, region });
  const [groups, dbs, snapshots] = await Promise.all([list("db-subnet-group"), list("db-instance"), list("db-snapshot")]);

  const zones = new Map<string, Resource>();
  for (const sub of s.subnets.filter((x) => x.config.vpcId === vpc.id && !isPublicSubnet(s, x))) {
    const z = String(sub.config.availabilityZone);
    if (!zones.has(z)) zones.set(z, sub);
  }
  const privateSubnets = [...zones.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, x]) => x);
  const privateIds = new Set(s.subnets.filter((x) => x.config.vpcId === vpc.id && !isPublicSubnet(s, x)).map((x) => x.id));

  const group = groups.find((g) => {
    const ids = (g.config.subnetIds as string[]) ?? [];
    return g.attributes.vpcId === vpc.id && ids.length > 0 && ids.every((id) => privateIds.has(id)) && ((g.attributes.availabilityZones as string[]) ?? []).length >= 2;
  });
  const own = s.groups.filter((g) => g.config.vpcId === vpc.id && isOwn(g));
  const dbGroup = webGroup
    ? (own.find((g) => g.name === "db" && inboundRules(g).some((r) => r.sourceGroupId === webGroup.id && coversPort(r, 5432))) ??
      own.find((g) => inboundRules(g).some((r) => r.sourceGroupId === webGroup.id && coversPort(r, 5432))))
    : undefined;
  const database = dbs.find((d) => d.attributes.vpcId === vpc.id && (!group || d.config.dbSubnetGroupName === group.name)) ?? dbs.find((d) => d.attributes.vpcId === vpc.id);
  const mine = database ? snapshots.filter((x) => x.config.dbInstanceIdentifier === database.name) : [];

  let proof: Promise<{ fromWeb: boolean; fromInternet: boolean }> | null = null;
  return {
    privateSubnets,
    group,
    dbGroup,
    database,
    snapshots: mine,
    proof(webServer) {
      proof ??= (async () => {
        if (!database || !webServer) return { fromWeb: false, fromInternet: false };
        const web = await analyzeDbConnection(engine, accountId, database, { from: webServer.id }).catch(() => null);
        const internet = await analyzeDbConnection(engine, accountId, database, { from: "internet", source: "0.0.0.0/0" }).catch(() => null);
        return { fromWeb: web?.reachable === true, fromInternet: internet?.reachable === true };
      })();
      return proof;
    },
  };
}
