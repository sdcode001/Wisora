export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startMonitoring } = await import("./lib/prices/monitor");
    startMonitoring();
  }
}
