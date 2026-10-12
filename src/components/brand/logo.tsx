import { useId } from "react";
import { cn } from "@/lib/utils";

/** The CloudLab mark: a blue cloud with a white peak cut through it ("build, then climb"). */
export function LogoMark({ className }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 64 48" className={cn("size-7 shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4fb3ff" />
          <stop offset="1" stopColor="#0a5cf0" />
        </linearGradient>
        <clipPath id={`${id}-c`}>
          <circle cx="17" cy="32" r="13" />
          <circle cx="33" cy="20" r="17" />
          <circle cx="49" cy="31" r="12" />
          <rect x="4" y="30" width="57" height="15" rx="7.5" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}-c)`}>
        <rect width="64" height="48" fill={`url(#${id}-g)`} />
        {/* soft back lobe, for depth */}
        <circle cx="33" cy="20" r="17" fill="#ffffff" opacity="0.12" />
        {/* the white peak */}
        <path d="M17 48 L33 19 L60 48 L47 48 L33 31 L24 48 Z" fill="#ffffff" />
      </g>
    </svg>
  );
}

/** Mark + wordmark. "Cloud" takes the text color, "Lab" is brand blue. */
export function Logo({ className, markClassName }: { className?: string; markClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <LogoMark className={markClassName} />
      <span>
        Cloud<span className="lab text-[#1a73ff] dark:text-[#4fa3ff]">Lab</span>
      </span>
    </span>
  );
}
