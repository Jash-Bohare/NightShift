// Applies supabase/migrations/0001..NNNN to a real (embedded, WASM) Postgres and checks schema,
// constraints, grants, RLS and the RPCs as the Supabase roles anon / authenticated / service_role.
// This validates the SQL itself; it is not evidence about any deployed Supabase project.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
const files = readdirSync(MIGRATIONS)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

/** Minimal Supabase platform prerequisites the migrations assume. */
const SUPABASE_BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create publication supabase_realtime;
`;

async function freshDb(upTo = files.length): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_BOOTSTRAP);
  for (const file of files.slice(0, upTo)) {
    try {
      await db.exec(readFileSync(MIGRATIONS + file, "utf8"));
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`, { cause: error });
    }
  }
  return db;
}

async function as<T>(db: PGlite, role: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`set role ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

async function denied(db: PGlite, role: string, sql: string): Promise<boolean> {
  try {
    const rows = await as(db, role, sql);
    return rows.length === 0; // RLS without a policy hides rows instead of raising
  } catch (error) {
    return /permission denied/.test((error as Error).message);
  }
}

const AGENT = "10000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000001";

async function seed(db: PGlite, capUsdMicro = 100_000): Promise<void> {
  await db.query(
    `insert into owners (id, privy_user_id, evm_address, hedera_payout_account)
     values ($1, 'did:privy:owner', '0x0000000000000000000000000000000000000001', '0.0.9001')`,
    [OWNER],
  );
  await db.query(
    `insert into agents (id, owner_id, label, ens_name, skill, model, price_atomic, price_unit,
       daily_cap_usd_micro, status, hedera_account_id)
     values ($1, $2, 'scribe', 'scribe.nightshift.eth', 'transcribe:ta', 'm', 30000, 'minute', $3,
       'active', '0.0.7')`,
    [AGENT, OWNER, capUsdMicro],
  );
  await db.query(
    `insert into agent_secrets (agent_id, zg_api_key_enc, hedera_private_key_enc) values ($1, 'x', 'y')`,
    [AGENT],
  );
}

describe(`database migrations on Postgres (${files.join(", ")})`, () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await seed(db);
  });
  afterAll(() => db.close());

  it("applies in order and creates the expected schema", async () => {
    const tables = (
      await db.query<{ t: string }>(
        `select table_name as t from information_schema.tables where table_schema = 'public' order by 1`,
      )
    ).rows.map((r) => r.t);
    expect(tables).toEqual(
      expect.arrayContaining([
        "owners",
        "agents",
        "agent_secrets",
        "jobs",
        "payouts",
        "directory",
        "indexer_state",
        "buyer_events",
        "quote_redemptions",
        "agent_budget_reservations",
        "settlement_recoveries",
      ]),
    );
    const statuses = (
      await db.query<{ v: string }>(`select unnest(enum_range(null::job_status))::text as v`)
    ).rows.map((r) => r.v);
    expect(statuses).toContain("needs_reconciliation");
    const cols = (
      await db.query<{ c: string }>(
        `select column_name as c from information_schema.columns where table_name = 'jobs'`,
      )
    ).rows.map((r) => r.c);
    expect(cols).toEqual(
      expect.arrayContaining(["output_sha256", "payout_id", "zg_cost_usd_micro"]),
    );
  });

  it("enforces RLS: anon and authenticated cannot read or write private tables", async () => {
    await db.query(
      `insert into jobs (agent_id, status, units, price_atomic) values ($1, 'settled', 2, 60000)`,
      [AGENT],
    );
    await db.query(
      `insert into buyer_events (event_type, payload) values ('result', '{"text":"secret transcript"}')`,
    );
    const privateTables = [
      "owners",
      "agents",
      "agent_secrets",
      "jobs",
      "payouts",
      "buyer_events",
      "quote_redemptions",
      "agent_budget_reservations",
      "settlement_recoveries",
    ];
    for (const role of ["anon", "authenticated"])
      for (const table of privateTables)
        expect(await denied(db, role, `select * from ${table}`), `${role} read ${table}`).toBe(
          true,
        );
    await expect(
      as(
        db,
        "anon",
        `insert into jobs (agent_id, status, units, price_atomic) values ('${AGENT}', 'settled', 1, 1)`,
      ),
    ).rejects.toThrow(/permission denied|row-level security/);
    await expect(as(db, "authenticated", `update agents set status = 'revoked'`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it("keeps the public directory and indexer checkpoint readable", async () => {
    await db.query(
      `insert into directory (label, ens_name, owner, resolver) values ('scribe', 'scribe.nightshift.eth', '0x1', '0x2')`,
    );
    expect(await as(db, "anon", `select label from directory`)).toEqual([{ label: "scribe" }]);
    // No write policy: an anon delete matches zero rows and an anon insert is rejected.
    await as(db, "anon", `delete from directory`);
    expect((await db.query(`select label from directory`)).rows).toHaveLength(1);
    await expect(
      as(
        db,
        "anon",
        `insert into directory (label, ens_name, owner, resolver) values ('x1x', 'x', 'x', 'x')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("service_role reads private tables (bypasses RLS) and owns the RPCs", async () => {
    expect((await as(db, "service_role", `select count(*)::int as n from jobs`))[0]).toEqual({
      n: 1,
    });
    for (const role of ["anon", "authenticated"])
      await expect(as(db, role, `select reserve_agent_budget('${AGENT}', 1)`)).rejects.toThrow(
        /permission denied/,
      );
  });

  it("rejects malformed output digests and duplicate quote nonces", async () => {
    await expect(
      db.query(
        `insert into jobs (agent_id, status, units, price_atomic, output_sha256) values ($1, 'done', 1, 1, 'xyz')`,
        [AGENT],
      ),
    ).rejects.toThrow(/check constraint/);
    const nonce = "30000000-0000-4000-8000-000000000001";
    const insert = () =>
      db.query(
        `insert into quote_redemptions (nonce, quote_digest, agent_id, state, expires_at)
         values ($1, $2, $3, 'verified', now() + interval '2 minutes')`,
        [nonce, "a".repeat(64), AGENT],
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
  });
});

describe("budget reservation RPCs on Postgres", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await seed(db, 100);
  });
  afterAll(() => db.close());
  const reserve = async (amount: number) =>
    (
      await as<{ id: string | null }>(
        db,
        "service_role",
        `select reserve_agent_budget($1, $2) as id`,
        [AGENT, amount],
      )
    )[0]!.id;

  it("reserves within the cap, refuses over the cap, and expires normal reservations in 15 minutes", async () => {
    const first = await reserve(60);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await reserve(50)).toBeNull();
    const ttl = (
      await db.query<{ minutes: number }>(
        `select round(extract(epoch from (expires_at - now())) / 60)::int as minutes from agent_budget_reservations where id = $1`,
        [first],
      )
    ).rows[0]!.minutes;
    expect(ttl).toBe(15);
    expect(
      (
        await as<{ ok: boolean }>(db, "service_role", `select release_agent_budget($1) as ok`, [
          first,
        ])
      )[0]!.ok,
    ).toBe(true);
    expect(await reserve(50)).not.toBeNull();
  });

  it("retains an uncertain reservation at the remaining cap for a long period", async () => {
    await db.exec("delete from agent_budget_reservations");
    const id = await reserve(10);
    await as(db, "service_role", `select retain_uncertain_agent_budget($1)`, [id]);
    const row = (
      await db.query<{ amount: string; days: number }>(
        `select amount_usd_micro::text as amount, round(extract(epoch from (expires_at - now())) / 86400)::int as days
         from agent_budget_reservations where id = $1`,
        [id],
      )
    ).rows[0]!;
    expect(row).toEqual({ amount: "100", days: 365 });
    expect(await reserve(1)).toBeNull(); // worker is blocked until an operator reconciles
  });
});

describe("daily payout claiming on Postgres", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await seed(db);
    await db.exec(`
      insert into jobs (agent_id, status, units, price_atomic, created_at) values
        ('${AGENT}', 'settled', 2, 60000, '2030-11-01T10:00:00Z'),
        ('${AGENT}', 'settled', 1, 30000, '2030-11-01T11:00:00Z'),
        ('${AGENT}', 'failed_upstream', 1, 30000, '2030-11-01T12:00:00Z'),
        ('${AGENT}', 'settled', 1, 30000, '2030-11-02T01:00:00Z');
    `);
  });
  afterAll(() => db.close());
  const claim = (date: string) =>
    as<{
      gross_atomic: string;
      owner_atomic: string;
      fee_atomic: string;
      status: string;
      destination_account: string;
    }>(
      db,
      "service_role",
      `select gross_atomic::text, owner_atomic::text, fee_atomic::text, status, destination_account
       from claim_daily_payouts($1::date, 10000, 0, '0.0.429274')`,
      [date],
    );

  it("claims settled, unassigned jobs before the payout date exactly once", async () => {
    expect(await claim("2030-11-02")).toEqual([
      {
        gross_atomic: "90000",
        owner_atomic: "90000",
        fee_atomic: "0",
        status: "pending",
        destination_account: "0.0.9001",
      },
    ]);
    expect(await claim("2030-11-02")).toEqual([]); // idempotent: same day, nothing new
    const assigned = await db.query<{ n: number }>(
      `select count(*)::int as n from jobs where payout_id is not null`,
    );
    expect(assigned.rows[0]!.n).toBe(2);
  });

  it("does not let anon or authenticated claim payouts", async () => {
    for (const role of ["anon", "authenticated"])
      await expect(
        as(db, role, `select * from claim_daily_payouts('2030-11-03', 10000, 0, '0.0.429274')`),
      ).rejects.toThrow(/permission denied/);
  });
});

describe("pre-0005 exposure (documents the risk on any database still at 0004)", () => {
  it("anon can read jobs and buyer events until 0005 is applied", async () => {
    const at0004 = await freshDb(files.indexOf("0004_signed_quotes_and_job_integrity.sql") + 1);
    await seed(at0004);
    await at0004.query(
      `insert into buyer_events (event_type, payload) values ('result', '{"text":"secret transcript"}')`,
    );
    const rows = await as<{ payload: { text: string } }>(
      at0004,
      "anon",
      `select payload from buyer_events`,
    );
    expect(rows[0]!.payload.text).toBe("secret transcript");
    await at0004.close();
  });
});
