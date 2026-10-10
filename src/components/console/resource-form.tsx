"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangleIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Controller,
  useFieldArray,
  useForm,
  type Control,
  type FieldErrors,
  type Resolver,
} from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { buildSchema, defaultValues } from "@/engine/fields";
import type { FieldDef } from "@/engine/types";
import { useIamPolicies, useResources } from "@/hooks/use-cloud";
import { ApiError } from "@/lib/api-client";
import { getPath, inSentence } from "@/lib/utils";

type Values = Record<string, unknown>;

interface ResourceFormProps {
  fields: FieldDef[];
  mode: "create" | "edit";
  initialValues?: Values;
  /** In edit mode, the resource's current state (for fields only editable in some states). */
  currentState?: string | null;
  submitLabel: string;
  pending?: boolean;
  error?: unknown;
  onSubmit: (values: Values) => void;
  onCancel?: () => void;
}

function errorMessage(errors: FieldErrors, name: string): string | undefined {
  const msg = getPath(errors, `${name}.message`);
  return typeof msg === "string" ? msg : undefined;
}

export function ResourceForm({
  fields,
  mode,
  initialValues,
  currentState,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
}: ResourceFormProps) {
  const schema = useMemo(() => buildSchema(fields), [fields]);
  const form = useForm<Values>({
    resolver: zodResolver(schema) as unknown as Resolver<Values>,
    defaultValues: { ...defaultValues(fields), ...initialValues },
  });

  // Map field-level errors returned by the API onto the inputs.
  useEffect(() => {
    if (!(error instanceof ApiError) || !Array.isArray(error.details)) return;
    for (const d of error.details as { field?: string; message?: string }[]) {
      if (d.field) form.setError(d.field, { type: "server", message: d.message });
    }
  }, [error, form]);

  const isLocked = (f: FieldDef) =>
    mode === "edit" &&
    (f.immutable || (f.mutableInStates !== undefined && (!currentState || !f.mutableInStates.includes(currentState))));

  return (
    <form
      onSubmit={form.handleSubmit((values) => {
        // Unset fields become null so "clear this field" survives JSON (undefined would be dropped).
        const out: Values = {};
        for (const f of fields) out[f.key] = values[f.key] === undefined ? null : values[f.key];
        onSubmit(out);
      })}
      className="space-y-6"
      noValidate
    >
      {error instanceof ApiError && (
        <div className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/8 p-3 text-sm">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <p className="font-mono text-xs font-semibold text-destructive">{error.code}</p>
            <p>{error.message}</p>
          </div>
        </div>
      )}

      {fields.map((f) => (
        <FieldControl
          key={f.key}
          field={f}
          name={f.key}
          control={form.control}
          errors={form.formState.errors}
          disabled={isLocked(f)}
          editing={mode === "edit"}
          lockReason={
            isLocked(f)
              ? f.immutable
                ? "Set at creation; cannot be changed."
                : `Can only be changed while ${f.mutableInStates?.join(" or ")}.`
              : undefined
          }
        />
      ))}

      <div className="flex justify-end gap-2 border-t pt-4">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Working…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

interface FieldControlProps {
  field: FieldDef;
  name: string;
  control: Control<Values>;
  errors: FieldErrors;
  disabled?: boolean;
  lockReason?: string;
  compact?: boolean;
  /** Editing an existing resource: secret fields start empty and mean "keep". */
  editing?: boolean;
}

function FieldControl({ field, name, control, errors, disabled, lockReason, compact, editing }: FieldControlProps) {
  const message = errorMessage(errors, name);
  const id = `field-${name}`;

  if (field.type === "list") {
    return <ListControl field={field} name={name} control={control} errors={errors} disabled={disabled} />;
  }

  if (field.type === "boolean") {
    return (
      <div className="flex items-start gap-3">
        <Controller
          control={control}
          name={name}
          render={({ field: f }) => (
            <Checkbox
              id={id}
              checked={Boolean(f.value)}
              onCheckedChange={(v) => f.onChange(v === true)}
              disabled={disabled}
              className="mt-0.5"
            />
          )}
        />
        <div className="space-y-1">
          <Label htmlFor={id}>{field.label}</Label>
          {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {!compact && (
        <Label htmlFor={id}>
          {field.label}
          {field.required && <span className="text-destructive">*</span>}
        </Label>
      )}
      <Controller
        control={control}
        name={name}
        render={({ field: f }) => {
          if (field.type === "json") {
            return (
              <textarea
                id={id}
                aria-label={field.label}
                aria-invalid={!!message}
                disabled={disabled}
                spellCheck={false}
                rows={Math.min(18, Math.max(6, String(f.value ?? "").split("\n").length + 1))}
                className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs leading-relaxed shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive disabled:opacity-60"
                value={f.value === undefined || f.value === null ? "" : String(f.value)}
                onChange={(e) => f.onChange(e.target.value)}
                onBlur={f.onBlur}
              />
            );
          }
          if (field.type === "policies") {
            return (
              <PolicyPicker
                id={id}
                value={Array.isArray(f.value) ? (f.value as string[]) : []}
                onChange={f.onChange}
                disabled={disabled}
              />
            );
          }
          if (field.type === "enum") {
            return (
              <Select value={(f.value as string) || undefined} onValueChange={f.onChange} disabled={disabled}>
                <SelectTrigger id={id} aria-invalid={!!message} aria-label={field.label}>
                  {/* Show just the label in the box; the hint is for the open list. */}
                  <SelectValue placeholder={`Choose ${inSentence(field.label)}`}>
                    {field.options?.find((o) => o.value === f.value)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(field.options ?? []).map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                      {o.hint && <span className="text-xs text-muted-foreground">{o.hint}</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          }
          if (field.type === "ref") {
            return (
              <RefControl
                field={field}
                id={id}
                value={f.value}
                onChange={f.onChange}
                disabled={disabled}
                invalid={!!message}
              />
            );
          }
          return (
            <Input
              id={id}
              aria-label={field.label}
              aria-invalid={!!message}
              type={field.secret ? "password" : undefined}
              autoComplete={field.secret ? "new-password" : undefined}
              placeholder={field.secret && editing ? "Leave empty to keep the current one" : field.placeholder}
              disabled={disabled}
              inputMode={field.type === "number" ? "numeric" : undefined}
              className={field.type === "cidr" ? "font-mono" : undefined}
              value={f.value === undefined || f.value === null ? "" : String(f.value)}
              onChange={(e) => f.onChange(e.target.value)}
              onBlur={f.onBlur}
            />
          );
        }}
      />
      {message ? (
        <p className="text-xs text-destructive">{message}</p>
      ) : lockReason ? (
        <p className="text-xs text-muted-foreground">{lockReason}</p>
      ) : (
        field.description && !compact && <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
    </div>
  );
}

function RefControl({
  field,
  id,
  value,
  onChange,
  disabled,
  invalid,
}: {
  field: FieldDef;
  id: string;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const { data = [], isLoading } = useResources(field.ref!.service, field.ref!.type);
  const options = data.filter((r) => r.state !== "terminated");
  // Some references store the target's name rather than its ID (an instance's key pair).
  const valueOf = (r: (typeof options)[number]) => (field.ref?.by === "name" ? r.name : r.id);
  const describe = (r: (typeof options)[number]) => {
    const extra = [r.config.cidrBlock, r.config.vpcId, r.config.availabilityZone].filter(Boolean).join(" · ");
    return { title: r.name || r.id, sub: `${r.id}${extra ? ` · ${extra}` : ""}` };
  };

  if (!isLoading && options.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
        No {inSentence(field.label)} in this region yet. {field.required ? "Create one first." : "You can create one first, or carry on without."}
      </p>
    );
  }

  if (field.ref?.multiple) {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div id={id} className="divide-y rounded-md border" aria-invalid={invalid}>
        {options.map((r) => {
          const d = describe(r);
          const checked = selected.includes(valueOf(r));
          return (
            <label key={r.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/40">
              <Checkbox
                checked={checked}
                disabled={disabled}
                onCheckedChange={(v) => onChange(v ? [...selected, valueOf(r)] : selected.filter((s) => s !== valueOf(r)))}
              />
              <span>
                {d.title}
                <span className="block font-mono text-xs text-muted-foreground">{d.sub}</span>
              </span>
            </label>
          );
        })}
      </div>
    );
  }

  // Radix Select can't use "" as a value, so optional refs get an explicit "None" choice.
  const NONE = "__none__";
  const current = (value as string) || (field.required ? undefined : NONE);
  return (
    <Select
      value={current}
      onValueChange={(v) => onChange(v === NONE ? "" : v)}
      disabled={disabled || isLoading}
    >
      <SelectTrigger id={id} aria-invalid={invalid} aria-label={field.label}>
        <SelectValue placeholder={isLoading ? "Loading…" : `Choose ${inSentence(field.label)}`} />
      </SelectTrigger>
      <SelectContent>
        {!field.required && <SelectItem value={NONE}>None</SelectItem>}
        {options.map((r) => {
          const d = describe(r);
          return (
            <SelectItem key={r.id} value={valueOf(r)}>
              {d.title} <span className="font-mono text-xs text-muted-foreground">{d.sub}</span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function ListControl({
  field,
  name,
  control,
  errors,
  disabled,
}: Omit<FieldControlProps, "lockReason" | "compact">) {
  const { fields: rows, append, remove } = useFieldArray({ control, name: name as never });
  const items = field.item ?? [];
  const listError = errorMessage(errors, name);

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{field.label}</legend>
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      <div className="overflow-x-auto rounded-md border">
        <div
          className="grid min-w-[860px] gap-2 border-b bg-muted/60 px-3 py-2 text-xs font-medium text-muted-foreground"
          style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr)) 2.25rem` }}
        >
          {items.map((i) => (
            <span key={i.key}>{i.label}</span>
          ))}
          <span />
        </div>
        {rows.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">No rules.</p>}
        {rows.map((row, index) => (
          <div
            key={row.id}
            className="grid min-w-[860px] items-start gap-2 border-b px-3 py-2 last:border-0"
            style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr)) 2.25rem` }}
          >
            {items.map((i) => (
              <FieldControl
                key={i.key}
                field={i}
                name={`${name}.${index}.${i.key}`}
                control={control}
                errors={errors}
                disabled={disabled}
                compact
              />
            ))}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove rule"
              disabled={disabled}
              onClick={() => remove(index)}
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
      </div>
      {listError && <p className="text-xs text-destructive">{listError}</p>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || (field.maxItems !== undefined && rows.length >= field.maxItems)}
        onClick={() => append(defaultValues(items) as never)}
      >
        <PlusIcon /> Add rule
      </Button>
    </fieldset>
  );
}

/** Attach policies: AWS managed ones and the account's own, with a filter. */
function PolicyPicker({ id, value, onChange, disabled }: { id: string; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const { data = [], isLoading } = useIamPolicies();
  const [filter, setFilter] = useState("");
  const shown = data.filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()));
  // Attached ones first, so it's easy to see what's selected.
  shown.sort((a, b) => Number(value.includes(b.arn)) - Number(value.includes(a.arn)));
  return (
    <div id={id} className="space-y-2">
      <Input placeholder="Filter policies…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter policies" />
      <div className="max-h-64 divide-y overflow-y-auto rounded-md border">
        {isLoading && <p className="px-3 py-2 text-sm text-muted-foreground">Loading…</p>}
        {shown.map((p) => (
          <label key={p.arn} className="flex cursor-pointer items-start gap-3 px-3 py-2 text-sm hover:bg-muted/40">
            <Checkbox
              className="mt-0.5"
              checked={value.includes(p.arn)}
              disabled={disabled}
              onCheckedChange={(v) => onChange(v ? [...value, p.arn] : value.filter((a) => a !== p.arn))}
            />
            <span className="min-w-0">
              {p.name}{" "}
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase">
                {p.managed ? "AWS managed" : "Customer managed"}
              </span>
              {p.description && <span className="block text-xs text-muted-foreground">{p.description}</span>}
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{value.length} attached</p>
    </div>
  );
}
