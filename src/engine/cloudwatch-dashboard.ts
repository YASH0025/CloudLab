import { EngineError } from "./errors";

/** CloudWatch dashboards: the DashboardBody format, shared by the engine and the console's dashboard view. */

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
