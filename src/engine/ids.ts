import { customAlphabet } from "nanoid";

const hex = customAlphabet("0123456789abcdef", 17);

const upper = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 17);

/** IAM-style unique IDs such as "AIDAQ3EGRN5ZQ7XJ2L4MB" (prefix + 17 characters). */
export function iamId(prefix: string, length = 17): string {
  return `${prefix}${upper().slice(0, length)}`;
}

/** A stable fake 12-digit account number derived from the lab account ID. */
export function accountNumber(accountId: string): string {
  let h = 0;
  for (const ch of accountId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return String(100000000000 + (h % 900000000000)).padStart(12, "0");
}

/** Generates cloud-style IDs such as "vpc-0f3a9c2b7d14e6a85". */
export function generateId(prefix: string): string {
  return `${prefix}-${hex()}`;
}
