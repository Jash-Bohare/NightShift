import { describe, expect, it } from "vitest";
import {
  DirectoryQuery,
  labelFromIdentifier,
  queryDirectory,
  toDirectoryAgent,
  type DirectoryRow,
} from "./directoryLogic.js";

function row(
  label: string,
  price: number,
  status: string,
  success: number,
  jobs: number,
): DirectoryRow {
  return {
    label,
    ens_name: `${label}.nightshift.eth`,
    owner: "0xowner",
    resolver: "0xresolver",
    skill: label === "hindi-ears" ? "transcribe:hi" : "transcribe:ta",
    price_atomic: price,
    price_unit: "minute",
    payto: "0.0.1",
    endpoint: `http://localhost:8787/a/${label}/run`,
    model: "whisper-large-v3",
    description: `${label} transcribes audio`,
    reputation: { jobs, success, p50_ms: 10_000 },
    status,
    expiry: null,
    updated_at: `2030-01-0${jobs % 9 || 1}T00:00:00Z`,
  };
}

const agents = [
  row("tamil-scribe", 30_000, "active", 1, 5),
  row("kural", 20_000, "paused_budget", 1, 0),
  row("chennai-ears", 50_000, "active", 0.9, 8),
  row("sleepy", 10_000, "paused_owner", 1, 3),
  row("hindi-ears", 25_000, "active", 1, 2),
].map((r) => toDirectoryAgent(r, "0.0.429274"));

const q = (raw: Record<string, string>) => DirectoryQuery.parse(raw);
const labels = (raw: Record<string, string>) =>
  queryDirectory(agents, q(raw)).agents.map((a) => a.label);

describe("directory query", () => {
  it("lists runnable agents (active + paused_budget) cheapest first by default", () => {
    expect(labels({})).toEqual(["kural", "hindi-ears", "tamil-scribe", "chennai-ears"]);
  });
  it("filters by exact skill, skill family, max price and min success", () => {
    expect(labels({ skill: "transcribe:ta" })).toEqual(["kural", "tamil-scribe", "chennai-ears"]);
    expect(labels({ skill: "transcribe" })).toHaveLength(4);
    expect(labels({ skill: "transcribe:ta", maxPrice: "30000" })).toEqual([
      "kural",
      "tamil-scribe",
    ]);
    expect(labels({ minSuccess: "0.95" })).not.toContain("chennai-ears");
  });
  it("supports explicit status filters", () => {
    expect(labels({ status: "paused_owner" })).toEqual(["sleepy"]);
    expect(labels({ status: "all" })).toHaveLength(5);
  });
  it("sorts by reputation and paginates with a total", () => {
    // kural has 0 settled jobs: a default success of 1 is no track record, so it ranks last.
    expect(labels({ sort: "reputation", skill: "transcribe:ta" })).toEqual([
      "tamil-scribe",
      "chennai-ears",
      "kural",
    ]);
    const page2 = queryDirectory(agents, q({ limit: "2", page: "2" }));
    expect(page2.total).toBe(4);
    expect(page2.agents.map((a) => a.label)).toEqual(["tamil-scribe", "chennai-ears"]);
  });
  it("searches label, name and description", () => {
    expect(labels({ search: "CHENNAI" })).toEqual(["chennai-ears"]);
  });
  it("rejects inputs that could reach a filter string", () => {
    for (const bad of [
      { search: "x,status.eq.revoked" },
      { search: "a(b)" },
      { skill: "transcribe:ta,foo" },
      { maxPrice: "-1" },
      { maxPrice: "1e9" },
      { status: "deleted" },
      { minSuccess: "2" },
    ])
      expect(DirectoryQuery.safeParse(bad).success).toBe(false);
  });
});

describe("labelFromIdentifier", () => {
  it("accepts a label or full name and rejects anything else", () => {
    expect(labelFromIdentifier("kural")).toBe("kural");
    expect(labelFromIdentifier("Kural.nightshift.eth")).toBe("kural");
    expect(labelFromIdentifier("x,label.neq.x")).toBeNull();
    expect(labelFromIdentifier("kural.other.eth")).toBeNull();
    expect(labelFromIdentifier("ab")).toBeNull();
  });
});

describe("toDirectoryAgent", () => {
  it("returns prices as exact integer strings with the asset", () => {
    expect(agents[0]!.price).toEqual({ amount: "30000", asset: "0.0.429274", unit: "minute" });
  });
});

describe("effectiveStatus", () => {
  it("reports a lapsed name as expired so it is never listed as available", async () => {
    const { effectiveStatus, queryDirectory, DirectoryQuery } = await import("./directoryLogic.js");
    const now = Date.parse("2030-12-06T00:00:00Z");
    expect(effectiveStatus("active", "2030-12-05T00:00:00Z", now)).toBe("expired");
    expect(effectiveStatus("active", "2030-12-07T00:00:00Z", now)).toBe("active");
    expect(effectiveStatus("revoked", "2030-12-05T00:00:00Z", now)).toBe("revoked");
    expect(effectiveStatus("active", null, now)).toBe("active");
    const agent = {
      label: "old",
      ensName: "old.nightshift.eth",
      owner: "0x",
      resolver: "0x",
      skill: "transcribe:ta",
      price: { amount: "1", asset: "0.0.429274", unit: "minute" },
      payTo: null,
      endpoint: null,
      model: null,
      description: null,
      reputation: null,
      status: effectiveStatus("active", "2030-12-05T00:00:00Z", now),
      expiry: "2030-12-05T00:00:00Z",
      updatedAt: "x",
    };
    expect(queryDirectory([agent], DirectoryQuery.parse({})).total).toBe(0);
    expect(queryDirectory([agent], DirectoryQuery.parse({ status: "expired" })).total).toBe(1);
  });
});

describe("reputation sort", () => {
  it("ranks proven workers above new ones whatever their default success value", async () => {
    const { queryDirectory, DirectoryQuery } = await import("./directoryLogic.js");
    const base = {
      ensName: "x.nightshift.eth",
      owner: "0x",
      resolver: "0x",
      skill: "transcribe:ta",
      price: { amount: "1", asset: "0.0.429274", unit: "minute" },
      payTo: null,
      endpoint: null,
      model: null,
      description: null,
      status: "active",
      expiry: null,
      updatedAt: "x",
    };
    const agents = [
      { ...base, label: "new-one", reputation: { jobs: 0, success: 1 } },
      { ...base, label: "proven-95", reputation: { jobs: 20, success: 0.95 } },
      { ...base, label: "proven-100", reputation: { jobs: 8, success: 1 } },
    ];
    const out = queryDirectory(agents, DirectoryQuery.parse({ sort: "reputation" }));
    expect(out.agents.map((a) => a.label)).toEqual(["proven-100", "proven-95", "new-one"]);
  });
});
