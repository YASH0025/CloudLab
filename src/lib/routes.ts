export const routes = {
  console: () => "/console",
  terminal: () => "/console/terminal",
  list: (service: string, type: string) => `/console/${service}/${type}`,
  create: (service: string, type: string) => `/console/${service}/${type}/new`,
  detail: (service: string, type: string, id: string) =>
    `/console/${service}/${type}/${encodeURIComponent(id)}`,
};
