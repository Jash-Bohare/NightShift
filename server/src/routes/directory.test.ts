import { describe, expect, it } from "vitest";

// Test directory query parsing and filtering logic
describe("directory filtering logic", () => {
  const sampleAgents = [
    {
      label: "tamil-scribe",
      ensName: "tamil-scribe.nightshift.eth",
      skill: "transcribe:ta",
      price_atomic: 30000n,
      description: "Tamil audio transcription agent",
      reputation: { jobs: 10, success: 10, p50_ms: 12000 },
      status: "active",
    },
    {
      label: "kural",
      ensName: "kural.nightshift.eth",
      skill: "transcribe:ta",
      price_atomic: 20000n,
      description: "Fast Tamil voice scribe",
      reputation: { jobs: 5, success: 4, p50_ms: 15000 },
      status: "active",
    },
    {
      label: "chennai-ears",
      ensName: "chennai-ears.nightshift.eth",
      skill: "transcribe:ta",
      price_atomic: 50000n,
      description: "High accuracy Tamil audio agent",
      reputation: { jobs: 20, success: 19, p50_ms: 11000 },
      status: "active",
    },
  ];

  it("filters by maxPrice", () => {
    const max = 30000n;
    const filtered = sampleAgents.filter((a) => a.price_atomic <= max);
    expect(filtered.length).toBe(2);
    expect(filtered.map((a) => a.label)).toEqual(["tamil-scribe", "kural"]);
  });

  it("filters by skill", () => {
    const filtered = sampleAgents.filter((a) => a.skill === "transcribe:ta");
    expect(filtered.length).toBe(3);
  });

  it("sorts by price ascending", () => {
    const sorted = [...sampleAgents].sort((a, b) => Number(a.price_atomic - b.price_atomic));
    expect(sorted[0]?.label).toBe("kural");
    expect(sorted[1]?.label).toBe("tamil-scribe");
    expect(sorted[2]?.label).toBe("chennai-ears");
  });

  it("sorts by reputation (success count and success rate)", () => {
    const sorted = [...sampleAgents].sort((a, b) => {
      const rateA = a.reputation.success / a.reputation.jobs;
      const rateB = b.reputation.success / b.reputation.jobs;
      if (rateB !== rateA) return rateB - rateA;
      return b.reputation.jobs - a.reputation.jobs;
    });
    expect(sorted[0]?.label).toBe("tamil-scribe"); // 100% (10/10)
    expect(sorted[1]?.label).toBe("chennai-ears"); // 95% (19/20)
    expect(sorted[2]?.label).toBe("kural"); // 80% (4/5)
  });

  it("searches by keyword", () => {
    const search = "voice";
    const found = sampleAgents.filter(
      (a) =>
        a.label.includes(search) ||
        a.ensName.includes(search) ||
        a.description.toLowerCase().includes(search),
    );
    expect(found.length).toBe(1);
    expect(found[0]?.label).toBe("kural");
  });
});
