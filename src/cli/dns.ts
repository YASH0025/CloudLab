import { resolve, type DnsRecord } from "@/engine/route53/dns";
import { RECORD_TYPES } from "@/engine/services/route53";
import type { CliContext } from "./commands";
import type { CliResult } from "./execute";

/**
 * `dig` and `nslookup` for the terminal. They ask CloudLab's resolver, which
 * answers from your Route 53 hosted zones and the names AWS gives your load
 * balancers, APIs and S3 websites. Output follows the real tools.
 */

const QUERY_TYPES = new Set<string>([...RECORD_TYPES, "ANY"]);
const ok = (output: string): CliResult => ({ output, exitCode: 0, changed: false });

const line = (r: DnsRecord) => {
  const name = r.name.endsWith(".") ? r.name : `${r.name}.`;
  return `${name.padEnd(24)}\t${r.ttl}\tIN\t${r.type}\t${r.value}`;
};

const when = (d: Date) => {
  const s = d.toUTCString(); // "Sun, 11 Oct 2026 14:00:00 GMT"
  const [, day, month, year, time] = /^\w+, (\d+) (\w+) (\d+) ([\d:]+)/.exec(s) ?? [];
  return `${s.slice(0, 3)} ${month} ${day.padStart(2, " ")} ${time} UTC ${year}`;
};

export async function runDig(tokens: string[], ctx: CliContext): Promise<CliResult> {
  let short = false;
  let name: string | undefined;
  let type = "A";
  for (const t of tokens.slice(1)) {
    if (t === "+short") short = true;
    else if (t.startsWith("+") || t.startsWith("@")) continue; // +noall, +answer, @8.8.8.8: accepted, no effect here
    else if (t === "-t") continue;
    else if (t.startsWith("-")) return { output: `Invalid option: ${t}\nUsage:  dig [@server] [-t type] [+short] name [type]`, exitCode: 1, changed: false };
    else if (QUERY_TYPES.has(t.toUpperCase()) && name !== undefined) type = t.toUpperCase();
    else if (name === undefined) name = t;
    else if (QUERY_TYPES.has(t.toUpperCase())) type = t.toUpperCase();
  }
  if (!name) return ok("; <<>> DiG 9.18.28 <<>>\n;; global options: +cmd\n(give a name to look up, e.g. dig www.myshop.com)");
  if (type === "ANY") type = "A";

  const r = await resolve(ctx.engine, ctx.accountId, name, type);
  if (short) return ok(r.answers.map((a) => a.value).join("\n"));
  const q = r.question.name.endsWith(".") ? r.question.name : `${r.question.name}.`;
  const id = Math.floor(Math.random() * 65535);
  const out = [
    "",
    `; <<>> DiG 9.18.28 <<>> ${name}${type !== "A" ? ` ${type}` : ""}`,
    ";; global options: +cmd",
    ";; Got answer:",
    `;; ->>HEADER<<- opcode: QUERY, status: ${r.status}, id: ${id}`,
    `;; flags: qr rd ra; QUERY: 1, ANSWER: ${r.answers.length}, AUTHORITY: ${r.authority.length}, ADDITIONAL: 1`,
    "",
    ";; OPT PSEUDOSECTION:",
    "; EDNS: version: 0, flags:; udp: 65494",
    ";; QUESTION SECTION:",
    `;${q.padEnd(23)}\t\tIN\t${type}`,
  ];
  if (r.answers.length) out.push("", ";; ANSWER SECTION:", ...r.answers.map(line));
  if (r.authority.length) out.push("", ";; AUTHORITY SECTION:", ...r.authority.map(line));
  out.push(
    "",
    `;; Query time: ${12 + (id % 30)} msec`,
    ";; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)",
    `;; WHEN: ${when(ctx.engine.now())}`,
    `;; MSG SIZE  rcvd: ${40 + r.answers.length * 16 + r.authority.length * 60}`,
    "",
  );
  return ok(out.join("\n"));
}

export async function runNslookup(tokens: string[], ctx: CliContext): Promise<CliResult> {
  let type = "A";
  let name: string | undefined;
  for (const t of tokens.slice(1)) {
    const m = /^-(?:type|query|q)=(\w+)$/i.exec(t);
    if (m) type = m[1].toUpperCase();
    else if (!t.startsWith("-") && name === undefined) name = t;
  }
  if (!name) return { output: "Usage: nslookup [-type=A|CNAME|MX|TXT|NS] name", exitCode: 1, changed: false };
  const r = await resolve(ctx.engine, ctx.accountId, name, type);
  const head = ["Server:\t\t127.0.0.53", "Address:\t127.0.0.53#53", ""];
  if (r.status === "NXDOMAIN") return { output: [...head, `** server can't find ${r.question.name}: NXDOMAIN`, ""].join("\n"), exitCode: 1, changed: false };
  if (r.answers.length === 0) return ok([...head, "Non-authoritative answer:", `*** Can't find ${r.question.name}: No answer`, ""].join("\n"));
  const lines = r.answers.map((a) => {
    if (a.type === "CNAME") return `${a.name}\tcanonical name = ${a.value}`;
    if (a.type === "A" || a.type === "AAAA") return `Name:\t${a.name}\nAddress: ${a.value}`;
    if (a.type === "MX") return `${a.name}\tmail exchanger = ${a.value}`;
    if (a.type === "TXT") return `${a.name}\ttext = ${a.value}`;
    if (a.type === "NS") return `${a.name}\tnameserver = ${a.value}`;
    return `${a.name}\t${a.type} = ${a.value}`;
  });
  return ok([...head, "Non-authoritative answer:", ...lines, ""].join("\n"));
}
