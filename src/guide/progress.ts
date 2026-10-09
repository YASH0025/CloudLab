/**
 * Tutorial progress is ordered: a step only counts once every step before it
 * is done. That lets tutorials include "break it, then fix it" steps whose
 * checks contradict each other (route missing, then route present).
 *
 * Given how many steps were already completed and whether each step's check
 * passes right now, returns the new completed count.
 */
export function advanceProgress(completed: number, passes: boolean[]): number {
  let n = Math.max(0, Math.min(completed, passes.length));
  while (n < passes.length && passes[n]) n++;
  return n;
}
