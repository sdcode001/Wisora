export function formatInr(value: number): string {
  return `₹${value.toLocaleString("en-IN")}`;
}

export function formatCount(value: number): string {
  if (value >= 1000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k).toString() : k.toFixed(1)}k`;
  }
  return value.toLocaleString("en-IN");
}
