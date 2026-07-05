import pc from "picocolors";

/**
 * CLI presentation layer: the banner, colors, glyphs, rules and bars that
 * make drift's output readable at a glance. Everything degrades gracefully —
 * picocolors disables itself on non-TTY / NO_COLOR, and the truecolor
 * gradient falls back to plain cyan when the terminal can't do 24-bit.
 */

export const c = pc;

const TRUECOLOR =
  pc.isColorSupported &&
  (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");

/** cyan → violet ramp, one stop per banner line */
const RAMP: Array<[number, number, number]> = [
  [94, 234, 212],
  [56, 189, 248],
  [96, 165, 250],
  [129, 140, 248],
  [167, 139, 250],
];

function ramped(line: string, stop: [number, number, number]): string {
  if (!pc.isColorSupported) return line;
  if (!TRUECOLOR) return pc.cyan(line);
  const [r, g, b] = stop;
  return `\x1b[38;2;${r};${g};${b}m${line}\x1b[39m`;
}

const ART = [
  "     ____       _ ______",
  "    / __ \\_____(_) __/ /_",
  "   / / / / ___/ / /_/ __/",
  "  / /_/ / /  / / __/ /_",
  " /_____/_/  /_/_/  \\__/",
];

/** Full banner for `drift init` (and the help screen). */
export function banner(version: string): string {
  const art = ART.map((l, i) => ramped(l, RAMP[i % RAMP.length])).join("\n");
  const tag = pc.dim("  keep specs and code provably in sync");
  return `\n${art}\n\n${tag}  ${pc.dim("·")}  ${pc.dim(`v${version}`)}\n`;
}

/** One-line brand mark for command output headers. */
export function mark(): string {
  return `${pc.cyan("◆")} ${pc.bold("drift")}`;
}

export function rule(width = 46): string {
  return pc.dim("─".repeat(width));
}

// ---- status vocabulary -----------------------------------------------

export type Status = "fresh" | "stale" | "broken";

export function glyph(status: Status): string {
  switch (status) {
    case "fresh":
      return pc.green("✓");
    case "stale":
      return pc.yellow("△");
    case "broken":
      return pc.red("✗");
  }
}

export function statusWord(status: Status): string {
  switch (status) {
    case "fresh":
      return pc.green("FRESH");
    case "stale":
      return pc.yellow("STALE");
    case "broken":
      return pc.red("BROKEN");
  }
}

/** `3 fresh · 1 stale · 0 broken` with zeros dimmed out. */
export function statusSummary(counts: { fresh: number; stale: number; broken: number }): string {
  const part = (n: number, label: string, paint: (s: string) => string) =>
    n === 0 ? pc.dim(`${n} ${label}`) : paint(`${n} ${label}`);
  return [
    part(counts.fresh, "fresh", pc.green),
    part(counts.stale, "stale", pc.yellow),
    part(counts.broken, "broken", pc.red),
  ].join(pc.dim(" · "));
}

// ---- widgets -----------------------------------------------------------

/** `████████░░░░░░░░  34%` — green/yellow/red by fill level. */
export function bar(percent: number, width = 22): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const paint = clamped >= 67 ? pc.green : clamped >= 34 ? pc.yellow : pc.red;
  return paint("█".repeat(filled)) + pc.dim("░".repeat(width - filled));
}

export function box(lines: string[], width?: number): string {
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const w = width ?? Math.max(...lines.map((l) => plain(l).length)) + 4;
  const top = pc.dim(`╭${"─".repeat(w - 2)}╮`);
  const bottom = pc.dim(`╰${"─".repeat(w - 2)}╯`);
  const body = lines.map((l) => {
    const pad = w - 4 - plain(l).length;
    return `${pc.dim("│")} ${l}${" ".repeat(Math.max(0, pad))} ${pc.dim("│")}`;
  });
  return [top, ...body, bottom].join("\n");
}

export function ok(msg: string): string {
  return `${pc.green("✓")} ${msg}`;
}

export function warn(msg: string): string {
  return `${pc.yellow("~")} ${pc.yellow(msg)}`;
}

export function err(msg: string): string {
  return `${pc.red("!")} ${pc.red(msg)}`;
}

export function step(msg: string): string {
  return `${pc.cyan("◆")} ${pc.bold(msg)}`;
}

export function hint(msg: string): string {
  return pc.dim(msg);
}

export function id(n: number | string): string {
  return pc.dim(`[${n}]`);
}

export function anchor(a: string): string {
  return pc.cyan(a);
}

export function sym(s: string): string {
  return pc.bold(s);
}

export function cmd(s: string): string {
  return pc.cyan(s);
}
