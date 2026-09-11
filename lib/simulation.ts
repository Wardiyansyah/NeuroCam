/** Simulation controls are intentionally server-only and disabled by default. */
export function simulationEnabled(): boolean {
  return process.env.ENABLE_SIMULATION === "true";
}
