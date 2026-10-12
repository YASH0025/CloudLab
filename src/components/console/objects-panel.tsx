"use client";

import { format } from "date-fns";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  GlobeIcon,
  Trash2Icon,
  UploadIcon,
  XCircleIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceDTO } from "@/engine/types";
import { useCreateFolder, useDeleteObjects, useObjects, useUploadObjects } from "@/hooks/use-cloud";
import { toast } from "sonner";
import { api, identityHeader } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { ConfirmDialog, type ConfirmRequest } from "./confirm-dialog";

/** Downloads through fetch, so the request carries the IAM identity being acted as (s3:GetObject is checked). */
async function downloadObject(bucket: string, key: string) {
  const res = await fetch(api.objectDownloadUrl(bucket, key), { headers: identityHeader() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    toast.error(body?.error?.code ?? "Download failed", { description: body?.error?.message });
    return;
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = key.split("/").filter(Boolean).pop() ?? "download";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The bucket's files, with folders, upload (button or drag and drop), download and delete. */
export function ObjectsPanel({ bucket }: { bucket: string }) {
  const [prefix, setPrefix] = useState("");
  const [folderName, setFolderName] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const list = useObjects(bucket, prefix);
  const upload = useUploadObjects(bucket);
  const createFolder = useCreateFolder(bucket);
  const remove = useDeleteObjects(bucket);

  const crumbs = prefix.split("/").filter(Boolean);
  // The folder's own marker object ("photos/") isn't listed inside it.
  const objects = (list.data?.objects ?? []).filter((o) => o.key !== prefix);
  const folders = list.data?.prefixes ?? [];
  const busy = upload.isPending || remove.isPending || createFolder.isPending;

  const send = (files: FileList | null) => {
    if (files && files.length > 0) upload.mutate({ files: [...files], prefix });
  };

  return (
    <Card
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        send(e.dataTransfer.files);
      }}
      className={cn(dragging && "ring-2 ring-primary")}
    >
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>Objects</CardTitle>
            <CardDescription>
              Files in this bucket. Folders are just key prefixes: photos/cat.png is the object &quot;cat.png&quot; in
              the folder &quot;photos/&quot;. Drop files here to upload (up to 1 MB each).
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setFolderName("")} disabled={busy}>
              <FolderPlusIcon /> Create folder
            </Button>
            <Button size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
              <UploadIcon /> {upload.isPending ? "Uploading…" : "Upload"}
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                send(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        </div>
        <nav className="flex flex-wrap items-center gap-1 font-mono text-sm" aria-label="Folder">
          <button type="button" className="text-primary hover:underline" onClick={() => setPrefix("")}>
            {bucket}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRightIcon className="size-3.5 text-muted-foreground" />
              <button
                type="button"
                className={cn(i === crumbs.length - 1 ? "text-foreground" : "text-primary hover:underline")}
                onClick={() => setPrefix(`${crumbs.slice(0, i + 1).join("/")}/`)}
              >
                {c}
              </button>
            </span>
          ))}
        </nav>
        {folderName !== null && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const name = folderName.trim().replace(/^\/+|\/+$/g, "");
              if (name) createFolder.mutate(`${prefix}${name}/`, { onSuccess: () => setFolderName(null) });
            }}
          >
            <Input
              autoFocus
              placeholder="folder name, e.g. images"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              aria-label="Folder name"
              className="max-w-xs font-mono"
            />
            <Button type="submit" size="sm" disabled={!folderName.trim() || createFolder.isPending}>
              Create
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setFolderName(null)}>
              Cancel
            </Button>
          </form>
        )}
      </CardHeader>
      <CardContent className="py-2">
        {list.isLoading ? (
          <Skeleton className="h-24" />
        ) : list.error ? (
          <p className="py-4 text-sm text-destructive">{list.error.message}</p>
        ) : objects.length === 0 && folders.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            {prefix ? "This folder is empty." : "No objects yet."} Click Upload or drop files here.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Last modified</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {folders.map((f) => (
                  <TableRow key={f}>
                    <TableCell>
                      <button type="button" className="flex items-center gap-2 text-primary hover:underline" onClick={() => setPrefix(f)}>
                        <FolderIcon className="size-4" /> {f.slice(prefix.length)}
                      </button>
                    </TableCell>
                    <TableCell className="text-muted-foreground">Folder</TableCell>
                    <TableCell />
                    <TableCell />
                    <TableCell className="text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Delete folder ${f}`}
                        disabled={busy}
                        onClick={() =>
                          setConfirm({
                            title: `Delete folder ${f}?`,
                            description: "Every object whose key starts with this prefix will be deleted. This can't be undone.",
                            confirmLabel: "Delete folder",
                            onConfirm: () => remove.mutate({ keys: [], prefixes: [f] }),
                          })
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {objects.map((o) => (
                  <TableRow key={o.key}>
                    <TableCell className="font-mono text-xs">
                      <span className="flex items-center gap-2">
                        <FileIcon className="size-4 shrink-0 text-muted-foreground" /> {o.key.slice(prefix.length)}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{o.contentType}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{formatBytes(o.size)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{format(new Date(o.lastModified), "PP p")}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="icon" variant="ghost" aria-label={`Download ${o.key}`} onClick={() => downloadObject(bucket, o.key)}>
                        <DownloadIcon />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Delete ${o.key}`}
                        disabled={busy}
                        onClick={() =>
                          setConfirm({
                            title: `Delete ${o.key}?`,
                            description: "The object is deleted permanently (versioning isn't simulated yet).",
                            confirmLabel: "Delete",
                            onConfirm: () => remove.mutate({ keys: [o.key], prefixes: [] }),
                          })
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </Card>
  );
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? (
        <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
      ) : (
        <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
      )}
      <span>{children}</span>
    </li>
  );
}

/** Static website status: the three things S3 needs, and a link to the live site. */
export function WebsiteCard({ bucket }: { bucket: ResourceDTO }) {
  const root = useObjects(bucket.id, "");
  const c = bucket.config;
  const index = String(c.indexDocument || "index.html");
  const hasIndex = !!root.data?.objects.some((o) => o.key === index);
  const isPublic = !c.blockPublicAccess && c.publicRead === true;
  const live = c.websiteEnabled === true && isPublic && hasIndex;
  const url = `/website/${encodeURIComponent(bucket.id)}/`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GlobeIcon className="size-4 text-primary" /> Static website hosting
        </CardTitle>
        <CardDescription>
          Serve this bucket&apos;s files as a website. Change these settings under Edit settings below. Pages run without
          JavaScript in CloudLab, for safety.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2">
          <Check ok={c.websiteEnabled === true}>Static website hosting is turned on</Check>
          <Check ok={isPublic}>
            Visitors may read the files: Block all public access is off <em>and</em> the bucket policy allows public read
          </Check>
          <Check ok={hasIndex}>
            The index document <span className="font-mono">{index}</span> exists at the top of the bucket
          </Check>
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant={live ? "default" : "outline"} size="sm">
            <a href={url} target="_blank" rel="noreferrer">
              <ExternalLinkIcon /> Open website
            </a>
          </Button>
          {typeof bucket.attributes.websiteEndpoint === "string" && (
            <span className="font-mono text-xs break-all text-muted-foreground">{bucket.attributes.websiteEndpoint}</span>
          )}
        </div>
        {!live && (
          <p className="text-xs text-muted-foreground">
            Opening it before all three are green shows the same error page S3 would: try it to see which one.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
