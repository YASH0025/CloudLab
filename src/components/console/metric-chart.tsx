"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MetricSeries } from "@/lib/api-client";

/**
 * A single-series time chart for CloudWatch metrics: a 2px line, small markers
 * when there are few points, a recessive grid, a crosshair with a tooltip on
 * hover, and an optional dashed threshold line for alarms. Colors come from
 * the theme, so light and dark mode both work.
 */

export function formatValue(v: number, unit: string | null): string {
  if (unit === "Percent") return `${v.toFixed(v < 10 ? 1 : 0)}%`;
  if (unit === "Milliseconds") return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v < 10 ? 1 : 0)} ms`;
  if (unit === "Seconds") return v < 1 ? `${(v * 1000).toFixed(0)} ms` : `${v.toFixed(2)} s`;
  if (unit === "Bytes") return v >= 1024 ** 3 ? `${(v / 1024 ** 3).toFixed(1)} GiB` : v >= 1024 ** 2 ? `${(v / 1024 ** 2).toFixed(1)} MiB` : `${Math.round(v)} B`;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** Rounds the top of the axis up so the ticks (0, half, top) are round numbers. */
function niceMax(v: number): number {
  const half = v / 2;
  const mag = 10 ** Math.floor(Math.log10(half));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= half) ?? 10 * mag;
  return step * 2;
}

const time = (t: number, span: number) => {
  const d = new Date(t);
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return span > 24 * 3600_000 ? `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${hm}` : hm;
};

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function MetricChart({
  series,
  from,
  to,
  height = 150,
  threshold,
  loading,
  label,
}: {
  series?: MetricSeries;
  from: number;
  to: number;
  height?: number;
  threshold?: number;
  loading?: boolean;
  /** What the value means, for the tooltip (e.g. "Sum of Errors"). */
  label: string;
}) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 10, right: 12, bottom: 22, left: 44 };
  const w = Math.max(width - pad.left - pad.right, 10);
  const h = height - pad.top - pad.bottom;
  const points = useMemo(() => series?.points ?? [], [series]);
  const unit = series?.unit ?? null;

  const max = niceMax(Math.max(threshold ?? 0, ...points.map((p) => p.v), unit === "Percent" ? 10 : 1) * 1.1);
  const x = (t: number) => pad.left + ((t - from) / Math.max(to - from, 1)) * w;
  const y = (v: number) => pad.top + h - (v / max) * h;

  // Like the CloudWatch console, the line joins the datapoints there are, across empty periods.
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const ticks = [0, max / 2, max];
  const hovered = hover !== null ? points[hover] : null;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (points.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left + pad.left;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(points[i].t) - px) < Math.abs(x(points[best].t) - px)) best = i;
    setHover(best);
  };

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${label}: ${points.length} datapoints`} className="block overflow-visible">
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={pad.left} x2={pad.left + w} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
              <text x={pad.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                {formatValue(t, unit)}
              </text>
            </g>
          ))}
          {[from, (from + to) / 2, to].map((t, i) => (
            <text key={i} x={x(t)} y={height - 6} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} className="fill-muted-foreground text-[10px] tabular-nums">
              {time(t, to - from)}
            </text>
          ))}
          {threshold !== undefined && (
            <g>
              <line x1={pad.left} x2={pad.left + w} y1={y(threshold)} y2={y(threshold)} stroke="var(--destructive)" strokeWidth={1.5} strokeDasharray="5 4" />
              <text x={pad.left + w} y={y(threshold) - 4} textAnchor="end" className="fill-muted-foreground text-[10px]">
                Threshold {formatValue(threshold, unit)}
              </text>
            </g>
          )}
          {path && <path d={path} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {points.length <= 40 &&
            points.map((p, i) => <circle key={i} cx={x(p.t)} cy={y(p.v)} r={3} fill="var(--primary)" stroke="var(--card)" strokeWidth={1.5} />)}
          {hovered && (
            <g pointerEvents="none">
              <line x1={x(hovered.t)} x2={x(hovered.t)} y1={pad.top} y2={pad.top + h} stroke="var(--muted-foreground)" strokeWidth={1} strokeDasharray="2 3" />
              <circle cx={x(hovered.t)} cy={y(hovered.v)} r={4.5} fill="var(--primary)" stroke="var(--card)" strokeWidth={2} />
            </g>
          )}
          <rect x={pad.left} y={pad.top} width={w} height={h} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
      )}
      {hovered && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
          style={{ left: Math.min(Math.max(x(hovered.t) - 60, 0), Math.max(width - 140, 0)), top: 0 }}
        >
          <p className="text-muted-foreground">{new Date(hovered.t).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</p>
          <p className="font-medium tabular-nums">
            {formatValue(hovered.v, unit)} <span className="font-normal text-muted-foreground">{label}</span>
          </p>
        </div>
      )}
      {!loading && points.length === 0 && (
        <p className="absolute inset-0 flex items-center justify-center pl-10 text-xs text-muted-foreground">No data in this time range</p>
      )}
    </div>
  );
}
