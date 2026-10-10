"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { REGIONS } from "@/engine/catalog";
import { resolveServices } from "@/engine/registry";
import { useConsoleStore } from "@/stores/console-store";
import { useGuideStore } from "@/stores/guide-store";
import type { ResourceDTO } from "@/engine/types";
import type { ReachabilityInput } from "@/engine/analysis/reachability";

export { queryKeys };

/** Poll quickly while anything is mid-transition (pending, stopping...), otherwise not at all. */
function transitionInterval(items: ResourceDTO[] | undefined) {
  return items?.some((r) => r.pendingState) ? 1500 : false;
}

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

export function useResources(service?: string, type?: string) {
  const region = useConsoleStore((s) => s.region);
  const filter = { service, type, region };
  return useQuery({
    queryKey: queryKeys.resources(filter),
    queryFn: async () => (await api.listResources(filter)).items,
    refetchInterval: (query) => transitionInterval(query.state.data),
  });
}

export function useResource(id: string) {
  return useQuery({
    queryKey: queryKeys.resource(id),
    queryFn: () => api.getResource(id),
    refetchInterval: (query) => transitionInterval(query.state.data ? [query.state.data.item] : undefined),
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
      toast.success(`Created ${item.id}`);
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
      toast.success(`Updated ${id}`);
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
      toast.success(`${item.id} is ${item.state}`);
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
      toast.success(`Deleted ${deleted}`);
    },
    onError,
  });
}
