import { Loader2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const GOOD = ["running", "available", "active", "in-use", "completed"];
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
  const lower = state.toLowerCase();
  // CloudFormation and DynamoDB use upper-case statuses (CREATE_COMPLETE, ROLLBACK_COMPLETE, ACTIVE…).
  const variant =
    GOOD.includes(lower) || /^(create|update)_complete$|^confirmed$/.test(lower)
      ? "success"
      : BAD.includes(lower) || /rollback|failed/.test(lower)
        ? "destructive"
        : /_in_progress$|^creating$|^pending/.test(lower)
          ? "warning"
          : IDLE.includes(lower)
            ? "secondary"
            : "default";
  return (
    <Badge variant={variant}>
      <span className="size-1.5 rounded-full bg-current" />
      {state}
    </Badge>
  );
}
