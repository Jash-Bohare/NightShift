"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { usePrivy } from "@privy-io/react-auth";
import { Button } from "../../components/ui/Button";
import { ChandaMama } from "../../components/ui/ChandaMama";
import { EmptyPanel, ErrorPanel, LoadingPanel, PageFrame } from "../../components/Product";
import { serverGet } from "../../lib/api";
import { parseOwnerDashboard } from "../../lib/owner";
import { publicEnv } from "../../lib/public-env";
import { Dashboard, frame, token, type TokenFn } from "../../components/dashboard/OwnerDashboard";

export default function DashboardPage() {
  if (publicEnv.demoMode)
    return (
      <PageFrame {...frame} description="Owner dashboards run on localhost only.">
        <ErrorPanel message="This is the hosted demo. Owner sign-in only works on localhost:3000 (0G’s Privy app allows only local origins). Public worker pages show the same on-chain data." />
        <Link className="button button--ink" href="/directory">
          Browse workers →
        </Link>
      </PageFrame>
    );
  if (!publicEnv.privyAppId)
    return (
      <PageFrame {...frame} description="Sign in to see owner-scoped worker data.">
        <ErrorPanel message="Privy is not configured in this environment. No owner information or statistics are displayed." />
      </PageFrame>
    );
  return <AuthenticatedDashboard />;
}

function AuthenticatedDashboard() {
  const { ready, authenticated, login, getAccessToken } = usePrivy();
  if (!ready)
    return (
      <main className="wrap product-page">
        <LoadingPanel label="Checking Privy session…" />
      </main>
    );
  if (!authenticated)
    return (
      <PageFrame {...frame} description="Your private worker roster and live ledger.">
        <div className="dashboard-gate card hard-shadow">
          <ChandaMama variant="sleeping" />
          <h2 className="section-title">Sign in to your owner account.</h2>
          <p>Only owner-scoped data appears here; nothing is inferred from public workers.</p>
          <Button variant="ink" onClick={() => login()}>
            Sign in with Privy
          </Button>
          <Link className="button" href="/directory">
            Browse public workers
          </Link>
        </div>
      </PageFrame>
    );
  return <OwnerDataBoundary getToken={getAccessToken} />;
}

function OwnerDataBoundary({ getToken }: { getToken: TokenFn }) {
  const dashboard = useQuery({
    queryKey: ["owner-dashboard"],
    queryFn: async ({ signal }) =>
      parseOwnerDashboard(await serverGet<unknown>("/me", signal, await token(getToken))),
    refetchInterval: 5_000,
    retry: false,
  });

  if (dashboard.isPending)
    return (
      <main className="wrap product-page">
        <LoadingPanel label="Loading your workers…" />
      </main>
    );
  if (dashboard.isError)
    return (
      <PageFrame {...frame} description="Private data is never replaced with sample statistics.">
        <ErrorPanel message={dashboard.error.message} onRetry={() => void dashboard.refetch()} />
      </PageFrame>
    );
  const data = dashboard.data;
  if (!data.owner || data.agents.length === 0)
    return (
      <PageFrame {...frame} description="This account has no workers yet.">
        <EmptyPanel
          title="No workers on shift yet."
          detail="Launch one in about two minutes: pick a skill, a name and a daily cap."
          action={{ href: "/launch", label: "Launch a worker →" }}
        />
      </PageFrame>
    );
  return <Dashboard data={data} getToken={getToken} />;
}
