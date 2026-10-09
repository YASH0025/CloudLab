import { customAlphabet } from "nanoid";

const hex = customAlphabet("0123456789abcdef", 17);

/** Generates cloud-style IDs such as "vpc-0f3a9c2b7d14e6a85". */
export function generateId(prefix: string): string {
  return `${prefix}-${hex()}`;
}
