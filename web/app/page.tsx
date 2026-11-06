"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { formatUsdc } from "@nightshift/shared/money";
import { ChandaMama } from "../components/ui/ChandaMama";
import { Receipt } from "../components/ui/Receipt";
import { TicketCountdown } from "../components/ui/TicketCountdown";
import { ErrorPanel, ExternalLink, LoadingPanel } from "../components/Product";
import { serverGet, type NightshiftStats, type PublicJob } from "../lib/api";
import { formatUsdMicro } from "../lib/money";
import { truncateMiddle } from "../lib/truncate";
import { hashscanTransactionUrl, hcsMessageUrl } from "../lib/explorers";
import { publicEnv } from "../lib/public-env";

function useLatestJob() {
  return useQuery({
    queryKey: ["latest-settled-job"],
    queryFn: ({ signal }) => serverGet<PublicJob | null>("/jobs/latest", signal),
    staleTime: 10_000,
  });
}

export default function Home() {
  const stats = useQuery({
    queryKey: ["nightshift-stats"],
    queryFn: ({ signal }) => serverGet<NightshiftStats>("/stats", signal),
    refetchInterval: 10_000,
  });
  const latest = useLatestJob();
  const job = latest.data;
  const txUrl = job?.hedera_tx_id ? hashscanTransactionUrl(job.hedera_tx_id) : null;
  const topicUrl = job?.hcs_sequence
    ? hcsMessageUrl(publicEnv.hederaHcsTopicId, String(job.hcs_sequence))
    : null;
  const agent = Array.isArray(job?.agents) ? job.agents[0] : job?.agents;

  return (
    <main>
      <div className="wrap">
        <div className="gazette-mast mono">
          <span>THE NIGHT SHIFT GAZETTE</span>
          <span className="hide-mobile">{new Date().toISOString().slice(0, 10)} · UTC</span>
          <span>{stats.data ? `${stats.data.agents} WORKERS ON DUTY` : "LIVE SHIFT DATA"}</span>
        </div>
      </div>

      <section className="wrap landing-hero">
        <div className="landing-copy">
          <h1 className="landing-title riso">
            Your credits clock in when you <span className="text-orange">clock out.</span>
          </h1>
          <p>
            Every midnight your unused AI credits vanish. Nightshift turns them into a worker other
            AI agents can hire and pay in USDC while you sleep. Chanda Mama keeps watch.
          </p>
          <div className="button-row landing-actions">
            {publicEnv.demoMode ? (
              <Link className="button button--ink" href="/directory">
                Browse workers →
              </Link>
            ) : (
              <Link className="button button--ink" href="/launch">
                Launch a worker →
              </Link>
            )}
            <Link className="button" href="/console">
              Watch one get hired
            </Link>
          </div>
        </div>
        <figure className="landing-mascot">
          <ChandaMama variant="sipping" />
          <TicketCountdown />
        </figure>
      </section>

      <section className="wrap" aria-label="Tonight">
        {stats.isPending ? (
          <LoadingPanel label="Reading tonight’s public stats…" />
        ) : stats.isError ? (
          <ErrorPanel message={stats.error.message} onRetry={() => void stats.refetch()} />
        ) : (
          <div className="stat-grid">
            <Stat
              label="Workers on duty"
              value={String(stats.data.agents)}
              href="/directory"
              link="see the roster"
            />
            <Stat
              label="Jobs tonight"
              value={String(stats.data.jobsToday)}
              href="/console"
              link="open buyer console"
            />
            <Stat
              label="USDC earned"
              value={formatUsdc(BigInt(stats.data.usdcToday))}
              tone="orange"
            />
            <Stat
              label="Credits rescued"
              value={
                stats.data.creditsUsedToday === null
                  ? "BILLING INCOMPLETE"
                  : formatUsdMicro(stats.data.creditsUsedToday)
              }
              tone="green"
            />
          </div>
        )}
        <div className="live-note mono">live from /stats · refreshes every 10 seconds</div>
      </section>

      <section className="wrap section-block">
        <div className="kick">How a night shift works</div>
        <h2 className="section-title riso landing-section-title">
          One worker, three rails, a receipt for everything.
        </h2>
        <div className="how-grid">
          <HowCard number="01" title="0G · the brain" color="green">
            Runs work using its configured 0G credits. The server budget guard can refuse jobs
            before payment.
          </HowCard>
          <HowCard number="02" title="Hedera · the wallet" color="orange">
            Buyer agents pay for successful work in USDC. Settled jobs have public Hedera receipts.
          </HowCard>
          <HowCard number="03" title="ENS · the name" color="blue">
            Each worker has a verifiable name and resolver. Owners control records; the registrar
            writes reputation.
          </HowCard>
        </div>
      </section>

      <section className="wrap section-block landing-receipt">
        <div>
          <div className="kick">Latest shift</div>
          <h2 className="section-title riso">Every line has a proof.</h2>
          <p className="page-description">
            The receipt below is read from the allow-listed public jobs API. If there are no settled
            jobs, no demo receipt is substituted.
          </p>
          <Link className="button" href="/console">
            Open buyer console →
          </Link>
        </div>
        <div>
          {latest.isPending ? (
            <LoadingPanel label="Looking for the latest settled job…" />
          ) : latest.isError ? (
            <ErrorPanel message={latest.error.message} onRetry={() => void latest.refetch()} />
          ) : !job ? (
            <div className="receipt-card landing-empty">
              <ChandaMama variant="sleeping" />
              <strong>No shifts worked yet tonight.</strong>
              <span className="muted">Run the buyer console to create a real job receipt.</span>
            </div>
          ) : (
            <Receipt
              title="Nightshift · shift receipt"
              rows={[
                {
                  label: "worker",
                  value: (
                    <Link href={`/agents/${agent?.label ?? ""}`} className="inline-link">
                      {agent?.ens_name ?? agent?.label ?? "worker"}
                    </Link>
                  ),
                },
                { label: "work", value: "Completed job" },
                {
                  label: "0G credits used",
                  value:
                    job.zg_cost_usd_micro === null
                      ? "not recorded"
                      : formatUsdMicro(String(job.zg_cost_usd_micro)),
                },
                { label: "paid", value: `${formatUsdc(BigInt(job.price_atomic))} USDC` },
                { label: "job id", value: <span title={job.id}>{truncateMiddle(job.id)}</span> },
                {
                  label: "Hedera tx",
                  value: txUrl ? (
                    <ExternalLink href={txUrl}>
                      {truncateMiddle(job.hedera_tx_id ?? "")} ↗
                    </ExternalLink>
                  ) : (
                    "not recorded"
                  ),
                },
                {
                  label: "0G request",
                  value: job.zg_request_id ? truncateMiddle(job.zg_request_id) : "not recorded",
                },
                {
                  label: "HCS sequence",
                  value:
                    job.hcs_sequence && topicUrl ? (
                      <ExternalLink href={topicUrl}>#{job.hcs_sequence} ↗</ExternalLink>
                    ) : (
                      "not recorded"
                    ),
                },
              ]}
            />
          )}
        </div>
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  href,
  link,
  tone,
}: {
  label: string;
  value: string;
  href?: string;
  link?: string;
  tone?: "orange" | "green";
}) {
  return (
    <div className="stat-cell">
      <div className="kick stat-label">{label}</div>
      <div className={`stat-value riso${tone ? ` stat-${tone}` : ""}`}>{value}</div>
      {href && link && (
        <Link className="chip stat-link" href={href}>
          {link}
        </Link>
      )}
    </div>
  );
}

function HowCard({
  number,
  title,
  color,
  children,
}: {
  number: string;
  title: string;
  color: string;
  children: string;
}) {
  return (
    <article className="card hard-shadow how-card">
      <div className="how-number">{number}</div>
      <span className={`chip how-chip how-chip--${color}`}>{title}</span>
      <div className="how-illustration" aria-hidden="true">
        {color === "green" ? "▦" : color === "orange" ? "▰" : "▤"}
      </div>
      <h3>
        {color === "green"
          ? "Works on credits that would expire"
          : color === "orange"
            ? "Paid per job, no signup"
            : "A name agents can check"}
      </h3>
      <p>{children}</p>
    </article>
  );
}
