// What this server deployment allows (GET /capabilities, GET /me/capabilities). The web app reads
// it to explain switched-off features up front, instead of failing after someone typed keys.
import { env } from "./config.js";

export type LaunchMode = "off" | "open" | "restricted";

export function allowList(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

const launchAllowed = allowList(env.OWNER_LAUNCH_ALLOWED_PRIVY_USER_IDS);
const consoleAllowed = allowList(env.BUYER_CONSOLE_ALLOWED_PRIVY_USER_IDS);

export function launchMode(
  enabled = env.OWNER_LAUNCH_ENABLED,
  allowed: ReadonlySet<string> = launchAllowed,
): LaunchMode {
  if (!enabled) return "off";
  return allowed.size > 0 ? "restricted" : "open";
}

export function canLaunch(
  privyUserId: string,
  enabled = env.OWNER_LAUNCH_ENABLED,
  allowed: ReadonlySet<string> = launchAllowed,
): boolean {
  const mode = launchMode(enabled, allowed);
  return mode === "open" || (mode === "restricted" && allowed.has(privyUserId));
}

export function canRunBuyerConsole(
  privyUserId: string,
  enabled = env.BUYER_CONSOLE_ENABLED,
  allowed: ReadonlySet<string> = consoleAllowed,
): boolean {
  return enabled && allowed.has(privyUserId);
}

export function publicCapabilities() {
  return {
    signIn: Boolean(env.PRIVY_APP_ID && env.PRIVY_APP_SECRET),
    ownerLaunch: launchMode(),
    buyerConsole: env.BUYER_CONSOLE_ENABLED ? ("restricted" as const) : ("off" as const),
  };
}
