import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Reads a dot path such as "config.cidrBlock" from an object. */
export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "–";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map((v) => formatValue(v)).join(", ") : "–";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Lower-cases a label for use mid-sentence while keeping acronyms:
 * "Security group" → "security group", "VPC" → "VPC", "VPCs" → "VPCs".
 */
export function inSentence(label: string): string {
  return label
    .split(" ")
    .map((word) => (/^[A-Z0-9]{2,}s?$/.test(word) ? word : word.toLowerCase()))
    .join(" ");
}

/** Makes the browser download `text` as a file, e.g. a key pair's private key. */
export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-pem-file" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Makes the browser download base64 data as a file. */
export function downloadBase64(filename: string, base64: string, contentType = "application/octet-stream") {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
