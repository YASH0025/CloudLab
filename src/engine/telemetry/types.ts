/** Shapes shared by the metric and log stores. */

export interface MetricPoint {
  /** Start of the minute. */
  minute: Date;
  sum: number;
  count: number;
  min: number;
  max: number;
  unit: string;
}

export interface MetricKey {
  accountId: string;
  region: string;
  namespace: string;
  name: string;
  /** Canonical "Name=value|Other=value", sorted by name; "" for none. */
  dimensions: string;
}

export interface MetricId {
  namespace: string;
  name: string;
  dimensions: string;
  unit: string;
}

export interface LogEvent {
  id: number;
  stream: string;
  timestamp: number;
  ingestedAt: number;
  message: string;
}

export interface LogStreamInfo {
  stream: string;
  firstEventTimestamp: number;
  lastEventTimestamp: number;
  lastIngestionTime: number;
  storedBytes: number;
}

export interface LogQuery {
  accountId: string;
  region: string;
  group: string;
  streams?: string[];
  from?: number;
  to?: number;
  /** Return events after this ID (pagination). */
  afterId?: number;
  limit: number;
  /** Oldest first (true) or newest first. */
  ascending: boolean;
}

/** Events kept per log group; older ones are dropped. */
export const MAX_EVENTS_PER_GROUP = 2_000;
/** Metric datapoints older than this are dropped (CloudWatch keeps 1-minute data for 15 days). */
export const METRIC_RETENTION_MS = 15 * 24 * 60 * 60_000;
