/** TanStack Query keys, shared by client hooks and server-side prefetching. */
export const queryKeys = {
  services: (region: string) => ["services", region] as const,
  resources: (filter: { service?: string; type?: string; region?: string }) => ["resources", filter] as const,
  resource: (id: string) => ["resource", id] as const,
  guide: (region: string) => ["guide", region] as const,
  tutorial: (id: string, region: string) => ["guide", "tutorial", id, region] as const,
  objects: (bucket: string, prefix: string) => ["objects", bucket, prefix] as const,
};
