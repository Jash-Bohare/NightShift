// GET /me/capabilities: what the signed-in account may do on this server deployment. Pages use it
// to explain a switched-off feature before anyone types keys; the server enforces it regardless.
export interface MeCapabilities {
  canLaunch: boolean;
  launchReason?: string;
  canRunBuyerConsole: boolean;
  buyerConsoleReason?: string;
}

export function parseMeCapabilities(value: unknown): MeCapabilities {
  const bad = () => new Error("The capabilities response is malformed.");
  if (typeof value !== "object" || value === null) throw bad();
  const v = value as Record<string, unknown>;
  if (typeof v.canLaunch !== "boolean" || typeof v.canRunBuyerConsole !== "boolean") throw bad();
  for (const key of ["launchReason", "buyerConsoleReason"])
    if (v[key] !== undefined && typeof v[key] !== "string") throw bad();
  return {
    canLaunch: v.canLaunch,
    canRunBuyerConsole: v.canRunBuyerConsole,
    ...(typeof v.launchReason === "string" ? { launchReason: v.launchReason } : {}),
    ...(typeof v.buyerConsoleReason === "string"
      ? { buyerConsoleReason: v.buyerConsoleReason }
      : {}),
  };
}
