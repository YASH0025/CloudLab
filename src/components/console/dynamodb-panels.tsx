"use client";

import { Loader2Icon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ResourceDTO } from "@/engine/types";
import { useTableItems } from "@/hooks/use-cloud";
import { ApiError, type TableItemsInput, type TableItemsResult } from "@/lib/api-client";

const textareaClass =
  "min-h-40 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

type SortOp = "=" | "<" | "<=" | ">" | ">=" | "begins_with" | "between";

interface KeyInfo {
  partition: string;
  partitionType: string;
  sort?: string;
  sortType?: string;
}

function ErrorLine({ error }: { error: unknown }) {
  if (!(error instanceof ApiError)) return null;
  return (
    <p className="text-sm text-destructive" role="alert">
      <span className="font-mono">{error.code}</span>: {error.message}
    </p>
  );
}

const show = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
/** A number-typed key's value typed as text is sent as a number. */
const typedValue = (v: string, type: string | undefined) => (type === "N" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v);

/** A table's page: scan or query (the table or an index), then create, edit or delete items. */
export function TablePanel({ table }: { table: ResourceDTO }) {
  const indexes = (table.config.globalSecondaryIndexes as Record<string, string>[] | undefined) ?? [];
  const keys: Record<string, KeyInfo> = {
    "": { partition: String(table.config.partitionKey), partitionType: String(table.config.partitionKeyType), sort: table.config.sortKey as string | undefined, sortType: table.config.sortKeyType as string | undefined },
    ...Object.fromEntries(indexes.map((g) => [g.indexName, { partition: g.partitionKey, partitionType: g.partitionKeyType ?? "S", sort: g.sortKey || undefined, sortType: g.sortKeyType }])),
  };
  const tableKey = keys[""];
  const read = useTableItems(table.id);
  const write = useTableItems(table.id);
  const [mode, setMode] = useState<"scan" | "query">("scan");
  const [index, setIndex] = useState("");
  const [pv, setPv] = useState("");
  const [op, setOp] = useState<SortOp | "none">("none");
  const [sv, setSv] = useState("");
  const [sv2, setSv2] = useState("");
  const [forward, setForward] = useState(true);
  const [last, setLast] = useState<TableItemsInput | null>(null);
  const [result, setResult] = useState<TableItemsResult | null>(null);
  const [editor, setEditor] = useState<{ text: string; isNew: boolean } | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const active = table.state === "ACTIVE";
  const k = keys[index] ?? tableKey;

  const runRead = (input: TableItemsInput) => {
    setLast(input);
    read.mutate(input, { onSuccess: setResult });
  };
  const run = () => {
    if (mode === "scan") runRead({ action: "scan", indexName: index || undefined });
    else
      runRead({
        action: "query",
        indexName: index || undefined,
        partitionValue: typedValue(pv, k.partitionType),
        sort: k.sort && op !== "none" ? { op, value: typedValue(sv, k.sortType), value2: op === "between" ? typedValue(sv2, k.sortType) : undefined } : undefined,
        forward,
      });
  };
  const refresh = () => last && read.mutate(last, { onSuccess: setResult });

  const columns = useMemo(() => {
    const all = new Set<string>();
    for (const it of result?.items ?? []) Object.keys(it).forEach((c) => all.add(c));
    const first = [tableKey.partition, tableKey.sort].filter(Boolean) as string[];
    return [...first, ...[...all].filter((c) => !first.includes(c)).sort()].slice(0, 8);
  }, [result, tableKey.partition, tableKey.sort]);

  const template = () => {
    const obj: Record<string, unknown> = { [tableKey.partition]: tableKey.partitionType === "N" ? 1 : "value" };
    if (tableKey.sort) obj[tableKey.sort] = tableKey.sortType === "N" ? 1 : "value";
    return JSON.stringify(obj, null, 2);
  };

  const save = () => {
    if (!editor) return;
    let item: Record<string, unknown>;
    try {
      item = JSON.parse(editor.text);
    } catch (e) {
      write.reset();
      setJsonError(`That isn't valid JSON: ${(e as Error).message}`);
      return;
    }
    setJsonError(null);
    write.mutate(
      { action: "put", item, mustBeNew: editor.isNew },
      {
        onSuccess: () => {
          setEditor(null);
          refresh();
        },
      },
    );
  };

  const keyOf = (it: Record<string, unknown>) => ({ [tableKey.partition]: it[tableKey.partition], ...(tableKey.sort ? { [tableKey.sort]: it[tableKey.sort] } : {}) });

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <CardTitle>Explore items</CardTitle>
          <CardDescription>
            Query reads one partition (fast, cheap). Scan reads the whole table (slow and costly when it&apos;s big): compare Items read with Items returned.
          </CardDescription>
        </div>
        <Button size="sm" disabled={!active} onClick={() => setEditor({ text: template(), isNew: true })}>
          <PlusIcon /> Create item
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 pb-5">
        {!active && <p className="text-sm text-muted-foreground">The table is being created. Items can be added once it&apos;s Active.</p>}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label>Operation</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as "scan" | "query")}>
              <SelectTrigger className="w-32" aria-label="Operation">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="scan">Scan</SelectItem>
                <SelectItem value="query">Query</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Table or index</Label>
            <Select value={index || "__table"} onValueChange={(v) => setIndex(v === "__table" ? "" : v)}>
              <SelectTrigger className="w-56 max-w-full" aria-label="Table or index">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__table">Table: {table.name}</SelectItem>
                {indexes.map((g) => (
                  <SelectItem key={g.indexName} value={g.indexName}>
                    Index: {g.indexName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {mode === "query" && (
          <div className="grid gap-3 md:grid-cols-2 [&>*]:min-w-0">
            <div className="space-y-1.5">
              <Label htmlFor="ddb-pk">
                {k.partition} <span className="text-xs font-normal text-muted-foreground">(partition key, {k.partitionType === "N" ? "Number" : "String"}) =</span>
              </Label>
              <Input id="ddb-pk" value={pv} onChange={(e) => setPv(e.target.value)} placeholder="Enter a value" />
            </div>
            {k.sort && (
              <div className="space-y-1.5">
                <Label>
                  {k.sort} <span className="text-xs font-normal text-muted-foreground">(sort key, optional)</span>
                </Label>
                <div className="flex flex-wrap gap-2">
                  <Select value={op} onValueChange={(v) => setOp(v as SortOp | "none")}>
                    <SelectTrigger className="w-36" aria-label="Sort key condition">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Any</SelectItem>
                      {(["=", "<", "<=", ">", ">="] as const).map((o) => (
                        <SelectItem key={o} value={o}>
                          {o}
                        </SelectItem>
                      ))}
                      <SelectItem value="begins_with">Begins with</SelectItem>
                      <SelectItem value="between">Between</SelectItem>
                    </SelectContent>
                  </Select>
                  {op !== "none" && <Input aria-label="Sort key value" className="w-40 min-w-0 flex-1" value={sv} onChange={(e) => setSv(e.target.value)} placeholder="2026-10-01" />}
                  {op === "between" && <Input aria-label="Sort key upper value" className="w-40 min-w-0 flex-1" value={sv2} onChange={(e) => setSv2(e.target.value)} placeholder="2026-10-31" />}
                </div>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!forward} onChange={(e) => setForward(!e.target.checked)} /> Newest first (sort descending)
            </label>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={run} disabled={!active || read.isPending || (mode === "query" && pv === "")}>
            {read.isPending ? <Loader2Icon className="animate-spin" /> : <SearchIcon />} Run
          </Button>
          {result && (
            <span className="text-sm text-muted-foreground">
              Items returned: <span className="font-medium text-foreground tabular-nums">{result.count}</span> · Items read: <span className="font-medium text-foreground tabular-nums">{result.scannedCount}</span>
              {result.more && " · more items exist (showing the first 100)"}
            </span>
          )}
        </div>
        {result?.expression && <p className="font-mono text-xs text-muted-foreground">KeyConditionExpression: {result.expression}</p>}
        <ErrorLine error={read.error} />

        {editor && (
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="ddb-item">{editor.isNew ? "New item" : "Edit item"} (JSON)</Label>
              <span className="text-xs text-muted-foreground">Strings in quotes, numbers without. Saving replaces the whole item with the same key.</span>
            </div>
            <textarea id="ddb-item" className={textareaClass} value={editor.text} onChange={(e) => setEditor({ ...editor, text: e.target.value })} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={save} disabled={write.isPending}>
                {write.isPending && <Loader2Icon className="animate-spin" />} {editor.isNew ? "Create item" : "Save item"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditor(null)}>
                Cancel
              </Button>
            </div>
            {jsonError && <p className="text-sm text-destructive">{jsonError}</p>}
            <ErrorLine error={write.error} />
          </div>
        )}

        {result?.items && result.items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHead key={c} className="font-mono text-xs">
                    {c}
                    {c === tableKey.partition && (
                      <Badge variant="secondary" className="ml-1">
                        PK
                      </Badge>
                    )}
                    {c === tableKey.sort && (
                      <Badge variant="secondary" className="ml-1">
                        SK
                      </Badge>
                    )}
                  </TableHead>
                ))}
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((it, i) => (
                <TableRow key={i}>
                  {columns.map((c) => (
                    <TableCell key={c} className="max-w-48 truncate font-mono text-xs" title={show(it[c])}>
                      {show(it[c])}
                    </TableCell>
                  ))}
                  <TableCell className="whitespace-nowrap">
                    <Button size="icon" variant="ghost" aria-label="Edit item" onClick={() => setEditor({ text: JSON.stringify(it, null, 2), isNew: false })}>
                      <PencilIcon />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label="Delete item" disabled={write.isPending} onClick={() => write.mutate({ action: "delete", key: keyOf(it) }, { onSuccess: refresh })}>
                      <Trash2Icon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {result && result.count === 0 && <p className="text-sm text-muted-foreground">No items matched.</p>}
      </CardContent>
    </Card>
  );
}
