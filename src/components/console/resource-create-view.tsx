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
import { downloadText, inSentence } from "@/lib/utils";
import { toast } from "sonner";

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
          {typeDef.description}{" "}
          {typeDef.global ? (
            "IAM is global: it isn't tied to a region."
          ) : (
            <>
              Region: <span className="font-mono">{region}</span>
            </>
          )}
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
                onSuccess: ({ item }) => {
                  // A new key pair's private key is returned once: save it straight away, like the real console.
                  if (typeof item.attributes.keyMaterial === "string") {
                    downloadText(`${item.name}.pem`, item.attributes.keyMaterial);
                    toast.success(`Saved ${item.name}.pem to your downloads`, {
                      description: "Keep it safe. This is the only time the private key is available.",
                      duration: 10000,
                    });
                  }
                  // A new access key's secret is shown once too: save it as AWS's console does (a .csv file).
                  if (typeof item.attributes.secretAccessKey === "string") {
                    downloadText(
                      `${item.config.userName}_accessKeys.csv`,
                      `Access key ID,Secret access key\n${item.id},${item.attributes.secretAccessKey}\n`,
                    );
                    toast.success("Saved the access key to your downloads", {
                      description: `${item.id} · Keep the secret safe: this is the only time it's available.`,
                      duration: 10000,
                    });
                  }
                  router.push(routes.detail(item.service, item.type, item.id));
                },
              })
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
