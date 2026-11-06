"use client";

import { ownerJobStatusLabel, parseOwnerJobs } from "../../lib/owner";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePrivy } from "@privy-io/react-auth";
import { formatUsdc } from "@nightshift/shared/money";
import { Button } from "../../components/ui/Button";
import { ChandaMama } from "../../components/ui/ChandaMama";
import { EmptyPanel, ErrorPanel, LoadingPanel, PageFrame } from "../../components/Product";
import { publicEnv } from "../../lib/public-env";

export default function DashboardPage() {
  if (!publicEnv.privyAppId) {
    return (
      <PageFrame
        kicker="Owner dashboard"
        title="Your"
        accent="night shift."
        description="Sign in to see owner-scoped worker data."
      >
        <ErrorPanel message="Privy is not configured in this environment. No owner information or statistics are displayed." />
      </PageFrame>
    );
  }
  return <AuthenticatedDashboard />;
}

function AuthenticatedDashboard() {
  const { ready, authenticated, login, getAccessToken } = usePrivy();
  const [loginError, setLoginError] = useState<string | null>(null);
  if (!ready) {
    return (
      <main className="wrap product-page">
        <LoadingPanel label="Checking Privy session…" />
      </main>
    );
  }
  if (!authenticated) {
    return (
      <PageFrame
        kicker="Owner dashboard"
        title="Your"
        accent="night shift."
        description="Your private worker roster and live ledger."
      >
        <div className="dashboard-gate card hard-shadow">
          <ChandaMama variant="sleeping" />
          <h2 className="section-title">Sign in to your owner account.</h2>
          <p>
            Only owner-scoped API data belongs here. We will not infer your roster from public
            agents.
          </p>
          <Button
            variant="ink"
            onClick={() => {
              try {
                login();
                setLoginError(null);
              } catch (error) {
                setLoginError(error instanceof Error ? error.message : "Privy sign in failed.");
              }
            }}
          >
            Sign in with Privy
          </Button>
          {loginError && (
            <p className="field-error" role="alert">
              {loginError}
            </p>
          )}
          <Link className="button" href="/directory">
            Browse public workers
          </Link>
        </div>
      </PageFrame>
    );
  }

  return <OwnerDataBoundary accessToken={getAccessToken} />;
}

function OwnerDataBoundary({ accessToken }: { accessToken: () => Promise<string | null> }) {
  const dashboard = useQuery({
    queryKey: ["owner-dashboard"],
    queryFn: async ({ signal }) => {
      const token = await accessToken();
      if (!token)
        throw new Error("Privy did not provide an access token. Sign out and sign in again.");
      const response = await fetch(`${publicEnv.serverUrl}/me`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Owner API request failed (${response.status}).`);
      const data: unknown = await response.json();
      if (!isOwnerDashboard(data)) throw new Error("The owner API returned an invalid response.");
      return data;
    },
    retry: false,
  });

  if (dashboard.isPending) {
    return (
      <main className="wrap product-page">
        <LoadingPanel label="Loading owner-scoped dashboard data…" />
      </main>
    );
  }
  if (dashboard.isError) {
    return (
      <PageFrame
        kicker="Owner dashboard"
        title="Your"
        accent="night shift."
        description="Private data is never replaced with public or sample statistics."
      >
        <ErrorPanel message={dashboard.error.message} onRetry={() => void dashboard.refetch()} />
      </PageFrame>
    );
  }
  const data = dashboard.data;
  if (!data.owner)
    return (
      <PageFrame
        kicker="Owner dashboard"
        title="Your"
        accent="night shift."
        description="This verified account does not have a NightShift owner record yet."
      >
        <EmptyPanel
          title="No workers are registered to this account."
          detail="The launch wizard can show requirements, but submission is unavailable until a secure owner launch API is deployed."
        />
        <Link className="button button--ink" href="/launch">
          Review launch requirements →
        </Link>
      </PageFrame>
    );

  return (
    <PageFrame
      kicker="Owner dashboard"
      title="Your"
      accent="night shift."
      description="Roster data is scoped to the verified Privy account. Usage and payout statistics are omitted unless the server can verify them."
    >
      <section className="card hard-shadow section-block">
        <div className="kick">Verified owner</div>
        <code className="mono">{data.owner.evmAddress}</code>
      </section>
      {data.agents.length === 0 ? (
        <EmptyPanel
          title="No workers are registered to this account."
          detail="Review the launch requirements. The browser does not collect provider or wallet secrets."
        />
      ) : (
        <section className="section-block" aria-label="Your workers">
          <div className="kick">Your workers · {data.agents.length}</div>
          <div className="dashboard-agent-list">
            {data.agents.map((agent) => (
              <Link
                className="card hard-shadow dashboard-agent"
                href={`/agents/${encodeURIComponent(agent.label)}`}
                key={agent.id}
              >
                <strong>{agent.ensName}</strong>
                <span className="mono">
                  {agent.skill} · {agent.status}
                </span>
                <span className="mono">
                  {formatUsdc(BigInt(agent.priceAtomic))} USDC / {agent.priceUnit}
                </span>
                <span className="mono">0G daily cap ${formatUsdMicro(agent.dailyCapUsdMicro)}</span>
                <span className="mono">
                  Registration{" "}
                  {agent.expiry ? `expires ${agent.expiry.slice(0, 10)}` : "expiry unknown"}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
      <OwnerJobHistory accessToken={accessToken} />
      <p className="small-note">
        Pause/resume, pricing changes and payout controls are not available yet. Job outputs and
        buyer accounts are never shown here.
      </p>
    </PageFrame>
  );
}

function OwnerJobHistory({ accessToken }: { accessToken: () => Promise<string | null> }) {
  const [page, setPage] = useState(1);
  const jobs = useQuery({
    queryKey: ["owner-jobs", page],
    queryFn: async ({ signal }) => {
      const token = await accessToken();
      if (!token) throw new Error("Privy did not provide an access token.");
      const response = await fetch(`${publicEnv.serverUrl}/me/jobs?page=${page}&limit=20`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Owner job history request failed (${response.status}).`);
      return parseOwnerJobs(await response.json());
    },
    retry: false,
  });
  return (
    <section className="section-block" aria-label="Your job history">
      <div className="kick">Job history · owner-scoped</div>
      {jobs.isPending ? (
        <LoadingPanel label="Loading your job history…" />
      ) : jobs.isError ? (
        <ErrorPanel message={jobs.error.message} onRetry={() => void jobs.refetch()} />
      ) : jobs.data.items.length === 0 ? (
        <EmptyPanel
          title="No jobs yet."
          detail="Jobs appear here after a buyer runs one of your workers."
        />
      ) : (
        <div className="card hard-shadow owner-jobs">
          <table className="mono">
            <thead>
              <tr>
                <th>When (UTC)</th>
                <th>Worker</th>
                <th>Status</th>
                <th>Price</th>
                <th>0G cost</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.items.map((job) => (
                <tr key={job.id}>
                  <td>{job.createdAt.slice(0, 16).replace("T", " ")}</td>
                  <td>{job.label}</td>
                  <td>{ownerJobStatusLabel(job.status)}</td>
                  <td>{formatUsdc(BigInt(job.priceAtomic))} USDC</td>
                  <td>
                    {job.zgCostUsdMicro === null
                      ? "unknown"
                      : `$${formatUsdMicro(job.zgCostUsdMicro)}`}
                  </td>
                </tr>
              ))}
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

interface OwnerAgent {
  id: string;
  label: string;
  ensName: string;
  skill: string;
  model: string;
  priceAtomic: string;
  priceUnit: string;
  dailyCapUsdMicro: string;
  status: string;
  expiry: string | null;
  createdAt: string;
}

interface OwnerDashboard {
  owner: { evmAddress: string; createdAt: string } | null;
  agents: OwnerAgent[];
}

function isOwnerDashboard(value: unknown): value is OwnerDashboard {
  if (typeof value !== "object" || value === null || !("owner" in value) || !("agents" in value))
    return false;
  const response = value as { owner: unknown; agents: unknown };
  if (!Array.isArray(response.agents)) return false;
  if (
    response.owner !== null &&
    (typeof response.owner !== "object" ||
      response.owner === null ||
      !("evmAddress" in response.owner) ||
      typeof response.owner.evmAddress !== "string" ||
      !("createdAt" in response.owner) ||
      typeof response.owner.createdAt !== "string")
  )
    return false;
  return response.agents.every(
    (agent: unknown) =>
      typeof agent === "object" &&
      agent !== null &&
      "id" in agent &&
      typeof agent.id === "string" &&
      "label" in agent &&
      typeof agent.label === "string" &&
      "ensName" in agent &&
      typeof agent.ensName === "string" &&
      "skill" in agent &&
      typeof agent.skill === "string" &&
      "model" in agent &&
      typeof agent.model === "string" &&
      "priceAtomic" in agent &&
      typeof agent.priceAtomic === "string" &&
      /^\d+$/.test(agent.priceAtomic) &&
      "priceUnit" in agent &&
      typeof agent.priceUnit === "string" &&
      "dailyCapUsdMicro" in agent &&
      typeof agent.dailyCapUsdMicro === "string" &&
      /^\d+$/.test(agent.dailyCapUsdMicro) &&
      "status" in agent &&
      typeof agent.status === "string" &&
      "expiry" in agent &&
      (typeof agent.expiry === "string" || agent.expiry === null) &&
      "createdAt" in agent &&
      typeof agent.createdAt === "string",
  );
}

function formatUsdMicro(value: string): string {
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}
