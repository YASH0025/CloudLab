import { isRegion } from "@/engine/catalog";
import { EngineError } from "@/engine/errors";
import { Args, COMMANDS, findCommand, servicesList, type CliContext } from "./commands";
import { parseAws, tokenize, UsageError } from "./parse";

export interface CliResult {
  output: string;
  /** Same convention as the real CLI: 0 ok, 252 usage error, 254 service error, 255 other. */
  exitCode: number;
  /** True when the command changed resources, so the console should refresh. */
  changed: boolean;
}

// The real CLI prints this block before every usage error.
const USAGE = [
  "usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]",
  "To see help text, you can run:",
  "",
  "  aws help",
  "  aws <command> help",
  "  aws <command> <subcommand> help",
  "",
].join("\n");

function usageError(message: string): CliResult {
  return { output: `${USAGE}\naws: error: ${message}`, exitCode: 252, changed: false };
}

/** Options every command accepts besides those in its usage line. */
const COMMON_OPTIONS = ["tag-specifications", "filters", "dry-run", "cli-input-json", "no-paginate", "debug"];

function allowedOptions(usage: string | undefined): Set<string> {
  const fromUsage = [...(usage ?? "").matchAll(/--(?:no-)?([a-z0-9-]+)/g)].flatMap((m) => [m[1], `no-${m[1]}`]);
  return new Set([...fromUsage, ...COMMON_OPTIONS]);
}

function helpText(service?: string): string {
  if (service) {
    const ops = COMMANDS.filter((c) => c.service === service);
    const width = Math.max(...ops.map((c) => c.operation.length));
    return [
      `Available ${service} commands in CloudLab:`,
      "",
      ...ops.map((c) => `  ${c.operation.padEnd(width)}  ${c.summary}`),
      "",
      `Run 'aws ${service} <command> help' for its options.`,
    ].join("\n");
  }
  return [
    "CloudLab CLI: a simulated AWS CLI. Nothing here touches a real cloud account.",
    "",
    "Supported services:",
    ...servicesList().map((s) => `  aws ${s} help`),
    "",
    "Global options: --region <region>",
    "Terminal keys: ↑/↓ history, Ctrl+C cancel line, Ctrl+L or 'clear' to clear.",
    "",
    "Try:",
    "  aws ec2 create-vpc --cidr-block 10.0.0.0/16",
    "  aws ec2 describe-vpcs",
    "  aws s3 mb s3://my-first-bucket-123",
  ].join("\n");
}

/** Runs one command line against the simulated cloud. */
export async function executeCli(line: string, ctx: CliContext): Promise<CliResult> {
  let tokens: string[];
  try {
    tokens = tokenize(line);
  } catch (e) {
    return usageError((e as Error).message);
  }
  if (tokens.length === 0) return { output: "", exitCode: 0, changed: false };
  if (tokens[0] === "help" || (tokens[0] === "aws" && (tokens.length === 1 || tokens[1] === "help"))) {
    return { output: helpText(), exitCode: 0, changed: false };
  }
  if (tokens[0] !== "aws") {
    return { output: `${tokens[0]}: command not found. Commands start with 'aws' (try 'help').`, exitCode: 127, changed: false };
  }
  if (tokens[2] === "help" && tokens.length === 3) {
    if (!servicesList().includes(tokens[1])) return usageError(`argument command: Invalid choice: '${tokens[1]}'`);
    return { output: helpText(tokens[1]), exitCode: 0, changed: false };
  }

  let parsed;
  try {
    parsed = parseAws(tokens);
  } catch (e) {
    return usageError((e as Error).message);
  }

  if (!servicesList().includes(parsed.service)) {
    return usageError(`argument command: Invalid choice, valid choices are:\n\n${servicesList().join(" | ")}`);
  }
  const command = findCommand(parsed.service, parsed.operation);
  if (!command) {
    const ops = COMMANDS.filter((c) => c.service === parsed.service).map((c) => c.operation);
    return usageError(`argument operation: Invalid choice, valid choices are:\n\n${ops.join(" | ")}`);
  }

  // Like the real CLI, unknown options are rejected before anything is sent.
  const allowed = allowedOptions(command.usage);
  const unknown = [...parsed.options.keys()].filter((o) => !allowed.has(o));
  if (unknown.length > 0) {
    return { output: `${USAGE}\nUnknown options: ${unknown.map((o) => `--${o}`).join(", ")}`, exitCode: 252, changed: false };
  }
  if (parsed.positionals[0] === "help") {
    return {
      output: `aws ${command.service} ${command.operation} ${command.usage ?? ""}\n\n${command.summary}.`,
      exitCode: 0,
      changed: false,
    };
  }

  const region = parsed.region ?? ctx.region;
  if (!isRegion(region)) {
    return {
      output: `Could not connect to the endpoint URL: "https://${parsed.service}.${region}.cloudlab.local/"\n(CloudLab regions: us-east-1, us-west-2, eu-west-1, ap-south-1)`,
      exitCode: 255,
      changed: false,
    };
  }

  if (parsed.options.has("dry-run") && command.service === "ec2" && command.mutates) {
    return {
      output: `\nAn error occurred (DryRunOperation) when calling the ${command.apiName} operation: Request would have succeeded, but DryRun flag is set.`,
      exitCode: 254,
      changed: false,
    };
  }

  try {
    const result = await command.run(new Args(parsed.options, parsed.positionals), { ...ctx, region });
    const output = result === undefined ? "" : typeof result === "string" ? result : JSON.stringify(result, null, 4);
    return { output, exitCode: 0, changed: command.mutates };
  } catch (e) {
    if (e instanceof UsageError) return usageError(e.message);
    if (e instanceof EngineError) {
      const prefix = command.service === "s3" ? `${command.operation === "mb" ? "make_bucket" : "remove_bucket"} failed: ${parsed.positionals[0]} ` : "\n";
      return {
        output: `${prefix}An error occurred (${e.code}) when calling the ${command.apiName} operation: ${e.message}`,
        exitCode: command.service === "s3" ? 1 : 254,
        // A failed command may still have changed something earlier (e.g. run-instances --count).
        changed: command.mutates,
      };
    }
    throw e;
  }
}
