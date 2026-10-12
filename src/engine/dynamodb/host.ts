import type { Resource } from "../types";

/**
 * Where tables and their items live. The engine is one host (items kept with the
 * table, server-side); the CloudLab agent is another (items kept as files on the
 * learner's computer). DynamoDB's rules, expressions and errors are the same code
 * for both, so a table on My computer (local) behaves exactly like any other.
 */
export interface TableHost {
  get(accountId: string, id: string): Promise<Resource>;
  list(accountId: string, filter: { service?: string; type?: string; region?: string }): Promise<Resource[]>;
  setAttributes(accountId: string, id: string, patch: Record<string, unknown>): Promise<void>;
  now(): Date;
  /** Calls in the last windowMs for a key (throttling provisioned tables). */
  countInWindow(key: string, windowMs: number): Promise<number>;
  metrics: {
    record(accountId: string, region: string, namespace: string, name: string, dims: Record<string, string>, value: number, unit: string): Promise<void>;
  };
  /** True where the items really are: the agent for tables on My computer (local). */
  readonly holdsLocalItems?: boolean;
}
