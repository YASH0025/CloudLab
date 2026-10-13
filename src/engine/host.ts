import type { Resource } from "./types";

/**
 * Where a service's resources and their data (DynamoDB items, SQS messages…) live.
 * The engine is one host (data kept with the resource, server-side); the CloudLab
 * agent is another (data kept as files on the learner's computer). The service's
 * rules, expressions and errors are the same code for both, so a table or queue on
 * My computer (local) behaves exactly like any other.
 */
export interface ServiceHost {
  get(accountId: string, id: string): Promise<Resource>;
  list(accountId: string, filter: { service?: string; type?: string; region?: string }): Promise<Resource[]>;
  setAttributes(accountId: string, id: string, patch: Record<string, unknown>): Promise<void>;
  now(): Date;
  /** Calls in the last windowMs for a key (throttling provisioned tables). */
  countInWindow(key: string, windowMs: number): Promise<number>;
  metrics: {
    record(accountId: string, region: string, namespace: string, name: string, dims: Record<string, string>, value: number, unit: string): Promise<void>;
  };
  /** True where the data really is: the agent, for resources on My computer (local). */
  readonly holdsLocalItems?: boolean;
  /**
   * Sends an HTTP request for an SNS http/https subscription. Only the agent has this:
   * CloudLab's servers never call out, the agent calls apps on the learner's network.
   */
  deliverHttp?(url: string, headers: Record<string, string>, body: string): Promise<{ status: number }>;
  /** Where SNS's own links (SubscribeURL, UnsubscribeURL) point: the agent's AWS endpoint. */
  readonly snsEndpoint?: string;
  /**
   * Running Lambda functions, for services that call them (SNS). The engine has it;
   * the agent doesn't yet, and leaving it out keeps the Lambda runtime out of the agent.
   */
  readonly lambda?: {
    allows(fn: Resource, service: string, sourceArn: string): boolean;
    invoke(accountId: string, fn: Resource, event: unknown, source: string): Promise<{ requestId: string; functionError?: string }>;
  };
}

/** DynamoDB's name for it. */
export type TableHost = ServiceHost;
