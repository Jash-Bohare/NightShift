"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUsdc } from "@nightshift/shared/money";
import { MoonAvatar } from "../../components/ui/MoonAvatar";
import { Button } from "../../components/ui/Button";
import { ErrorPanel, EmptyPanel, LoadingPanel, PageFrame } from "../../components/Product";
import { serverGet, type DirectoryResponse, type DirectoryAgent } from "../../lib/api";
import { getSepoliaClient, readRegistrarResolver } from "../../lib/chain";
import { publicEnv } from "../../lib/public-env";
import { formatPercent } from "../../lib/percent";

type ActivityJob = {
  status: string;
  created_at: string;
  agents: { label: string } | { label: string }[] | null;
};
type SortMode = "price" | "reputation" | "recent";

function atomicFromUsdc(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  if (!/^(?:\d+)(?:\.\d{0,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return (BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0")).toString();
}

function useDirectory(params: URLSearchParams) {
  return useQuery({
    queryKey: ["directory", params.toString()],
    queryFn: ({ signal }) =>
      serverGet<DirectoryResponse>(`/directory?${params.toString()}`, signal),
  });
}

export default function DirectoryPage() {
  const [skill, setSkill] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("price");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchText.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchText]);

  const priceAtomic = useMemo(() => atomicFromUsdc(maxPrice), [maxPrice]);
  const invalidPrice = maxPrice.trim() !== "" && priceAtomic === null;
  const query = useMemo(() => {
    const params = new URLSearchParams({
      status: "available",
      sort,
      page: String(page),
      limit: "20",
    });
    if (skill) params.set("skill", skill);
    if (priceAtomic !== null) params.set("maxPrice", priceAtomic);
    if (search) params.set("search", search);
    return params;
  }, [page, priceAtomic, search, skill, sort]);
  const directory = useDirectory(query);
  const activity = useActivity();

  function changeFilter(change: () => void) {
    change();
    setPage(1);
  }

  function clearFilters() {
    setSkill("");
    setMaxPrice("");
    setSearchText("");
    setSearch("");
    setSort("price");
    setPage(1);
  }

  const totalPages = directory.data
    ? Math.max(1, Math.ceil(directory.data.total / directory.data.limit))
    : 1;

  return (
    <PageFrame
      kicker="Directory"
      title="Tonight’s"
      accent="roster."
      description="Any agent can hire these workers by name. The ENS mark appears only after this browser verifies the resolver against the Nightshift registrar on Sepolia."
      actions={
        <Link className="button button--ink" href="/launch">
          Launch a worker →
        </Link>
      }
    >
      <div className="filter-bar" aria-label="Directory filters">
        <div className="skill-tabs" role="group" aria-label="Skill">
          {(
            [
              ["", "All"],
              ["transcribe:ta", "Tamil"],
              ["transcribe:hi", "Hindi"],
              ["transcribe:en", "English"],
            ] as const
          ).map(([value, label]) => (
            <button
              aria-pressed={skill === value}
              className="skill-tab"
              key={value}
              onClick={() => changeFilter(() => setSkill(value))}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <label className="control-label">
          Max USDC per unit
          <input
            aria-label="Maximum price in USDC"
            className="form-control form-control--mono"
            inputMode="decimal"
            placeholder="Any"
            value={maxPrice}
            onChange={(event) => changeFilter(() => setMaxPrice(event.target.value))}
          />
        </label>
        <label className="control-label">
          Sort by
          <select
            className="form-control"
            value={sort}
            onChange={(event) => changeFilter(() => setSort(event.target.value as SortMode))}
          >
            <option value="price">Cheapest first</option>
            <option value="reputation">Most successful</option>
            <option value="recent">Recently updated</option>
          </select>
        </label>
        <label className="control-label directory-search">
          Search names
          <input
            aria-label="Search names"
            className="form-control form-control--mono"
            maxLength={64}
            placeholder="Search names"
            value={searchText}
            onChange={(event) => changeFilter(() => setSearchText(event.target.value))}
          />
        </label>
        {(skill || maxPrice || searchText || sort !== "price") && (
          <Button size="small" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>
      {invalidPrice && (
        <p className="field-error" role="alert">
          Enter a non-negative amount with up to 6 decimal places.
        </p>
      )}

      <section className="card hard-shadow directory-table" aria-label="Nightshift workers">
        {directory.isPending ? (
          <LoadingPanel label="Reading the live directory…" />
        ) : directory.isError ? (
          <ErrorPanel message={directory.error.message} onRetry={() => void directory.refetch()} />
        ) : directory.data.agents.length === 0 ? (
          <EmptyPanel
            title={`No ${skill ? skill.split(":")[1] : "available"} workers on shift.`}
            detail="This is an empty result from the live directory. Change your filters or check again later."
          />
        ) : (
          <>
            <div className="directory-head" aria-hidden="true">
              <span />
              <span>Worker</span>
              <span>Rate</span>
              <span>Record</span>
              <span>Tonight · UTC</span>
              <span>Status / ENS</span>
            </div>
            {directory.data.agents.map((agent) => (
              <DirectoryRow key={agent.label} agent={agent} jobs={activity.data ?? []} />
            ))}
            <div className="directory-foot">
              <span>Orange = settled · red = refused budget · pale area = remaining shift</span>
              <span>
                {directory.data.total} workers · page {directory.data.page} of {totalPages}
              </span>
            </div>
            <div className="pagination">
              <Button
                size="small"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                ← Previous
              </Button>
              <span className="mono">
                Page {page} / {totalPages}
              </span>
              <Button
                size="small"
                disabled={page >= totalPages}
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              >
                Next →
              </Button>
            </div>
          </>
        )}
      </section>
      {activity.isError && (
        <p className="muted small-note">Job timeline unavailable: {activity.error.message}</p>
      )}
      {!publicEnv.sepoliaRpcUrl && (
        <p className="muted small-note">
          ENS badges remain unchecked until a Sepolia RPC URL is configured.
        </p>
      )}
    </PageFrame>
  );
}

function useActivity() {
  return useQuery({
    queryKey: ["directory-activity"],
    queryFn: async ({ signal }) =>
      (await serverGet<{ jobs: ActivityJob[] }>("/jobs/activity?limit=1000", signal)).jobs,
    staleTime: 30_000,
  });
}

function DirectoryRow({ agent, jobs }: { agent: DirectoryAgent; jobs: ActivityJob[] }) {
  const verifier = useQuery({
    queryKey: ["ens-resolver-check", agent.label, agent.resolver],
    enabled: Boolean(publicEnv.sepoliaRpcUrl && publicEnv.registrarAddress),
    queryFn: async () => {
      const registrarResolver = await readRegistrarResolver(agent.label);
      const nameResolver = await getSepoliaClient().getEnsResolver({ name: agent.ensName });
      return (
        registrarResolver.toLowerCase() === agent.resolver.toLowerCase() &&
        nameResolver?.toLowerCase() === agent.resolver.toLowerCase()
      );
    },
    retry: 1,
  });
  const agentJobs = jobs.filter((job) => {
    const relation = Array.isArray(job.agents) ? job.agents[0] : job.agents;
    return relation?.label === agent.label;
  });
  const success = agent.reputation?.success;
  const unit = agent.price.unit ?? "unit";
  const statusTone =
    agent.status === "active" ? "green" : agent.status === "paused_budget" ? "red" : "muted";

  return (
    <Link className="directory-row" href={`/agents/${encodeURIComponent(agent.label)}`}>
      <MoonAvatar size={44} label={agent.label} />
      <span className="directory-identity">
        <strong>{agent.ensName}</strong>
        <small>
          {agent.skill ?? "Skill not listed"} · {agent.model ?? "Model not listed"}
        </small>
      </span>
      <span className="mono tnum rate-value">
        {agent.price.amount === null ? "—" : formatUsdc(BigInt(agent.price.amount))}
        <small>/{unit}</small>
      </span>
      <span className="mono directory-reputation">
        <strong>{success === undefined ? "new" : formatPercent(success)}</strong>
        <small>{agent.reputation?.jobs ?? 0} jobs</small>
      </span>
      <ShiftStrip jobs={agentJobs} />
      <span className="directory-stamps">
        <span className={`stamp stamp--${statusTone}`}>{agent.status.replaceAll("_", " ")}</span>
        {verifier.isPending && publicEnv.sepoliaRpcUrl && <small className="mono">checking…</small>}
        {verifier.data === true && <span className="stamp stamp--blue">✓ ENS VERIFIED</span>}
        {verifier.isError && <small className="mono muted">not verified</small>}
        {verifier.data === false && <small className="mono muted">resolver mismatch</small>}
      </span>
    </Link>
  );
}

function ShiftStrip({ jobs }: { jobs: ActivityJob[] }) {
  const hour = (date: string) => {
    const time = new Date(date);
    return (time.getUTCHours() * 3600 + time.getUTCMinutes() * 60 + time.getUTCSeconds()) / 864;
  };
  const now = new Date();
  const nowPercent =
    (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()) / 864;
  return (
    <span className="shift-cell">
      <span className="shift-strip" aria-label="Today's jobs on a 24 hour UTC timeline">
        <span className="shift-rest" style={{ left: `${nowPercent}%` }} />
        <span className="shift-now" style={{ left: `${nowPercent}%` }} />
        {jobs.map((job, index) => (
          <span
            aria-label={`${job.status} at ${job.created_at}`}
            className={`shift-tick ${job.status === "settled" ? "shift-tick--paid" : job.status === "refused_budget" ? "shift-tick--refused" : ""}`}
            key={`${job.created_at}-${index}`}
            style={{ left: `${hour(job.created_at)}%` }}
          />
        ))}
      </span>
      <span className="shift-hours mono">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </span>
    </span>
  );
}
