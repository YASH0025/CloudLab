import { EngineError } from "../errors";
import { accountNumber } from "../ids";
import type { ResourceTypeDef, ServiceDef } from "../types";

/**
 * CloudWatch Logs log groups. Events live in their own table (see
 * telemetry/logs.ts); the group holds settings like retention.
 * Lambda creates /aws/lambda/<function> itself, if its role allows it.
 */

export const RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];

export const logGroupArn = (region: string, accountId: string, name: string) => `arn:aws:logs:${region}:${accountNumber(accountId)}:log-group:${name}`;

const logGroup: ResourceTypeDef = {
  service: "logs",
  type: "log-group",
  label: "Log group",
  pluralLabel: "Log groups",
  description:
    "Where logs are kept: one group per app or function (e.g. /aws/lambda/hello), split into streams. You can search them, and they're deleted after the retention period.",
  idPrefix: "log-group",
  makeId: ({ name, region, accountId }) => logGroupArn(region, accountId, name),
  idPattern: /^arn:aws:logs:[a-z0-9-]+:\d{12}:log-group:[.\-_/#A-Za-z0-9]{1,512}$/,
  notFoundCode: "ResourceNotFoundException",
  notFoundMessage: () => "The specified log group does not exist.",
  notFoundByNameMessage: () => "The specified log group does not exist.",
  malformedCode: "ResourceNotFoundException",
  malformedMessage: () => "The specified log group does not exist.",
  apiNoun: "log group",
  fields: [
    {
      key: "name",
      label: "Log group name",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 512,
      pattern: "^[.\\-_/#A-Za-z0-9]+$",
      patternMessage: "Letters, numbers and . - _ / # only.",
      placeholder: "/myapp/web",
      param: "logGroupName",
    },
    {
      key: "retentionInDays",
      label: "Retention",
      type: "enum",
      default: "never",
      required: true,
      param: "retentionInDays",
      options: [{ value: "never", label: "Never expire" }, ...RETENTION_DAYS.map((d) => ({ value: String(d), label: `${d} day${d === 1 ? "" : "s"}` }))],
      description: "Older events are deleted. 'Never expire' keeps everything (and costs the most on AWS). CloudLab keeps at most the newest 2,000 events per group.",
    },
  ],
  columns: [
    { label: "Retention", path: "config.retentionInDays" },
  ],
  iam: {
    create: "logs:CreateLogGroup",
    read: "logs:DescribeLogGroups",
    update: "logs:PutRetentionPolicy",
    delete: "logs:DeleteLogGroup",
    arn: (r) => r.id,
  },
  invalidValue({ field, value }) {
    if (field.key === "retentionInDays") {
      return new EngineError(
        "InvalidParameterException",
        `1 validation error detected: Value '${value}' at 'retentionInDays' failed to satisfy constraint: Member must satisfy enum value set: [${RETENTION_DAYS.join(", ")}]`,
      );
    }
    if (field.key === "name") {
      return new EngineError(
        "InvalidParameterException",
        `1 validation error detected: Value '${value}' at 'logGroupName' failed to satisfy constraint: Member must satisfy regular expression pattern: [\\.\\-_/#A-Za-z0-9]+`,
      );
    }
    return undefined;
  },
  async validate({ config, existing, ctx }) {
    if (!existing && (await ctx.list("logs", "log-group")).some((g) => g.name === config.name)) {
      throw new EngineError("ResourceAlreadyExistsException", "The specified log group already exists");
    }
  },
  async derive({ id, ctx, existing }) {
    return { ...(existing?.attributes ?? {}), arn: `${id}:*`, creationTime: existing?.attributes.creationTime ?? ctx.now().getTime() };
  },
  async afterDelete({ resource, system }) {
    await system.purgeLogs(resource.name);
  },
};

export const logsService: ServiceDef = {
  id: "logs",
  label: "CloudWatch Logs",
  modelledOn: "CloudWatch Logs",
  description: "Log groups and streams from your functions and apps, searchable with filter patterns.",
  category: "Monitoring",
  types: [logGroup],
};
