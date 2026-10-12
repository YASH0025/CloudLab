"use client";

import { createContext, useContext } from "react";
import type { ServiceCatalog } from "@/engine/resolve";

const CatalogContext = createContext<ServiceCatalog | null>(null);

/**
 * Hands the service catalogue (plain data, built on the server) to the console,
 * so the browser gets the definitions without downloading the engine's code.
 */
export function ServiceCatalogProvider({ catalog, children }: { catalog: ServiceCatalog; children: React.ReactNode }) {
  return <CatalogContext.Provider value={catalog}>{children}</CatalogContext.Provider>;
}

/** The catalogue, or null outside the console (then it's fetched from /api/services). */
export const useServiceCatalog = () => useContext(CatalogContext);
