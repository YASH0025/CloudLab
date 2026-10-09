/** Small IPv4 / CIDR helpers used by networking validation. */

export interface Cidr {
  network: number; // unsigned 32-bit
  prefix: number;
}

export function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function maskFor(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** Parses "10.0.0.0/16". Returns null if the text is not a valid CIDR. */
export function parseCidr(text: string): (Cidr & { ip: number }) | null {
  const match = /^([\d.]+)\/(\d{1,2})$/.exec(text.trim());
  if (!match) return null;
  const ip = ipToInt(match[1]);
  const prefix = Number(match[2]);
  if (ip === null || prefix < 0 || prefix > 32) return null;
  return { ip, network: (ip & maskFor(prefix)) >>> 0, prefix };
}

/** The correctly aligned form of a CIDR, e.g. "10.0.0.5/16" -> "10.0.0.0/16". */
export function normalizeCidr(text: string): string | null {
  const c = parseCidr(text);
  return c ? `${intToIp(c.network)}/${c.prefix}` : null;
}

export function cidrSize(prefix: number): number {
  return 2 ** (32 - prefix);
}

export function cidrRange(c: Cidr): { first: number; last: number } {
  return { first: c.network, last: c.network + cidrSize(c.prefix) - 1 };
}

/** True if `inner` lies entirely within `outer`. */
export function cidrContains(outer: Cidr, inner: Cidr): boolean {
  const o = cidrRange(outer);
  const i = cidrRange(inner);
  return inner.prefix >= outer.prefix && i.first >= o.first && i.last <= o.last;
}

export function cidrOverlaps(a: Cidr, b: Cidr): boolean {
  const x = cidrRange(a);
  const y = cidrRange(b);
  return x.first <= y.last && y.first <= x.last;
}

/**
 * Usable host addresses in a subnet. Like the real thing, the first four
 * addresses and the last one are reserved by the platform.
 */
export function usableHosts(c: Cidr): { first: number; last: number; count: number } {
  const { first, last } = cidrRange(c);
  const usableFirst = first + 4;
  const usableLast = last - 1;
  return { first: usableFirst, last: usableLast, count: Math.max(0, usableLast - usableFirst + 1) };
}
