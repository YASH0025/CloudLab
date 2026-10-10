"use client";

import { ChevronLeftIcon } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCreateResource, useTypeDef } from "@/hooks/use-cloud";
import { routes } from "@/lib/routes";
import { useConsoleStore } from "@/stores/console-store";
import { ResourceForm } from "./resource-form";
import { inSentence } from "@/lib/utils";

export function ResourceCreateView() {
  const { service, type } = useParams<{ service: string; type: string }>();
  const router = useRouter();
  const region = useConsoleStore((s) => s.region);
  const { typeDef, isLoading } = useTypeDef(service, type);
  const create = useCreateResource(service, type);
  // The guide's "Take me there" links can pre-fill the form via ?prefill=<json>.
  const prefillRaw = useSearchParams().get("prefill");
  let prefill: Record<string, unknown> | undefined;
  try {
    prefill = prefillRaw ? JSON.parse(prefillRaw) : undefined;
  } catch {
    prefill = undefined;
  }

  if (isLoading) return <Skeleton className="h-96" />;
  if (!typeDef) return <p className="text-muted-foreground">Unknown resource type.</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link
          href={routes.list(service, type)}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeftIcon className="size-4" /> {typeDef.pluralLabel}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Create {inSentence(typeDef.label)}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {typeDef.description} Region: <span className="font-mono">{region}</span>
        </p>
      </div>
      <Card>
        <CardContent className="py-6">
          {/* Re-mount the form when the region changes so region-specific options reset. */}
          <ResourceForm
            key={`${region}:${prefillRaw ?? ""}`}
            initialValues={prefill}
            fields={typeDef.fields}
            mode="create"
            submitLabel={`Create ${inSentence(typeDef.label)}`}
            pending={create.isPending}
            error={create.error}
            onCancel={() => router.push(routes.list(service, type))}
            onSubmit={(values) =>
              create.mutate(values, {
                onSuccess: ({ item }) => router.push(routes.detail(item.service, item.type, item.id)),
              })
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
