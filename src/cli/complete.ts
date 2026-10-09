import { COMMANDS } from "./commands";

/** Option names for a command, read from its usage string. */
function optionsFor(service: string, operation: string): string[] {
  const usage = COMMANDS.find((c) => c.service === service && c.operation === operation)?.usage ?? "";
  return [...new Set([...usage.matchAll(/--[a-z0-9-]+/g)].map((m) => m[0]).concat("--region"))];
}

/**
 * Tab completion for the terminal: services, operations and option names.
 * Returns the candidates that match the word being typed.
 */
export function complete(line: string): { word: string; candidates: string[] } {
  const parts = line.split(/\s+/);
  const word = parts[parts.length - 1] ?? "";
  const before = parts.slice(0, -1).filter(Boolean);

  let pool: string[] = [];
  if (before.length === 0) pool = ["aws", "help", "clear"];
  else if (before[0] !== "aws") pool = [];
  else if (before.length === 1) pool = [...new Set(COMMANDS.map((c) => c.service))];
  else if (before.length === 2) pool = COMMANDS.filter((c) => c.service === before[1]).map((c) => c.operation);
  else if (word.startsWith("-")) pool = optionsFor(before[1], before[2]);

  return { word, candidates: pool.filter((p) => p.startsWith(word)).sort() };
}

/** Longest common prefix of the candidates, for completing as far as is unambiguous. */
export function commonPrefix(words: string[]): string {
  if (words.length === 0) return "";
  let prefix = words[0];
  for (const w of words.slice(1)) {
    while (!w.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}
