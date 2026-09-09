export function compactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${trimDecimal(value / 1_000_000_000, 2)}B`;
  if (absolute >= 1_000_000) return `${trimDecimal(value / 1_000_000, 2)}M`;
  if (absolute >= 1_000) return `${trimDecimal(value / 1_000, 1)}K`;
  return Math.round(value).toLocaleString("en-US");
}

export function exactNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unpriced";
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  if (Math.abs(value) < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function trimDecimal(value: number, precision: number): string {
  return value.toFixed(precision).replace(/\.0+$|(?<=\.[0-9]*?)0+$/, "");
}
