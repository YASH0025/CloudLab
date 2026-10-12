"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError, type MetricQuery, type QueueActionInput, type TableItemsInput } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { REGIONS } from "@/engine/catalog";
import { resolveServices } from "@/engine/registry";
import { useConsoleStore } from "@/stores/console-store";
import { useGuideStore } from "@/stores/guide-store";
import type { ResourceDTO } from "@/engine/types";
import type { ReachabilityInput } from "@/engine/analysis/reachability";
import type { DbConnectInput } from "@/engine/analysis/dbconnect";

export { queryKeys };

/** Poll quickly while anything is mid-transition (pending, stopping...), otherwise not at all. */
function transitionInterval(items: ResourceDTO[] | undefined) {
  return items?.some((r) => r.pendingState) ? 1500 : false;
}

/** How a resource is named in messages: ARN-identified resources (load balancers, databases) by their name. */
const shortName = (id: string, name?: string) => (id.startsWith("arn:") ? name || id.split(/[:/]/).pop() || id : id);

/** Load balancing and Auto Scaling change on their own (health checks, scaling), so their pages stay live. */
const LIVE_TYPES = new Set(["auto-scaling-group", "target-group", "load-balancer"]);
// Databases poll only while changing state (creating, modifying, rebooting…), like other resources.

/**
 * The service catalogue is static data, so it's computed in place rather than fetched.
 * That way the server and the browser render exactly the same thing on first load.
 */
export function useServices() {
  const region = useConsoleStore((s) => s.region);
  return useQuery({
    queryKey: queryKeys.services(region),
    queryFn: () => api.services(region),
    initialData: () => ({ region, regions: REGIONS, services: resolveServices(region) }),
    // Never stale, so TanStack Query doesn't need the clock (prerendering can't read it).
    initialDataUpdatedAt: 0,
    staleTime: "static",
  });
}

export function useTypeDef(service: string, type: string) {
  const services = useServices();
  const svc = services.data?.services.find((s) => s.id === service);
  return { ...services, service: svc, typeDef: svc?.types.find((t) => t.type === type) };
}

export function useResources(service?: string, type?: string, options: { live?: boolean } = {}) {
  const region = useConsoleStore((s) => s.region);
  const filter = { service, type, region };
  return useQuery({
    queryKey: queryKeys.resources(filter),
    queryFn: async () => (await api.listResources(filter)).items,
    refetchInterval: (query) => (options.live ? 2500 : transitionInterval(query.state.data)),
  });
}

export function useResource(id: string) {
  return useQuery({
    queryKey: queryKeys.resource(id),
    queryFn: () => api.getResource(id),
    refetchInterval: (query) => {
      const item = query.state.data?.item;
      if (item && LIVE_TYPES.has(item.type)) return 2500;
      return transitionInterval(item ? [item] : undefined);
    },
  });
}

/** A target group's health checks, kept live. */
export function useTargetHealth(id: string) {
  return useQuery({
    queryKey: ["target-health", id],
    queryFn: async () => (await api.targetHealth(id)).targets,
    refetchInterval: 2500,
  });
}

/** Metric series for the console's graphs, refreshed every 15 seconds. */
export function useMetricSeries(queries: MetricQuery[], minutes: number) {
  const region = useConsoleStore((s) => s.region);
  return useQuery({
    queryKey: ["metrics", region, minutes, queries],
    queryFn: () => api.metrics({ region, minutes, queries }),
    enabled: queries.length > 0,
    refetchInterval: 15_000,
  });
}

/** Writes a file onto a volume "from its server". Errors show inline. */
export function useWriteVolumeFile(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { path: string; content: string }) => api.writeVolumeFile(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.resource(id) }),
  });
}

/** The region's network, drawn as VPCs → zones → subnets, refreshed every 10 seconds. */
export function useDiagram() {
  const region = useConsoleStore((s) => s.region);
  return useQuery({ queryKey: ["diagram", region], queryFn: async () => (await api.diagram(region)).diagram, refetchInterval: 10_000 });
}

/** The learner's saved progress (tutorials and challenges), kept with their lab on the server. */
export function useProgress() {
  return useQuery({ queryKey: ["progress"], queryFn: async () => (await api.progress()).progress, staleTime: 30_000 });
}

/** Saves a tutorial step or a challenge result. Best effort: progress also lives in the browser. */
export function useSaveProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.saveProgress,
    onSuccess: ({ progress }) => qc.setQueryData(["progress"], progress),
  });
}

export function useChallenges() {
  return useQuery({ queryKey: ["challenges"], queryFn: async () => (await api.challenges()).challenges, staleTime: Infinity });
}

/** The current challenge, re-checked every 5 seconds until it's solved. */
export function useChallenge(id: string, hints: number) {
  return useQuery({
    queryKey: ["challenge", id, hints],
    queryFn: async () => (await api.challenge(id, hints)).challenge,
    refetchInterval: (q) => (q.state.data?.solved ? false : 5_000),
  });
}

/** Builds a challenge's broken setup in the challenge account and switches the console to it. */
export function useStartChallenge() {
  const qc = useQueryClient();
  const setChallenge = useConsoleStore((s) => s.setChallenge);
  const setRegion = useConsoleStore((s) => s.setRegion);
  return useMutation({
    mutationFn: (id: string) => api.startChallenge(id),
    onSuccess: ({ challenge }) => {
      setChallenge({ id: challenge.id, startedAt: Date.now(), hintsUsed: 0 });
      setRegion(challenge.region);
      // Everything cached so far belongs to the other workspace.
      qc.resetQueries();
    },
    onError,
  });
}

/** Asks the resolver about a name (and optionally fetches it like curl). Errors show inline. */
export function useDnsTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; type: string; http: boolean; path?: string }) => api.dnsTest(input),
    // A request through a hosted zone is remembered on the zone.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["resource"] }),
  });
}

/** A health check's current result, refreshed every 10 seconds. */
export function useHealthCheckStatus(id: string) {
  return useQuery({ queryKey: ["health-check-status", id], queryFn: () => api.healthCheckStatus(id), refetchInterval: 10_000 });
}

/** A log group's recent events (optionally filtered), refreshed every 5 seconds. */
export function useLogEvents(group: string, pattern: string, stream: string | null, minutes: number) {
  const region = useConsoleStore((s) => s.region);
  return useQuery({
    queryKey: ["log-events", region, group, pattern, stream, minutes],
    queryFn: async () => (await api.logEvents({ region, group, pattern, stream: stream ?? undefined, minutes })).events,
    refetchInterval: 5_000,
  });
}

export function useLogStreams(group: string) {
  const region = useConsoleStore((s) => s.region);
  return useQuery({
    queryKey: ["log-streams", region, group],
    queryFn: async () => (await api.logStreams(region, group)).streams,
    refetchInterval: 5_000,
  });
}

/** Publishes a message to a topic. Errors show inline in the panel. */
export function usePublish(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.publish>[1]) => api.publish(id, input).then((r) => r.result),
    // Deliveries change the topic, its subscriptions' inboxes and maybe a function.
    onSettled: () => qc.invalidateQueries({ queryKey: ["resource"] }),
  });
}

/** A queue's message counts, kept live while its page is open. */
export function useQueueCounts(id: string) {
  return useQuery({ queryKey: ["queue-counts", id], queryFn: () => api.queueCounts(id).then((r) => r.counts), refetchInterval: 3_000 });
}

/** Send, poll, delete, purge or subscribe-to-topic on a queue. Errors show inline. */
export function useQueueAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: QueueActionInput) => api.queueAction(id, input),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["queue-counts"] });
      qc.invalidateQueries({ queryKey: ["resource"] });
      qc.invalidateQueries({ queryKey: ["resources"] });
    },
  });
}

/** Scan, query, save or delete items in a table. Errors show inline. */
export function useTableItems(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TableItemsInput) => api.tableItems(id, input),
    onSettled: (_d, _e, input) => {
      if (input.action === "put" || input.action === "delete") {
        qc.invalidateQueries({ queryKey: queryKeys.resource(id) });
        qc.invalidateQueries({ queryKey: ["resources"] });
      }
    },
  });
}

/** Follows the "Confirm subscription" link in a confirmation email. */
export function useConfirmSubscription(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.confirmSubscription(id),
    onSuccess: () => {
      toast.success("Subscription confirmed");
      qc.invalidateQueries({ queryKey: ["resource"] });
      qc.invalidateQueries({ queryKey: ["resources"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
}

/** Runs a function with a test event. Errors show inline in the panel. */
export function useInvoke(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (event: unknown) => api.invoke(id, event).then((r) => r.result),
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.resource(id) }),
  });
}

/** Adds or removes a statement in a function's resource-based policy. */
export function usePermission(id: string) {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: queryKeys.resource(id) });
  const add = useMutation({
    mutationFn: (input: { statementId: string; principal: string; sourceArn?: string }) => api.addPermission(id, input),
    onSuccess: () => {
      done();
      toast.success("Permission added");
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (statementId: string) => api.removePermission(id, statementId),
    onSuccess: () => {
      done();
      toast.success("Permission removed");
    },
    onError,
  });
  return { add, remove };
}

/** Checks a connection to a database. Errors show inline in the panel. */
export function useDbConnect(id: string) {
  return useMutation({
    mutationFn: (input: DbConnectInput) => api.dbConnect(id, input).then((r) => r.result),
  });
}

/** Sends simulated requests to a load balancer. Errors show inline in the panel. */
export function useTestRequests(id: string) {
  return useMutation({
    mutationFn: (input: { port?: number; count?: number }) => api.testRequests(id, input).then((r) => r.result),
  });
}

function onError(error: unknown) {
  if (error instanceof ApiError) {
    toast.error(error.code, { description: error.message });
    // Remember it so the guide can explain what went wrong.
    useGuideStore.getState().setLastError({ code: error.code, message: error.message });
  } else toast.error("Request failed", { description: String(error) });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["identities"] });
    qc.invalidateQueries({ queryKey: ["iam-policies"] });
    qc.invalidateQueries({ queryKey: ["resources"] });
    qc.invalidateQueries({ queryKey: ["resource"] });
    qc.invalidateQueries({ queryKey: ["guide"] });
  };
}

/** "What's next?" advice for the current region. Polls while the next step is just waiting. */
export function useGuide(enabled: boolean) {
  const region = useConsoleStore((s) => s.region);
  return useQuery({
    queryKey: queryKeys.guide(region),
    queryFn: async () => (await api.guide(region)).advice,
    enabled,
    refetchInterval: (query) => (query.state.data?.next.waiting ? 1500 : false),
  });
}

export function useCreateResource(service: string, type: string) {
  const region = useConsoleStore((s) => s.region);
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (config: Record<string, unknown>) => api.createResource({ service, type, region, config }),
    onSuccess: ({ item }) => {
      invalidate();
      toast.success(`Created ${shortName(item.id, item.name)}`);
    },
    onError,
  });
}

export function useUpdateResource(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (config: Record<string, unknown>) => api.updateResource(id, config),
    onSuccess: () => {
      invalidate();
      toast.success(`Updated ${shortName(id)}`);
    },
    onError,
  });
}

export function useResourceAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => api.runAction(id, action),
    onSuccess: ({ item }) => {
      invalidate();
      toast.success(`${shortName(item.id, item.name)} is ${item.state}`);
    },
    onError,
  });
}

export function useTutorials() {
  return useQuery({
    queryKey: ["tutorials"],
    queryFn: async () => (await api.tutorials()).tutorials,
    staleTime: Infinity,
  });
}

/** A tutorial with each step checked against the learner's resources. Polls gently while being followed. */
export function useTutorial(id: string | null) {
  const region = useConsoleStore((s) => s.region);
  return useQuery({
    queryKey: queryKeys.tutorial(id ?? "", region),
    queryFn: async () => (await api.tutorial(id!, region)).tutorial,
    enabled: !!id,
    refetchInterval: 2500,
  });
}

/** Runs a reachability check. Errors show inline in the panel rather than as a toast. */
export function useReachability(id: string) {
  return useMutation({
    mutationFn: (input: ReachabilityInput) => api.checkReachability(id, input).then((r) => r.result),
  });
}

/** Who's signed in and which sign-in options exist. */
export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });
}

/** Deletes everything in the current region. The default VPC is recreated, and tutorial progress starts over. */
export function useResetLab() {
  const region = useConsoleStore((s) => s.region);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.resetLab(region),
    onSuccess: ({ removed }) => {
      qc.invalidateQueries();
      useGuideStore.setState({ progress: {}, activeTutorial: null, lastError: null });
      toast.success(`Lab reset: removed ${removed} resource${removed === 1 ? "" : "s"} in ${region}`);
    },
    onError,
  });
}

export function useDeleteResource() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.deleteResource(id),
    onSuccess: ({ deleted }) => {
      invalidate();
      toast.success(`Deleted ${shortName(deleted)}`);
    },
    onError,
  });
}

// ---------- bucket objects ----------

export function useObjects(bucket: string, prefix: string) {
  return useQuery({ queryKey: queryKeys.objects(bucket, prefix), queryFn: () => api.listObjects(bucket, prefix) });
}

/** Refreshes everything that shows a bucket's objects: the listing, the bucket's counts and the guide. */
function useObjectsChanged() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["objects"] });
    qc.invalidateQueries({ queryKey: ["resource"] });
    qc.invalidateQueries({ queryKey: ["resources"] });
    qc.invalidateQueries({ queryKey: ["guide"] });
  };
}

/** Uploads files into a "folder" (key prefix), one after another. */
export function useUploadObjects(bucket: string) {
  const changed = useObjectsChanged();
  return useMutation({
    mutationFn: async ({ files, prefix }: { files: File[]; prefix: string }) => {
      const done: string[] = [];
      for (const file of files) {
        // Folders dropped or picked keep their structure (webkitRelativePath is "folder/file.txt").
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        await api.putObject(bucket, prefix + rel, file);
        done.push(rel);
      }
      return done;
    },
    onSuccess: (done) => toast.success(done.length === 1 ? `Uploaded ${done[0]}` : `Uploaded ${done.length} files`),
    onError,
    onSettled: changed,
  });
}

export function useCreateFolder(bucket: string) {
  const changed = useObjectsChanged();
  return useMutation({
    // The console makes a folder the way S3's does: an empty object whose key ends in "/".
    mutationFn: (key: string) => api.putObject(bucket, key.endsWith("/") ? key : `${key}/`, new Blob([]), "application/x-directory"),
    onSuccess: (r) => toast.success(`Created folder ${r.object.key}`),
    onError,
    onSettled: changed,
  });
}

export function useDeleteObjects(bucket: string) {
  const changed = useObjectsChanged();
  return useMutation({
    mutationFn: async ({ keys, prefixes }: { keys: string[]; prefixes: string[] }) => {
      for (const key of keys) await api.deleteObject(bucket, key);
      for (const p of prefixes) await api.deletePrefix(bucket, p);
      return keys.length + prefixes.length;
    },
    onSuccess: (n) => toast.success(n === 1 ? "Deleted" : `Deleted ${n} items`),
    onError,
    onSettled: changed,
  });
}

// ---------- IAM ----------

export function useIamPolicies() {
  return useQuery({ queryKey: ["iam-policies"], queryFn: () => api.iamPolicies().then((r) => r.policies) });
}

/** Users and roles to act as (listed as root, so switching back is always possible). */
export function useIdentities() {
  return useQuery({
    queryKey: ["identities"],
    queryFn: async () => {
      const [users, roles] = await Promise.all([api.listAsRoot("iam", "user"), api.listAsRoot("iam", "role")]);
      return { users: users.items, roles: roles.items };
    },
  });
}

export function useSimulate() {
  return useMutation({ mutationFn: api.simulate });
}
