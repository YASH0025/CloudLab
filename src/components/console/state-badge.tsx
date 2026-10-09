import { Loader2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const GOOD = ["running", "available", "active"];
const BAD = ["terminated", "failed", "error"];
const IDLE = ["stopped"];

export function StateBadge({ state, pending }: { state: string | null; pending?: string | null }) {
  if (!state) return <span className="text-muted-foreground">–</span>;
  if (pending) {
    return (
      <Badge variant="warning">
        <Loader2Icon className="size-3 animate-spin" />
        {state}
      </Badge>
    );
  }
  const variant = GOOD.includes(state) ? "success" : BAD.includes(state) ? "destructive" : IDLE.includes(state) ? "secondary" : "default";
  return (
    <Badge variant={variant}>
      <span className="size-1.5 rounded-full bg-current" />
      {state}
    </Badge>
  );
}
