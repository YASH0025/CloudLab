import type { Resource } from "./types";

/**
 * State is computed from timestamps instead of background jobs, so it works
 * on serverless hosting: a resource stores where it is heading and when it
 * gets there, and every read settles it if that moment has passed.
 */
export function settle(resource: Resource, now: Date = new Date()): { resource: Resource; changed: boolean } {
  if (!resource.pendingState || !resource.transitionAt) return { resource, changed: false };
  if (new Date(resource.transitionAt).getTime() > now.getTime()) return { resource, changed: false };
  return {
    resource: {
      ...resource,
      state: resource.pendingState,
      pendingState: null,
      transitionAt: null,
      updatedAt: resource.transitionAt,
    },
    changed: true,
  };
}

/** Puts a resource into `via` now and schedules it to reach `to` after `afterMs`. */
export function scheduleTransition(
  resource: Resource,
  opts: { via?: string; to: string; afterMs?: number },
  now: Date = new Date(),
): Resource {
  const delay = opts.afterMs ?? 0;
  if (!opts.via || delay <= 0) {
    return { ...resource, state: opts.to, pendingState: null, transitionAt: null, updatedAt: now.toISOString() };
  }
  return {
    ...resource,
    state: opts.via,
    pendingState: opts.to,
    transitionAt: new Date(now.getTime() + delay).toISOString(),
    updatedAt: now.toISOString(),
  };
}
