"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { CopyIcon, FileTextIcon, HardDriveIcon, HistoryIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { REGIONS } from "@/engine/catalog";
import type { ResourceDTO } from "@/engine/types";
import { useResources, useWriteVolumeFile } from "@/hooks/use-cloud";
import { api, ApiError } from "@/lib/api-client";
import { routes } from "@/lib/routes";
import { StateBadge } from "./state-badge";

interface VolumeFile {
  path: string;
  content: string;
  modifiedAt: string;
}

const filesOf = (r: ResourceDTO) => (r.attributes.files as VolumeFile[] | undefined) ?? [];
const errorText = (e: unknown) => (e instanceof ApiError ? `${e.code}: ${e.message}` : e ? String(e) : "");
const isRoot = (v: ResourceDTO) => v.config.device === "/dev/xvda" && !!(v.attributes.system as { ownedBy?: string } | undefined)?.ownedBy;

function FileList({ files, empty }: { files: VolumeFile[]; empty: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (files.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y rounded-md border">
      {files.map((f) => (
        <li key={f.path} className="px-3 py-2">
          <button type="button" className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpen(open === f.path ? null : f.path)}>
            <span className="flex min-w-0 items-center gap-2 font-mono text-xs">
              <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{f.path}</span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatDistanceToNowStrict(new Date(f.modifiedAt), { addSuffix: true })}</span>
          </button>
          {open === f.path && <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{f.content || "(empty)"}</pre>}
        </li>
      ))}
    </ul>
  );
}

// ---------- volume ----------

export function VolumePanel({ volume }: { volume: ResourceDTO }) {
  const write = useWriteVolumeFile(volume.id);
  const instanceId = volume.config.instanceId as string | undefined;
  const instances = useResources("compute", "instance");
  const [path, setPath] = useState("/data/notes.txt");
  const [content, setContent] = useState("");
  const files = filesOf(volume);
  const server = instanceId ? instances.data?.find((i) => i.id === instanceId) : undefined;
  const canWrite = volume.state === "in-use" && server?.state === "running";
  const snapshots = useResources("compute", "snapshot");
  const mine = (snapshots.data ?? []).filter((s) => s.config.volumeId === volume.id);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDriveIcon className="size-4" /> Files on this volume
          </CardTitle>
          <CardDescription>
            {isRoot(volume)
              ? "This is the instance's root volume: the operating system lives here. It's deleted when the instance terminates."
              : "Data written by software on the instance. It stays here when you detach the volume, and even when the instance is terminated."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pb-5">
          <FileList files={files} empty="Empty. Write a file below, the way an app on the server would." />
          <form
            className="space-y-2 rounded-md border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              write.mutate({ path, content }, { onSuccess: () => setContent("") });
            }}
          >
            <p className="text-xs font-medium">Write a file (as software on {server ? server.name || server.id : "the instance"})</p>
            <Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono text-xs" aria-label="File path" />
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={3}
              placeholder="id,item&#10;1,book"
              aria-label="File contents"
              className="w-full rounded-md border bg-card px-3 py-2 font-mono text-xs"
            />
            {!canWrite && (
              <p className="text-xs text-muted-foreground">
                {instanceId
                  ? `Start the instance to write to its disks.`
                  : "Attach this volume to a running instance first (edit Attached to instance below). On a real server you'd also format and mount it; CloudLab does that for you."}
              </p>
            )}
            {write.error && <p className="text-xs text-destructive">{errorText(write.error)}</p>}
            <Button type="submit" size="sm" disabled={!canWrite || write.isPending || !path}>
              Write file
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <HistoryIcon className="size-4" /> Snapshots of this volume
            </CardTitle>
            <CardDescription>Backups you can restore as a new volume in any zone of the region. Take one before risky changes.</CardDescription>
          </div>
          <Button asChild size="sm">
            <Link href={routes.createPrefilled("compute", "snapshot", { volumeId: volume.id, name: `${volume.name || volume.id}-backup` })}>
              <PlusIcon /> Create snapshot
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="pb-5">
          {mine.length === 0 ? (
            <p className="text-sm text-muted-foreground">No snapshots yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {mine.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                  <Link href={routes.detail("compute", "snapshot", s.id)} className="min-w-0 text-primary hover:underline">
                    {s.name || s.id}
                    <span className="block font-mono text-xs text-muted-foreground">{s.id}</span>
                  </Link>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    {formatDistanceToNowStrict(new Date(s.createdAt), { addSuffix: true })}
                    <StateBadge state={s.state} pending={s.pendingState} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- snapshot ----------

export function SnapshotPanel({ snapshot }: { snapshot: ResourceDTO }) {
  const qc = useQueryClient();
  const others = REGIONS.filter((r) => r.code !== snapshot.region);
  const [target, setTarget] = useState(others[0]?.code ?? "");
  const copy = useMutation({
    mutationFn: () =>
      api.createResource({
        service: "compute",
        type: "snapshot",
        region: target,
        config: { name: snapshot.name, sourceSnapshotId: snapshot.id, sourceRegion: snapshot.region, description: `[Copied ${snapshot.id} from ${snapshot.region}]` },
      }),
    onSuccess: ({ item }) => {
      qc.invalidateQueries();
      toast.success(`Copying to ${target}: ${item.id}. Switch the region at the top to see it.`);
    },
  });
  const files = filesOf(snapshot);
  const completed = snapshot.state === "completed";

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>What&apos;s in this backup</CardTitle>
            <CardDescription>The volume&apos;s files at the moment the snapshot started. Later changes to the volume don&apos;t affect it.</CardDescription>
          </div>
          <Button asChild size="sm" disabled={!completed}>
            <Link href={routes.createPrefilled("compute", "volume", { snapshotId: snapshot.id, name: `${snapshot.name || "restored"}`, volumeType: "gp3" })}>
              Restore as volume
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="pb-5">
          <FileList files={files} empty="The volume was empty when this snapshot was taken." />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CopyIcon className="size-4" /> Copy to another region
          </CardTitle>
          <CardDescription>
            Snapshots only restore inside their own region. A copy in another region is your plan B if a whole region has a bad day (disaster recovery).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 pb-5">
          <div className="flex flex-wrap gap-2">
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger className="w-full sm:w-64" aria-label="Destination region">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {others.map((r) => (
                  <SelectItem key={r.code} value={r.code}>
                    {r.name} <span className="text-muted-foreground">{r.code}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => copy.mutate()} disabled={!completed || copy.isPending}>
              Copy snapshot
            </Button>
          </div>
          {!completed && <p className="text-xs text-muted-foreground">Wait until the snapshot is completed.</p>}
          {copy.error && <p className="text-xs text-destructive">{errorText(copy.error)}</p>}
          <p className="text-xs text-muted-foreground">
            Terminal:{" "}
            <span className="font-mono">
              aws ec2 copy-snapshot --region {target} --source-region {snapshot.region} --source-snapshot-id {snapshot.id}
            </span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- instance storage ----------

export function InstanceStoragePanel({ instance }: { instance: ResourceDTO }) {
  const volumes = useResources("compute", "volume");
  const attached = (volumes.data ?? []).filter((v) => v.config.instanceId === instance.id).sort((a, b) => String(a.config.device).localeCompare(String(b.config.device)));
  const az = instance.attributes.availabilityZone as string | undefined;
  const nextDevice = ["/dev/sdf", "/dev/sdg", "/dev/sdh", "/dev/sdi"].find((d) => !attached.some((v) => v.config.device === d)) ?? "/dev/sdj";
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <HardDriveIcon className="size-4" /> Storage
          </CardTitle>
          <CardDescription>EBS volumes attached to this instance. The root volume holds the operating system; extra volumes are for your data and outlive the instance.</CardDescription>
        </div>
        {instance.state !== "terminated" && az && (
          <Button asChild size="sm" variant="outline">
            <Link href={routes.createPrefilled("compute", "volume", { name: `${instance.name || instance.id}-data`, availabilityZone: az, size: 10, volumeType: "gp3", instanceId: instance.id, device: nextDevice })}>
              <PlusIcon /> Add a volume
            </Link>
          </Button>
        )}
      </CardHeader>
      <CardContent className="py-2">
        {attached.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No volumes attached.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Device</TableHead>
                <TableHead>Volume</TableHead>
                <TableHead>Size</TableHead>
                <TableHead className="hidden sm:table-cell">Type</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {attached.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-mono text-xs">
                    {String(v.config.device)} {isRoot(v) && <Badge variant="secondary">root</Badge>}
                  </TableCell>
                  <TableCell>
                    <Link href={routes.detail("compute", "volume", v.id)} className="font-mono text-xs text-primary hover:underline">
                      {v.name || v.id}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs">{String(v.config.size)} GiB</TableCell>
                  <TableCell className="hidden text-xs sm:table-cell">{String(v.config.volumeType)}</TableCell>
                  <TableCell>
                    <StateBadge state={v.state} pending={v.pendingState} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
