import { afterEach, describe, expect, it, vi } from "vitest";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

async function loadConfig(overrides: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(overrides))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  vi.resetModules();
  return import("./config.js");
}

describe("runtime configuration safety defaults", () => {
  it("disables scheduled jobs, payouts and proxy trust unless explicitly enabled", async () => {
    const { env } = await loadConfig({
      CRONS_ENABLED: undefined,
      PAYOUTS_ENABLED: undefined,
      TRUST_PROXY_HOPS: undefined,
    });
    expect(env.CRONS_ENABLED).toBe(false);
    expect(env.PAYOUTS_ENABLED).toBe(false);
    expect(env.TRUST_PROXY_HOPS).toBe(0);
  });

  it("refuses PAYOUTS_ENABLED=true without CRONS_ENABLED=true", async () => {
    await expect(loadConfig({ PAYOUTS_ENABLED: "true", CRONS_ENABLED: "false" })).rejects.toThrow(
      /PAYOUTS_ENABLED/,
    );
  });

  it("rejects ambiguous flag values instead of guessing", async () => {
    await expect(loadConfig({ CRONS_ENABLED: "yes" })).rejects.toThrow(/CRONS_ENABLED/);
  });

  it("requires the Privy allow-list when the paid buyer console is enabled", async () => {
    await expect(
      loadConfig({ BUYER_CONSOLE_ENABLED: "true", BUYER_CONSOLE_ALLOWED_PRIVY_USER_IDS: "" }),
    ).rejects.toThrow(/BUYER_CONSOLE_ALLOWED_PRIVY_USER_IDS/);
  });

  it("never reports secret values in configuration errors", async () => {
    const secret = "sk-SHOULD-NOT-APPEAR-IN-ERRORS";
    await expect(loadConfig({ ZG_TEAM_SK_KEY: secret, SUPABASE_URL: "not-a-url" })).rejects.toThrow(
      /SUPABASE_URL/,
    );
    await loadConfig({ ZG_TEAM_SK_KEY: secret, SUPABASE_URL: "not-a-url" }).catch((error: Error) =>
      expect(error.message).not.toContain(secret),
    );
  });
});
