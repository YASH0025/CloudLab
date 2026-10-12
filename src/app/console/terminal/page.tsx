import { COMMANDS } from "@/cli/commands";
import { TerminalView } from "@/components/console/terminal-view";

export const metadata = { title: "Terminal" };

export default function TerminalPage() {
  // Only names and usage lines go to the browser, for tab completion.
  const commands = COMMANDS.map((c) => ({ service: c.service, operation: c.operation, usage: c.usage ?? "" }));
  return <TerminalView commands={commands} />;
}
