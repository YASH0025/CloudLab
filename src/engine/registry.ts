import { errors } from "./errors";
import { computeService } from "./services/compute";
import { autoScalingService } from "./services/autoscaling";
import { iamService } from "./services/iam";
import { loadBalancingService } from "./services/loadbalancing";
import { networkingService } from "./services/networking";
import { rdsService } from "./services/rds";
import { lambdaService } from "./services/lambda";
import { apiGatewayService } from "./services/apigateway";
import { logsService } from "./services/logs";
import { cloudWatchService } from "./services/cloudwatch";
import { route53Service } from "./services/route53";
import { snsService } from "./services/sns";
import { sqsService } from "./services/sqs";
import { dynamodbService } from "./services/dynamodb";
import { cloudFormationService } from "./services/cloudformation";
import { objectType, storageService } from "./services/storage";
import { progressType } from "./services/progress";
import { resolveCatalog, resolveTypeFields, type ServiceCatalog } from "./resolve";
import type { ResolvedServiceDef, ResolvedTypeDef, ResourceTypeDef, ServiceDef } from "./types";

/** Every service the platform simulates. Add new service definitions here. */
export const SERVICES: ServiceDef[] = [
  networkingService,
  route53Service,
  computeService,
  loadBalancingService,
  autoScalingService,
  rdsService,
  dynamodbService,
  lambdaService,
  apiGatewayService,
  snsService,
  sqsService,
  storageService,
  iamService,
  cloudWatchService,
  logsService,
  cloudFormationService,
];

/** Types managed through their own screens rather than the generic console pages (bucket objects). */
const HIDDEN_TYPES: ResourceTypeDef[] = [objectType, progressType];

/** Every resource type, including hidden ones. */
export const allTypes = (): ResourceTypeDef[] => [...SERVICES.flatMap((s) => s.types), ...HIDDEN_TYPES];

export function getTypeDef(service: string, type: string): ResourceTypeDef {
  const def = allTypes().find((t) => t.service === service && t.type === type);
  if (!def) throw errors.unknownType(service, type);
  return def;
}

/** Keys of a type definition that are server-only (engine hooks, IAM, ID patterns…). */
const SERVER_ONLY = new Set([
  "validate",
  "derive",
  "invalidValue",
  "dependencyMessage",
  "canDelete",
  "afterCreate",
  "afterUpdate",
  "afterDelete",
  "onSettled",
  "dependencyError",
  "notFoundMessage",
  "makeId",
  "iam",
  "beforeDelete",
  "privateAttributes",
  "idPattern",
  "malformedMessage",
  "notFoundByNameMessage",
  "beforeAction",
  "normalize",
]);

/** A type definition as plain data: server-only parts removed, and any function inside (field hooks) dropped. */
function plainTypeDef(def: ResourceTypeDef): ResolvedTypeDef {
  const data = Object.fromEntries(Object.entries(def).filter(([k]) => !SERVER_ONLY.has(k)));
  return JSON.parse(JSON.stringify(data)) as ResolvedTypeDef;
}

let catalog: ServiceCatalog | null = null;

/** Every service as plain data, for the browser (see engine/resolve.ts). */
export function serviceCatalog(): ServiceCatalog {
  catalog ??= SERVICES.map((s) => ({ ...JSON.parse(JSON.stringify({ ...s, types: [] })), types: s.types.map(plainTypeDef) }));
  return catalog;
}

/** A type definition with region-dependent options filled in, for the engine's own checks (hooks dropped, the rest as is). */
export function resolveTypeDef(def: ResourceTypeDef, region: string): ResolvedTypeDef {
  const data = Object.fromEntries(Object.entries(def).filter(([, v]) => typeof v !== "function")) as ResolvedTypeDef;
  return resolveTypeFields(data, region);
}

export function resolveServices(region: string): ResolvedServiceDef[] {
  return resolveCatalog(serviceCatalog(), region);
}
