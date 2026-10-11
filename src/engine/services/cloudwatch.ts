import { EngineError } from "../errors";
import { accountNumber } from "../ids";
import type { FieldDef, ResourceTypeDef, ServiceDef } from "../types";

/**
 * CloudWatch alarms and dashboards. An alarm watches one metric statistic
 * over a number of periods and is OK, ALARM or INSUFFICIENT_DATA; it is
 * evaluated whenever the region is used (telemetry/alarms.ts). A dashboard
 * is a JSON body of widgets, as in the real PutDashboard API.
 */

export const COMPARISONS = [
  { value: "GreaterThanThreshold", label: ">", hint: "Greater than" },
  { value: "GreaterThanOrEqualToThreshold", label: ">=", hint: "Greater than or equal to" },
  { value: "LessThanThreshold", label: "<", hint: "Less than" },
  { value: "LessThanOrEqualToThreshold", label: "<=", hint: "Less than or equal to" },
];

export const NAMESPACES = ["AWS/EC2", "AWS/Lambda", "AWS/ApiGateway", "AWS/ApplicationELB", "AWS/RDS", "AWS/AutoScaling"];

const dimensionItem: FieldDef[] = [
  { key: "name", label: "Name", type: "string", required: true, maxLength: 255, placeholder: "FunctionName" },
  { key: "value", label: "Value", type: "string", required: true, maxLength: 1024, placeholder: "hello" },
];

const alarm: ResourceTypeDef = {
  service: "cloudwatch",
  type: "alarm",
  label: "Alarm",
  pluralLabel: "Alarms",
  description:
    "Watches one metric and changes state when it crosses a threshold, e.g. 'Lambda errors > 0 in 1 minute' or 'CPU > 80% for 3 minutes'. States: OK, ALARM, INSUFFICIENT_DATA.",
  idPrefix: "alarm",
  makeId: ({ name, region, accountId }) => `arn:aws:cloudwatch:${region}:${accountNumber(accountId)}:alarm:${name}`,
  idPattern: /^arn:aws:cloudwatch:[a-z0-9-]+:\d{12}:alarm:.{1,255}$/,
  notFoundCode: "ResourceNotFound",
  notFoundMessage: (id) => `Alarm ${id.split(":alarm:").pop()} does not exist.`,
  malformedCode: "ResourceNotFound",
  malformedMessage: (id) => `Alarm ${id} does not exist.`,
  apiNoun: "alarm",
  panelAttributes: ["history", "stateReasonData", "manualUntil", "alarmActions", "evaluatedAt", "stateValue", "stateReason", "stateUpdatedTimestamp"],
  fields: [
    { key: "name", label: "Alarm name", type: "string", required: true, immutable: true, maxLength: 255, placeholder: "hello-errors", param: "AlarmName" },
    { key: "description", label: "Description", type: "string", maxLength: 1024, param: "AlarmDescription" },
    {
      key: "namespace",
      label: "Namespace",
      type: "string",
      required: true,
      maxLength: 255,
      placeholder: "AWS/Lambda",
      param: "Namespace",
      description: `The service the metric comes from: ${NAMESPACES.join(", ")}, or your own (custom metrics).`,
    },
    { key: "metricName", label: "Metric", type: "string", required: true, maxLength: 255, placeholder: "Errors", param: "MetricName" },
    {
      key: "dimensions",
      label: "Dimensions",
      type: "list",
      item: dimensionItem,
      maxItems: 30,
      param: "Dimensions",
      description: "Which resource's metric, e.g. FunctionName = hello. Leave empty for metrics without dimensions.",
    },
    {
      key: "statistic",
      label: "Statistic",
      type: "enum",
      required: true,
      default: "Average",
      param: "Statistic",
      options: [
        { value: "Average", label: "Average" },
        { value: "Sum", label: "Sum", hint: "Counts like Errors and Invocations" },
        { value: "Maximum", label: "Maximum" },
        { value: "Minimum", label: "Minimum" },
        { value: "SampleCount", label: "SampleCount" },
      ],
    },
    {
      key: "period",
      label: "Period (seconds)",
      type: "number",
      required: true,
      default: 60,
      min: 60,
      max: 86400,
      param: "Period",
      description: "The length of each datapoint: 60 for one minute.",
    },
    { key: "evaluationPeriods", label: "Evaluation periods", type: "number", required: true, default: 1, min: 1, max: 100, param: "EvaluationPeriods" },
    {
      key: "datapointsToAlarm",
      label: "Datapoints to alarm",
      type: "number",
      min: 1,
      max: 100,
      param: "DatapointsToAlarm",
      description: "How many of the evaluation periods must breach (M out of N). Empty means all of them.",
    },
    { key: "comparisonOperator", label: "Comparison", type: "enum", required: true, default: "GreaterThanThreshold", options: COMPARISONS, param: "ComparisonOperator" },
    { key: "threshold", label: "Threshold", type: "number", decimal: true, required: true, param: "Threshold" },
    {
      key: "treatMissingData",
      label: "Missing data",
      type: "enum",
      required: true,
      default: "missing",
      param: "TreatMissingData",
      options: [
        { value: "missing", label: "missing", hint: "Not enough data → INSUFFICIENT_DATA" },
        { value: "notBreaching", label: "notBreaching", hint: "No data counts as fine (good for error counts)" },
        { value: "breaching", label: "breaching", hint: "No data counts as a problem" },
        { value: "ignore", label: "ignore", hint: "Keep the current state" },
      ],
      description: "What no data means. For error counts, notBreaching: no errors reported is good news.",
    },
    { key: "actionsEnabled", label: "Actions enabled", type: "boolean", default: true, param: "ActionsEnabled" },
  ],
  columns: [
    { label: "State", path: "attributes.stateValue" },
    { label: "Metric", path: "config.metricName" },
    { label: "Threshold", path: "attributes.conditionText" },
  ],
  iam: {
    create: "cloudwatch:PutMetricAlarm",
    read: "cloudwatch:DescribeAlarms",
    update: "cloudwatch:PutMetricAlarm",
    delete: "cloudwatch:DeleteAlarms",
    arn: (r) => r.id,
  },
  invalidValue({ field, value }) {
    if (field.key === "period") return new EngineError("ValidationError", `Period must be 10, 20, 30 or a multiple of 60 (CloudLab supports 60 and up, not ${value})`);
    return undefined;
  },
  async validate({ config }) {
    const period = Number(config.period);
    if (period % 60 !== 0) throw new EngineError("ValidationError", "Period must be 10, 20, 30 or a multiple of 60");
    if (Number(config.evaluationPeriods) * period > 7 * 86400) {
      throw new EngineError("ValidationError", "Metrics cannot be checked across more than a week (EvaluationPeriods * Period must be <= 604800).");
    }
    if (config.datapointsToAlarm && Number(config.datapointsToAlarm) > Number(config.evaluationPeriods)) {
      throw new EngineError("ValidationError", "DatapointsToAlarm must be less than or equal to EvaluationPeriods.");
    }
  },
  async derive({ id, config, existing, ctx }) {
    const op = COMPARISONS.find((c) => c.value === config.comparisonOperator)?.label ?? "?";
    const changed = !!existing && JSON.stringify(existing.config) !== JSON.stringify(config);
    const history = (existing?.attributes.history as unknown[] | undefined) ?? [];
    const now = ctx.now().toISOString();
    return {
      ...(existing?.attributes ?? {}),
      alarmArn: id,
      conditionText: `${config.metricName} ${op} ${config.threshold} for ${config.datapointsToAlarm ?? config.evaluationPeriods} of ${config.evaluationPeriods} × ${Number(config.period) / 60} min`,
      stateValue: existing?.attributes.stateValue ?? "INSUFFICIENT_DATA",
      stateReason: existing?.attributes.stateReason ?? "Unchecked: Initial alarm creation",
      stateUpdatedTimestamp: existing?.attributes.stateUpdatedTimestamp ?? now,
      alarmConfigurationUpdatedTimestamp: changed || !existing ? now : existing.attributes.alarmConfigurationUpdatedTimestamp,
      history: existing
        ? changed
          ? [{ timestamp: now, type: "ConfigurationUpdate", summary: `Alarm "${config.name}" updated` }, ...history].slice(0, 50)
          : history
        : [{ timestamp: now, type: "ConfigurationUpdate", summary: `Alarm "${config.name}" created` }],
    };
  },
};

// ---------- dashboards ----------

export interface MetricWidgetLine {
  namespace: string;
  name: string;
  dimensions: { Name: string; Value: string }[];
  stat?: string;
  label?: string;
}

export interface DashboardWidget {
  type: "metric" | "text";
  title: string;
  /** metric widgets */
  lines: MetricWidgetLine[];
  stat: string;
  period: number;
  view: "timeSeries" | "singleValue";
  region?: string;
  /** text widgets */
  markdown?: string;
  width: number;
  height: number;
}

/** Parses a DashboardBody, expanding "." (same as the line above) in metric rows, as CloudWatch does. */
export function parseDashboardBody(body: string): DashboardWidget[] {
  const fail = (path: string, message: string) =>
    new EngineError(
      "InvalidParameterInput",
      `The dashboard body is invalid, there are 1 validation errors:\n[\n  {\n    "dataPath": "${path}",\n    "message": "${message}"\n  }\n]`,
    );
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw fail("", "Should be valid JSON");
  }
  const widgets = (doc as { widgets?: unknown }).widgets;
  if (!Array.isArray(widgets)) throw fail("", "Should have required property 'widgets'");
  if (widgets.length > 100) throw fail("/widgets", "Should NOT have more than 100 items");
  return widgets.map((w, i) => {
    const path = `/widgets/${i}`;
    if (!w || typeof w !== "object") throw fail(path, "Should be object");
    const { type, properties, width, height } = w as { type?: string; properties?: Record<string, unknown>; width?: number; height?: number };
    if (type !== "metric" && type !== "text") throw fail(`${path}/type`, "Should be equal to one of the allowed values: metric, text");
    if (!properties || typeof properties !== "object") throw fail(path, "Should have required property 'properties'");
    const size = { width: Math.min(24, Math.max(1, Number(width ?? 6))), height: Math.min(1000, Math.max(1, Number(height ?? 6))) };
    if (type === "text") {
      if (typeof properties.markdown !== "string") throw fail(`${path}/properties`, "Should have required property 'markdown'");
      return { type, title: "", lines: [], stat: "", period: 300, view: "timeSeries", markdown: properties.markdown, ...size };
    }
    const rows = properties.metrics;
    if (!Array.isArray(rows) || rows.length === 0) throw fail(`${path}/properties`, "Should have required property 'metrics'");
    let previous: unknown[] = [];
    const lines: MetricWidgetLine[] = rows.map((row, r) => {
      if (!Array.isArray(row)) throw fail(`${path}/properties/metrics/${r}`, "Should be array");
      const opts = row.length && typeof row[row.length - 1] === "object" ? (row[row.length - 1] as { stat?: string; label?: string }) : {};
      const values = (typeof row[row.length - 1] === "object" ? row.slice(0, -1) : row).map((v, k) => (v === "." ? previous[k] : v));
      previous = values;
      if (values.length < 2 || values.some((v) => typeof v !== "string")) throw fail(`${path}/properties/metrics/${r}`, "Should be [namespace, metricName, dimName, dimValue, ...]");
      const [namespace, name, ...rest] = values as string[];
      const dimensions = [];
      for (let k = 0; k + 1 < rest.length; k += 2) dimensions.push({ Name: rest[k], Value: rest[k + 1] });
      return { namespace, name, dimensions, stat: opts.stat, label: opts.label };
    });
    const period = Number(properties.period ?? 300);
    if (!Number.isInteger(period) || period < 60 || period % 60 !== 0) throw fail(`${path}/properties/period`, "Should be a multiple of 60");
    return {
      type,
      title: typeof properties.title === "string" ? properties.title : `${lines[0].name}`,
      lines,
      stat: typeof properties.stat === "string" ? properties.stat : "Average",
      period,
      view: properties.view === "singleValue" ? "singleValue" : "timeSeries",
      region: typeof properties.region === "string" ? properties.region : undefined,
      ...size,
    };
  });
}

export const EMPTY_DASHBOARD = JSON.stringify({ widgets: [] }, null, 2);

const dashboard: ResourceTypeDef = {
  service: "cloudwatch",
  type: "dashboard",
  label: "Dashboard",
  pluralLabel: "Dashboards",
  description: "Your own page of graphs: pick the metrics you care about (e.g. API requests and Lambda errors) and see them side by side.",
  idPrefix: "dashboard",
  global: true,
  makeId: ({ name, accountId }) => `arn:aws:cloudwatch::${accountNumber(accountId)}:dashboard/${name}`,
  idPattern: /^arn:aws:cloudwatch::\d{12}:dashboard\/[\w-]{1,255}$/,
  notFoundCode: "ResourceNotFound",
  notFoundMessage: () => "Dashboard does not exist",
  malformedCode: "ResourceNotFound",
  malformedMessage: () => "Dashboard does not exist",
  apiNoun: "dashboard",
  fields: [
    {
      key: "name",
      label: "Dashboard name",
      type: "string",
      required: true,
      immutable: true,
      maxLength: 255,
      pattern: "^[\\w-]+$",
      patternMessage: "Letters, numbers, - and _ only.",
      placeholder: "my-app",
      param: "DashboardName",
    },
    {
      key: "body",
      label: "Dashboard body (JSON)",
      type: "json",
      required: true,
      default: EMPTY_DASHBOARD,
      param: "DashboardBody",
      description: 'Widgets, as in the PutDashboard API: {"widgets":[{"type":"metric","properties":{"metrics":[["AWS/Lambda","Invocations","FunctionName","hello"]],"stat":"Sum","period":60}}]}. Easier: use "Add to dashboard" on any graph.',
    },
  ],
  columns: [{ label: "Widgets", path: "attributes.widgetCount" }],
  iam: {
    create: "cloudwatch:PutDashboard",
    read: "cloudwatch:GetDashboard",
    update: "cloudwatch:PutDashboard",
    delete: "cloudwatch:DeleteDashboards",
    arn: (r) => r.id,
  },
  async validate({ config }) {
    parseDashboardBody(String(config.body));
  },
  async derive({ config }) {
    return { widgetCount: parseDashboardBody(String(config.body)).length };
  },
};

export const cloudWatchService: ServiceDef = {
  id: "cloudwatch",
  label: "CloudWatch",
  modelledOn: "CloudWatch",
  description: "Metrics, alarms and dashboards for everything you run.",
  category: "Monitoring",
  types: [alarm, dashboard],
};
