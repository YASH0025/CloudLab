import { intToIp, ipToInt, parseCidr, usableHosts } from "../cidr";
import { EngineError } from "../errors";
import type { Resource } from "../types";

/** Lists the account's active resources of a type in the current region. */
export type Lister = (service: string, type: string) => Promise<Resource[]>;

/**
 * A public IP the account isn't already using. Addresses come from 203.0.113.0/24,
 * a range reserved for documentation, so they are clearly not real.
 */
export async function freePublicIp(list: Lister): Promise<string> {
  const used = new Set(
    [...(await list("compute", "instance")), ...(await list("compute", "elastic-ip"))]
      .map((r) => r.attributes.publicIp)
      .filter(Boolean),
  );
  const start = Math.floor(Math.random() * 254);
  for (let i = 0; i < 254; i++) {
    const ip = `203.0.113.${1 + ((start + i) % 254)}`;
    if (!used.has(ip)) return ip;
  }
  throw new EngineError("AddressLimitExceeded", "The maximum number of addresses has been reached.");
}

/** The lowest free private address in a subnet. Instances and NAT gateways each take one. */
export async function nextPrivateIp(list: Lister, subnet: Resource): Promise<string | null> {
  const block = parseCidr(subnet.config.cidrBlock as string);
  if (!block) return null;
  const holders = [...(await list("compute", "instance")), ...(await list("networking", "nat-gateway"))];
  const used = new Set(
    holders
      .filter((r) => r.config.subnetId === subnet.id)
      .map((r) => ipToInt(String(r.attributes.privateIp ?? "")))
      .filter((n): n is number => n !== null),
  );
  const hosts = usableHosts(block);
  for (let ip = hosts.first; ip <= hosts.last; ip++) if (!used.has(ip)) return intToIp(ip);
  throw new EngineError(
    "InsufficientFreeAddressesInSubnet",
    `There are not enough free addresses in subnet '${subnet.id}' to satisfy the requested number of instances.`,
  );
}
