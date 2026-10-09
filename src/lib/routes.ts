export const routes = {
  console: () => "/console",
  terminal: () => "/console/terminal",
  list: (service: string, type: string) => `/console/${service}/${type}`,
  create: (service: string, type: string) => `/console/${service}/${type}/new`,
  detail: (service: string, type: string, id: string) =>
    `/console/${service}/${type}/${encodeURIComponent(id)}`,
  /** Create form with values filled in (read by the create page from ?prefill=). */
  createPrefilled: (service: string, type: string, prefill: Record<string, unknown>) =>
    `/console/${service}/${type}/new?prefill=${encodeURIComponent(JSON.stringify(prefill))}`,
  /** Terminal with a command placed on the prompt. */
  terminalWith: (command: string) => `/console/terminal?cmd=${encodeURIComponent(command)}`,
};
