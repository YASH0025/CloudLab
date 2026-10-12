import type { Engine } from "@/engine/engine";
import type { StackEvent, StackResource } from "@/engine/cloudformation/deploy";
import type { Resource } from "@/engine/types";

/** The stack the CloudFormation tutorial suggests. */
export const TUTORIAL_STACK = "orders-stack";

/** What the CloudFormation tutorial looks at. */
export interface IacState {
  stack?: Resource;
  /** The stack's queue, as it is now. */
  queue?: Resource;
  /** The stack has been updated successfully at least once. */
  updated: boolean;
  /** A resource was replaced in an update (its creation shows up during an update). */
  replaced: boolean;
  /** An update failed and was rolled back. */
  rolledBack: boolean;
}

export async function loadIac(engine: Engine, accountId: string, region: string): Promise<IacState> {
  const stacks = await engine.list(accountId, { service: "cloudformation", type: "stack", region });
  const stack = stacks.find((s) => s.name === TUTORIAL_STACK) ?? stacks[0];
  const events = (stack?.attributes.events as StackEvent[] | undefined) ?? [];
  const resources = (stack?.attributes.resources as StackResource[] | undefined) ?? [];
  const q = resources.find((r) => r.type === "AWS::SQS::Queue");
  const queue = q?.resourceId ? ((await engine.get(accountId, q.resourceId).catch(() => null)) ?? undefined) : undefined;
  return {
    stack,
    queue,
    updated: events.some((e) => e.logicalId === stack?.name && e.status === "UPDATE_COMPLETE"),
    replaced: events.some((e) => e.reason?.startsWith("Requested update requires the creation of a new physical resource")),
    rolledBack: events.some((e) => e.logicalId === stack?.name && e.status === "UPDATE_ROLLBACK_COMPLETE"),
  };
}
