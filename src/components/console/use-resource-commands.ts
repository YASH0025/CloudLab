"use client";

import { useCallback, useState } from "react";
import type { ResolvedTypeDef, ResourceDTO } from "@/engine/types";
import { useDeleteResource, useResourceAction } from "@/hooks/use-cloud";
import type { ConfirmRequest } from "./confirm-dialog";

/** Shared logic for running actions and deletes, asking for confirmation on destructive ones. */
export function useResourceCommands(typeDef: ResolvedTypeDef | undefined, onDeleted?: () => void) {
  const action = useResourceAction();
  const del = useDeleteResource();
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const runAction = useCallback(
    (r: ResourceDTO, key: string) => {
      const a = typeDef?.lifecycle?.actions?.[key];
      if (!a) return;
      const run = () => action.mutate({ id: r.id, action: key });
      if (!a.destructive) return run();
      setConfirm({
        title: `${a.label} ${r.name || r.id}?`,
        description: `This moves ${r.id} to '${a.to}'. It cannot be undone.`,
        confirmLabel: a.label,
        onConfirm: run,
      });
    },
    [typeDef, action],
  );

  const remove = useCallback(
    (r: ResourceDTO) => {
      setConfirm({
        title: `Delete ${r.name || r.id}?`,
        description:
          r.type === "auto-scaling-group"
            ? `${r.name} will be deleted and all of its instances terminated. (In the CLI this needs --force-delete.)`
            : r.type === "db-instance"
              ? `${r.name} will be deleted. A final snapshot named ${r.name}-final-… is kept, so you can restore it later. (In the CLI you choose: --final-db-snapshot-identifier or --skip-final-snapshot.)`
              : `${r.id} will be permanently removed. Resources that still depend on it will block the delete.`,
        confirmLabel: "Delete",
        onConfirm: () => del.mutate(r.id, { onSuccess: () => onDeleted?.() }),
      });
    },
    [del, onDeleted],
  );

  return {
    runAction,
    remove,
    confirm,
    closeConfirm: () => setConfirm(null),
    pending: action.isPending || del.isPending,
  };
}
