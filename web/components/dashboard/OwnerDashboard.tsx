"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUsdc } from "@nightshift/shared/money";
import { Button } from "../ui/Button";
import { ChandaMama } from "../ui/ChandaMama";
import { Chip } from "../ui/Chip";
import { MoonAvatar } from "../ui/MoonAvatar";
import { Stamp } from "../ui/Stamp";
import { EnsName } from "../ui/EnsName";
import { EmptyPanel, ErrorPanel, LoadingPanel, PageFrame } from "../Product";
import { RecordsDrawer } from "../RecordsDrawer";
import { serverGet, serverSend } from "../../lib/api";
import {
  ensAppUrl,
  etherscanTransactionUrl,
  hashscanAccountUrl,
  hashscanTransactionUrl,
  hcsMessageUrl,
} from "../../lib/explorers";
import { atomicFromDecimal, decimalFromAtomic } from "../../lib/launch";
import {
  agentStatusStamp,
  capUsedPercent,
  creditsSpentSince,
  formatUsdMicro,
  ownerJobStatusLabel,
  parseOwnerJobs,
  parseOwnerPayouts,
  parseZgCredits,
  payoutStatusLabel,
  type OwnerAgent,
  type OwnerDashboard,
} from "../../lib/owner";
import { publicEnv } from "../../lib/public-env";
import { formatCountdownToUtcMidnight } from "../../lib/time";
import { useClock } from "../../lib/use-clock";

export type TokenFn = () => Promise<string | null>;

export const frame = { kicker: "Owner dashboard", title: "Your", accent: "night shift." };

export async function token(getToken: TokenFn): Promise<string> {
  const t = await getToken();
  if (!t) throw new Error("Privy did not provide an access token. Sign out and sign in again.");
  return t;
}

/** "Payday in hh:mm:ss" — the next 00:00 UTC, when settled earnings are paid out. */
function PaydayLine() {
  const now = useClock();
  return (
    <p className="mono small-note dash-payday">
      Payday in{" "}
      <b className="tnum">{now === null ? "––:––:––" : formatCountdownToUtcMidnight(now)}</b> ·
      00:00 UTC
    </p>
  );
}

/**
 * The owner's live 0G credit balance, read server-side with the stored read-only mk- keys.
 * The first reading on this page is the baseline, so a paid run shows the balance going down.
 */
function ZgCredits({ getToken }: { getToken: TokenFn }) {
  const credits = useQuery({
    queryKey: ["owner-zg-credits"],
    queryFn: async ({ signal }) =>
      parseZgCredits(await serverGet<unknown>("/me/zg-credits", signal, await token(getToken))),
    refetchInterval: 15_000,
  });
  const firstSeen = useRef(new Map<string, string>());
  if (credits.isPending)
    return <p className="mono small-note dash-credits">0G credits left: reading…</p>;
  if (credits.isError)
    return <p className="mono small-note dash-credits">0G credits left: unavailable right now</p>;
  return (
    <>
      {credits.data.accounts.map((account) => {
        const id = account.workers.join(",");
        const label = credits.data.accounts.length > 1 ? ` (${account.workers.join(", ")})` : "";
        if ("error" in account)
          return (
            <p className="mono small-note dash-credits" key={id}>
              0G credits left{label}: unavailable right now
            </p>
          );
        const first = firstSeen.current.get(id) ?? account.creditBalanceUsdMicro;
        if (!firstSeen.current.has(id)) firstSeen.current.set(id, first);
        const spent = creditsSpentSince(first, account.creditBalanceUsdMicro);
        return (
          <p className="mono small-note dash-credits" key={id}>
            0G credits left{label}:{" "}
            <b className="tnum">${formatUsdMicro(account.creditBalanceUsdMicro)}</b>
            {spent !== "0" && (
              <span className="text-orange">
                {" "}
                · ↓ ${formatUsdMicro(spent)} since you opened this page
              </span>
            )}
          </p>
        );
      })}
    </>
  );
}

export function Dashboard({ data, getToken }: { data: OwnerDashboard; getToken: TokenFn }) {
  const earned = data.agents.reduce((s, a) => s + BigInt(a.today.earnedAtomic), 0n);
  const spent = data.agents.reduce((s, a) => s + BigInt(a.today.spentUsdMicro), 0n);
  const refused = data.agents.reduce((s, a) => s + a.today.jobsRefused, 0);
  const [drawerAgent, setDrawerAgent] = useState<OwnerAgent | null>(null);
  return (
    <PageFrame
      {...frame}
      description="Live from your workers. Refreshes every few seconds; every number links to its proof."
    >
      <section className="dash-hero card hard-shadow section-block">
        <ChandaMama variant="sipping" />
        <div>
          <h2 className="section-title">
            Your workers earned <span className="text-orange">{formatUsdc(earned)} USDC</span>{" "}
            today.
          </h2>
          <p>
            You keep 90% at payday (00:00 UTC). 0G credits used today: $
            {formatUsdMicro(spent.toString())}.
            {refused > 0
              ? ` ${refused} job${refused === 1 ? "" : "s"} refused by your budget cap — buyers were not charged.`
              : ""}
          </p>
          <PaydayLine />
          {data.agents.length > 0 && <ZgCredits getToken={getToken} />}
          <PayoutAccount owner={data.owner!} getToken={getToken} />
        </div>
      </section>

      <section className="section-block" aria-label="Your workers">
        <div className="kick">Roster · {data.agents.length}</div>
        <div className="dash-roster">
          {data.agents.map((agent) => (
            <AgentRow
              agent={agent}
              getToken={getToken}
              key={agent.id}
              onRecords={() => setDrawerAgent(agent)}
            />
          ))}
        </div>
      </section>

      <Ledger getToken={getToken} />
      <Payouts getToken={getToken} />
      {drawerAgent && (
        <RecordsDrawer
          agent={drawerAgent}
          ownerAddress={data.owner!.evmAddress}
          getToken={getToken}
          onClose={() => setDrawerAgent(null)}
        />
      )}
    </PageFrame>
  );
}

function PayoutAccount({
  owner,
  getToken,
}: {
  owner: NonNullable<OwnerDashboard["owner"]>;
  getToken: TokenFn;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(owner.hederaPayoutAccount ?? "");
  const save = useMutation({
    mutationFn: async (account: string | null) =>
      serverSend("/me", {
        method: "PATCH",
        body: { hederaPayoutAccount: account },
        bearerToken: await token(getToken),
      }),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ["owner-dashboard"] });
    },
  });
  const valid = /^0\.0\.\d{1,12}$/.test(value.trim());
  const link = owner.hederaPayoutAccount ? hashscanAccountUrl(owner.hederaPayoutAccount) : null;
  if (!editing)
    return (
      <p className="mono small-note">
        Payout account:{" "}
        {owner.hederaPayoutAccount ? (
          link ? (
            <a href={link} target="_blank" rel="noreferrer noopener">
              {owner.hederaPayoutAccount} ↗
            </a>
          ) : (
            owner.hederaPayoutAccount
          )
        ) : (
          <b>not set — earnings stay in each worker’s account until you add one</b>
        )}{" "}
        <button className="chip chip__action" type="button" onClick={() => setEditing(true)}>
          {owner.hederaPayoutAccount ? "change" : "add"}
        </button>
      </p>
    );
  return (
    <div className="dash-inline-form">
      <input
        aria-label="Hedera payout account"
        className="form-control form-control--mono"
        placeholder="0.0.12345"
        spellCheck={false}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button
        variant="ink"
        disabled={!valid || save.isPending}
        onClick={() => save.mutate(value.trim())}
      >
        {save.isPending ? "Checking…" : "Save"}
      </Button>
      {owner.hederaPayoutAccount && (
        <Button disabled={save.isPending} onClick={() => save.mutate(null)}>
          Remove
        </Button>
      )}
      <Button disabled={save.isPending} onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {save.isError && (
        <p className="field-error" role="alert">
          {save.error.message}
        </p>
      )}
    </div>
  );
}

function AgentRow({
  agent,
  getToken,
  onRecords,
}: {
  agent: OwnerAgent;
  getToken: TokenFn;
  onRecords: () => void;
}) {
  const queryClient = useQueryClient();
  const [cap, setCap] = useState(decimalFromAtomic(BigInt(agent.dailyCapUsdMicro)));
  const patch = useMutation({
    mutationFn: async (body: { status?: "active" | "paused_owner"; dailyCapUsdMicro?: string }) =>
      serverSend(`/me/agents/${encodeURIComponent(agent.id)}`, {
        method: "PATCH",
        body,
        bearerToken: await token(getToken),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["owner-dashboard"] }),
  });
  const stamp = agentStatusStamp(agent.status);
  const pct = capUsedPercent(agent.today.spentUsdMicro, agent.dailyCapUsdMicro);
  const capLeft = BigInt(agent.dailyCapUsdMicro) - BigInt(agent.today.spentUsdMicro);
  const capMicro = atomicFromDecimal(cap);
  const capValid = capMicro !== null && capMicro > 0n && capMicro <= 1_000_000_000n;
  const capChanged = capMicro !== null && capMicro.toString() !== agent.dailyCapUsdMicro;
  const canPause = agent.status === "active" || agent.status === "paused_budget";
  const canResume = agent.status === "paused_owner";
  const registerTx = agent.registerTx ? etherscanTransactionUrl(agent.registerTx) : null;
  const account = agent.hederaAccountId ? hashscanAccountUrl(agent.hederaAccountId) : null;

  return (
    <article className="card hard-shadow dash-agent">
      <header className="dash-agent__head">
        <MoonAvatar
          creditsLeft={(capLeft > 0n ? capLeft : 0n).toString()}
          dailyCap={agent.dailyCapUsdMicro}
          label={agent.label}
        />
        <div>
          <Link href={`/agents/${encodeURIComponent(agent.label)}`}>
            <strong>
              <EnsName name={agent.ensName} />
            </strong>
          </Link>
          <span className="mono small-note">
            {agent.skill} · {formatUsdc(BigInt(agent.priceAtomic))} USDC / {agent.priceUnit}
          </span>
        </div>
        <Stamp tone={stamp.tone} tilt="right">
          {stamp.text}
        </Stamp>
      </header>

      <div className="dash-agent__today">
        <div>
          <span className="kick">0G credits today</span>
          <div
            className="budget-bar"
            role="meter"
            aria-label="0G credits used against the daily cap"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <span style={{ width: `${pct}%` }} />
          </div>
          <span className="mono small-note">
            ${formatUsdMicro(agent.today.spentUsdMicro)} of $
            {formatUsdMicro(agent.dailyCapUsdMicro)} ({pct}%)
          </span>
        </div>
        <div>
          <span className="kick">Earned today</span>
          <strong className="text-orange">
            {formatUsdc(BigInt(agent.today.earnedAtomic))} USDC
          </strong>
        </div>
        <div>
          <span className="kick">Jobs settled</span>
          <strong>{agent.today.jobsSettled}</strong>
          {agent.today.jobsRefused > 0 && (
            <span className="mono small-note">{agent.today.jobsRefused} refused, not charged</span>
          )}
        </div>
      </div>

      {agent.status === "paused_budget" && (
        <p className="field-error">
          Out of credits for today: the next job would cost more than the 0G cap has left, so buyers
          are refused before paying. It resumes on its own once a job fits again (after 00:00 UTC,
          or sooner if you raise the cap).
        </p>
      )}

      <div className="dash-agent__controls">
        <label className="control-label dash-cap">
          Daily cap (USD)
          <span className="dash-inline-form">
            <input
              className="form-control form-control--mono"
              inputMode="decimal"
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />
            <Button
              disabled={!capValid || !capChanged || patch.isPending}
              onClick={() => capMicro && patch.mutate({ dailyCapUsdMicro: capMicro.toString() })}
            >
              Save
            </Button>
          </span>
        </label>
        <div className="dash-agent__actions">
          {canPause && (
            <Button
              disabled={patch.isPending}
              onClick={() => patch.mutate({ status: "paused_owner" })}
            >
              Pause
            </Button>
          )}
          {canResume && (
            <Button
              variant="ink"
              disabled={patch.isPending}
              onClick={() => patch.mutate({ status: "active" })}
            >
              Resume
            </Button>
          )}
          <Button disabled={!agent.resolverAddress} onClick={onRecords}>
            Records
          </Button>
        </div>
      </div>
      {cap && !capValid && (
        <p className="field-error">Use a positive amount up to $1,000 (six decimals at most).</p>
      )}
      {patch.isError && (
        <p className="field-error" role="alert">
          {patch.error.message}
        </p>
      )}
      <p className="mono small-note dash-agent__links">
        <a href={ensAppUrl(agent.ensName)} target="_blank" rel="noreferrer noopener">
          ENS ↗
        </a>
        {registerTx && (
          <>
            {" · "}
            <a href={registerTx} target="_blank" rel="noreferrer noopener">
              registration tx ↗
            </a>
          </>
        )}
        {account && (
          <>
            {" · "}
            <a href={account} target="_blank" rel="noreferrer noopener">
              wallet {agent.hederaAccountId} ↗
            </a>
          </>
        )}
        {agent.expiry ? ` · name expires ${agent.expiry.slice(0, 10)}` : ""}
      </p>
    </article>
  );
}

function Ledger({ getToken }: { getToken: TokenFn }) {
  const [page, setPage] = useState(1);
  const jobs = useQuery({
    queryKey: ["owner-jobs", page],
    queryFn: async ({ signal }) =>
      parseOwnerJobs(
        await serverGet<unknown>(`/me/jobs?page=${page}&limit=20`, signal, await token(getToken)),
      ),
    refetchInterval: page === 1 ? 4_000 : false,
    retry: false,
  });
  // Rows that appear after the first load flash (design: "new rows flash yellow").
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!jobs.data) return;
    const ids = jobs.data.items.map((j) => j.id);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const added = ids.filter((id) => !seen.current!.has(id));
    for (const id of ids) seen.current.add(id);
    if (added.length) setFresh(new Set(added));
  }, [jobs.data]);

  return (
    <section className="section-block" aria-label="Job ledger">
      <div className="kick">Ledger · live</div>
      {jobs.isPending ? (
        <LoadingPanel label="Loading your job ledger…" />
      ) : jobs.isError ? (
        <ErrorPanel message={jobs.error.message} onRetry={() => void jobs.refetch()} />
      ) : jobs.data.items.length === 0 ? (
        <EmptyPanel
          title="No jobs yet."
          detail="No jobs yet — run the buyer console against one of your workers."
          action={{ href: "/console", label: "Open the buyer console →" }}
        />
      ) : (
        <div className="card hard-shadow owner-jobs">
          <table className="mono ledger">
            <thead>
              <tr>
                <th>When (UTC)</th>
                <th>Worker</th>
                <th>Status</th>
                <th>Units</th>
                <th>Price</th>
                <th>0G cost</th>
                <th>Proof</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.items.map((job) => {
                const tx = job.hederaTxId ? hashscanTransactionUrl(job.hederaTxId) : null;
                const hcs =
                  job.hcsSequence && publicEnv.hederaHcsTopicId
                    ? hcsMessageUrl(publicEnv.hederaHcsTopicId, job.hcsSequence)
                    : null;
                const refused = job.status === "refused_budget";
                return (
                  <tr className={fresh.has(job.id) ? "ledger-row--new" : undefined} key={job.id}>
                    <td>{job.createdAt.slice(0, 16).replace("T", " ")}</td>
                    <td>{job.label}</td>
                    <td className="ledger-status">
                      {refused ? (
                        <Stamp className="stamp--sm" tone="red">
                          REFUSED · NOT CHARGED
                        </Stamp>
                      ) : (
                        ownerJobStatusLabel(job.status)
                      )}
                    </td>
                    <td>{job.units}</td>
                    <td>
                      {refused ? (
                        <span className="muted">not charged</span>
                      ) : (
                        `${formatUsdc(BigInt(job.priceAtomic))} USDC`
                      )}
                    </td>
                    <td>
                      {job.zgCostUsdMicro === null ? "—" : `$${formatUsdMicro(job.zgCostUsdMicro)}`}
                    </td>
                    <td>
                      {!tx && !job.zgRequestId && !hcs ? (
                        <span className="muted">—</span>
                      ) : (
                        <div className="ledger-proof">
                          {tx && (
                            <Chip href={tx} rail="hedera">
                              HashScan
                            </Chip>
                          )}
                          {job.zgRequestId && (
                            <Chip copyText={job.zgRequestId} rail="0g">
                              0G {job.zgRequestId.slice(0, 8)}…
                            </Chip>
                          )}
                          {hcs && (
                            <Chip href={hcs} rail="hedera">
                              HCS #{job.hcsSequence}
                            </Chip>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="owner-jobs__pager">
            <button
              className="button button--small"
              type="button"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              ← Newer
            </button>
            <button
              className="button button--small"
              type="button"
              disabled={!jobs.data.nextPage}
              onClick={() => setPage(page + 1)}
            >
              Older →
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Payouts({ getToken }: { getToken: TokenFn }) {
  const payouts = useQuery({
    queryKey: ["owner-payouts"],
    queryFn: async ({ signal }) =>
      parseOwnerPayouts(
        await serverGet<unknown>("/me/payouts?limit=20", signal, await token(getToken)),
      ),
    refetchInterval: 30_000,
    retry: false,
  });
  return (
    <section className="section-block" aria-label="Payouts">
      <div className="kick">Paydays · 90% to you, 10% to Nightshift</div>
      {payouts.isPending ? (
        <LoadingPanel label="Loading payouts…" />
      ) : payouts.isError ? (
        <ErrorPanel message={payouts.error.message} onRetry={() => void payouts.refetch()} />
      ) : payouts.data.items.length === 0 ? (
        <EmptyPanel
          title="No paydays yet."
          detail="Settled earnings are paid out at 00:00 UTC to your payout account."
        />
      ) : (
        <div className="card hard-shadow owner-jobs">
          <table className="mono ledger">
            <thead>
              <tr>
                <th>Payday (00:00 UTC)</th>
                <th>Worker</th>
                <th>Gross (USDC)</th>
                <th>You (90%)</th>
                <th>Fee (10%)</th>
                <th>Status</th>
                <th>Transfer</th>
              </tr>
            </thead>
            <tbody>
              {payouts.data.items.map((p) => {
                const tx = p.transactionId ? hashscanTransactionUrl(p.transactionId) : null;
                return (
                  <tr key={p.id}>
                    <td>{p.payoutDate}</td>
                    <td>{p.label}</td>
                    <td>{formatUsdc(BigInt(p.grossAtomic))}</td>
                    <td>{formatUsdc(BigInt(p.ownerAtomic))}</td>
                    <td>{formatUsdc(BigInt(p.feeAtomic))}</td>
                    <td>{payoutStatusLabel(p.status)}</td>
                    <td>
                      {tx ? (
                        <Chip href={tx} rail="hedera">
                          HashScan
                        </Chip>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
