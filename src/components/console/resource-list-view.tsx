"use client";

import { ApiError } from "@/lib/api-client";

import { PlusIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useResources, useTypeDef } from "@/hooks/use-cloud";
import { routes } from "@/lib/routes";
import { ConfirmDialog } from "./confirm-dialog";
import { ResourceTable } from "./resource-table";
import { useResourceCommands } from "./use-resource-commands";
import { inSentence } from "@/lib/utils";

export function ResourceListView() {
  const { service, type } = useParams<{ service: string; type: string }>();
  const { typeDef, service: svc, isLoading: defLoading } = useTypeDef(service, type);
  const resources = useResources(service, type);
  const commands = useResourceCommands(typeDef);

  if (defLoading) return <Skeleton className="h-64" />;
  if (!typeDef || !svc) return <p className="text-muted-foreground">Unknown resource type.</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            {svc.label} <span className="opacity-70">· modelled on {svc.modelledOn}</span>
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{typeDef.pluralLabel}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{typeDef.description}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => resources.refetch()}>
            <RefreshCwIcon className={resources.isFetching ? "animate-spin" : undefined} />
          </Button>
          <Button asChild>
            <Link href={routes.create(service, type)}>
              <PlusIcon /> Create {inSentence(typeDef.label)}
            </Link>
          </Button>
        </div>
      </div>

      {resources.isLoading ? (
        <Skeleton className="h-48" />
      ) : resources.isError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/8 p-4 text-sm">
          {resources.error instanceof ApiError ? (
            <>
              <p className="font-mono text-xs font-semibold text-destructive">{resources.error.code}</p>
              <p className="mt-1 break-words">{resources.error.message}</p>
              {resources.error.status === 403 && (
                <p className="mt-2 text-muted-foreground">
                  The identity you&apos;re acting as (top right) isn&apos;t allowed to list these. Attach a policy that allows it, or switch back to the root user.
                </p>
              )}
            </>
          ) : (
            <p className="text-destructive">Could not load {inSentence(typeDef.pluralLabel)}.</p>
          )}
        </div>
      ) : (
        <ResourceTable
          typeDef={typeDef}
          data={resources.data ?? []}
          onAction={commands.runAction}
          onDelete={commands.remove}
        />
      )}

      <ConfirmDialog request={commands.confirm} onClose={commands.closeConfirm} pending={commands.pending} />
    </div>
  );
}
