"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { HEDERA_USDC_TOKEN_ID, OWNER_KEYS, REPUTATION_KEY } from "@nightshift/shared/constants";
import { formatUsdc } from "@nightshift/shared/money";
import { MoonAvatar } from "../../../components/ui/MoonAvatar";
import { EnsName } from "../../../components/ui/EnsName";
import {
  CopyButton,
  EmptyPanel,
  ErrorPanel,
  ExternalLink,
  LoadingPanel,
  PageFrame,
} from "../../../components/Product";
import {
  serverGet,
  type AgentProfile,
  type AgentQuote,
  type DirectoryAgent,
  type PublicJob,
} from "../../../lib/api";
import { getSepoliaClient, readRegistrarResolver } from "../../../lib/chain";
import { publicEnv } from "../../../lib/public-env";
import { truncateMiddle } from "../../../lib/truncate";
import { formatPercent } from "../../../lib/percent";
import {
  etherscanAddressUrl,
  etherscanTransactionUrl,
  hashscanAccountUrl,
  hashscanTransactionUrl,
  hashscanTopicUrl,
} from "../../../lib/explorers";

type LiveRecords = {
  resolver: string | null;
  texts: Record<string, string | null>;
  verified: boolean;
};
type RecentJob = PublicJob & {
  agents?: { label: string; ens_name: string } | { label: string; ens_name: string }[] | null;
};

export default function AgentPage() {
  const params = useParams<{ label: string }>();
  const label = decodeURIComponent(params.label);
  const [codeTab, setCodeTab] = useState<"curl" | "ts">("curl");

  const profile = useQuery({
    queryKey: ["agent-profile", label],
    queryFn: ({ signal }) =>
      serverGet<AgentProfile>(`/agents/${encodeURIComponent(label)}`, signal),
  });
  const directory = useQuery({
    queryKey: ["directory-agent", label],
    queryFn: ({ signal }) =>
      serverGet<DirectoryAgent>(`/directory/${encodeURIComponent(label)}`, signal),
  });
  const quote = useQuery({
    queryKey: ["agent-quote", label, 2],
    queryFn: ({ signal }) =>
      serverGet<AgentQuote>(`/a/${encodeURIComponent(label)}/quote?units=2`, signal),
  });

  const records = useQuery({
    queryKey: ["live-ens-records", label, profile.data?.ensName],
    enabled: Boolean(profile.data?.ensName && publicEnv.sepoliaRpcUrl),
    queryFn: async (): Promise<LiveRecords> => {
      if (!profile.data) throw new Error("Agent profile is not available.");
      const client = getSepoliaClient();
      const name = profile.data.ensName;
      const [resolver, registrarResolver, ...values] = await Promise.all([
        client.getEnsResolver({ name }),
        readRegistrarResolver(label),
        ...[...OWNER_KEYS, REPUTATION_KEY].map((key) => client.getEnsText({ name, key })),
      ]);
      const texts = Object.fromEntries(
        [...OWNER_KEYS, REPUTATION_KEY].map((key, index) => [key, values[index] ?? null]),
      );
      return {
        resolver: resolver ?? null,
        texts,
        verified: Boolean(
          resolver &&
          profile.data.resolver &&
          resolver.toLowerCase() === profile.data.resolver.toLowerCase() &&
          registrarResolver.toLowerCase() === profile.data.resolver.toLowerCase(),
        ),
      };
    },
    retry: 1,
  });

  const jobs = useQuery({
    queryKey: ["agent-jobs", label],
    queryFn: ({ signal }) =>
      serverGet<RecentJob[]>(`/agents/${encodeURIComponent(label)}/jobs?limit=10`, signal),
    refetchInterval: 30_000,
  });

  const profileData = profile.data;
  const directoryData = directory.data;
  const quoteData = quote.data;
  const addressUrl = directoryData?.owner ? etherscanAddressUrl(directoryData.owner) : null;
  const payToUrl = profileData?.payTo ? hashscanAccountUrl(profileData.payTo) : null;
  const registerTxUrl = profileData?.registerTx
    ? etherscanTransactionUrl(profileData.registerTx)
    : null;
  const endpoint = records.data?.texts["agent-endpoint[x402]"] ?? directoryData?.endpoint;
  const curlExample = endpoint
    ? `curl "${publicEnv.serverUrl}/a/${label}/quote?units=2"\n\ncurl -i -X POST "${endpoint}" \\\n  -H "X-Nightshift-Units: 2" \\\n  -F file=@your-audio.mp3`
    : "The worker has not published an x402 endpoint.";
  const tsExample = endpoint
    ? `import { wrapFetchWithPayment, x402Client } from "@x402/fetch";\nimport { ExactHederaScheme } from "@x402/hedera/exact/client";\n\nconst client = new x402Client()\n  .register("hedera:testnet", new ExactHederaScheme(signer));\nconst payFetch = wrapFetchWithPayment(fetch, client);\n\nconst form = new FormData();\nform.append("file", audioBlob, "audio.mp3");\nconst res = await payFetch("${endpoint}", {\n  method: "POST",\n  headers: { "X-Nightshift-Units": "2" },\n  body: form,\n});\nconst result = await res.json();`
    : "No published x402 endpoint is available for this worker.";

  if (profile.isPending) {
    return (
      <PageFrame
        kicker="Worker identity"
        title={<EnsName name={`${label}.${publicEnv.ensParentName}`} />}
        titleVariant="name"
      >
        <LoadingPanel label={`Loading ${label} from the Nightshift API…`} />
      </PageFrame>
    );
  }
  if (profile.isError) {
    return (
      <PageFrame
        kicker="Worker identity"
        title={<EnsName name={`${label}.${publicEnv.ensParentName}`} />}
        titleVariant="name"
      >
        <ErrorPanel message={profile.error.message} onRetry={() => void profile.refetch()} />
        <Link className="button section-block" href="/directory">
          ← Back to directory
        </Link>
      </PageFrame>
    );
  }
  const agent = profileData!;
  const ensKeys = [...OWNER_KEYS, REPUTATION_KEY];
  const ensErrorMessage =
    records.error instanceof Error
      ? records.error.message
      : "We show nothing rather than a cached copy.";
  const liveReputation = records.data?.verified ? records.data.texts[REPUTATION_KEY] : null;
  const reputation = liveReputation ? parseReputation(liveReputation) : null;

  return (
    <PageFrame
      kicker="ENSv2 · Sepolia"
      title={<EnsName name={agent.ensName} />}
      titleVariant="name"
      description="Worker identity, registry records, work log, and the live quote endpoint."
      actions={
        <Link className="button" href="/directory">
          ← Tonight’s roster
        </Link>
      }
    >
      <div className="profile-top">
        <section className="card id-card" aria-label="Worker identity">
          <div className="id-card__band mono">
            <span>NIGHTSHIFT · WORKER IDENTITY</span>
            <span>ENSv2 · SEPOLIA</span>
          </div>
          <div className="id-card__body">
            <div className="id-card__moon">
              <MoonAvatar size={132} label={agent.label} />
              <small className="mono">credit balance is private to the owner</small>
            </div>
            <div className="id-card__fields">
              <Field label="Name" value={<EnsName name={agent.ensName} />} />
              <Field label="Skill" value={agent.skill ?? "Not published"} />
              <Field label="Model" value={agent.model ?? "Not published"} />
              <Field
                label="Rate"
                value={
                  agent.price.amount === null
                    ? "Not published"
                    : `${formatUsdc(BigInt(agent.price.amount))} ${agent.price.asset === HEDERA_USDC_TOKEN_ID ? "USDC" : agent.price.asset} / ${agent.price.unit ?? "unit"}`
                }
                tone="orange"
              />
              <Field
                label="Pay to · directory API"
                value={agent.payTo ?? "Not published"}
                href={payToUrl ?? undefined}
              />
              <Field
                label="Owner · directory API"
                value={
                  directoryData?.owner ??
                  (directory.isPending ? "Loading directory record…" : "Not published")
                }
                href={addressUrl ?? undefined}
              />
              <Field
                label="Registration tx · API (unverified)"
                value={agent.registerTx ?? "Not recorded"}
                href={registerTxUrl ?? undefined}
              />
            </div>
            <div className="reputation-seal">
              <span className="mono">REPUTATION</span>
              <strong>{reputation ? formatPercent(reputation.success) : "—"}</strong>
              <span className="mono">
                {reputation ? `${reputation.jobs} JOBS · ENS` : "NOT VERIFIED"}
              </span>
            </div>
          </div>
          <div className="machine-line mono">
            NS&lt;&lt;{agent.skill?.toUpperCase() ?? "WORKER"}&lt;&lt;{agent.ensName.toUpperCase()}
          </div>
        </section>
        <aside className="profile-aside">
          <span
            className={`stamp ${agent.status === "active" ? "stamp--green" : "stamp--red"}`}
            title="Status from the public directory API"
          >
            {agent.status.replaceAll("_", " ").toUpperCase()}
          </span>
          <p>{directoryData?.description ?? "No description published in the directory."}</p>
          <div className="button-row">
            <a className="button button--ink" href="#hire">
              Hire this worker
            </a>
            <Link className="button" href="/console">
              Try in console
            </Link>
          </div>
          <div className="profile-totals">
            <Field
              label="Earned today · API ledger"
              value={`${formatUsdc(BigInt(agent.today.earnedAtomic))} USDC`}
              tone="orange"
            />
            <Field label="Settled jobs · API ledger" value={String(agent.today.jobsSettled)} />
          </div>
        </aside>
      </div>

      <div className="profile-sections">
        <section className="card hard-shadow profile-records">
          <header className="section-header">
            <div>
              <h2 className="section-title riso">Registry entry</h2>
              <p>Read directly by this browser from ENS on Sepolia.</p>
            </div>
            {records.isPending && <span className="mono">reading records…</span>}
            {records.data?.verified && (
              <span className="stamp stamp--blue">LIVE · SEPOLIA · VERIFIED</span>
            )}
            {records.data && !records.data.verified && (
              <span className="stamp stamp--red">RESOLVER MISMATCH</span>
            )}
          </header>
          {!publicEnv.sepoliaRpcUrl ? (
            <ErrorPanel message="Live ENS records cannot be verified: NEXT_PUBLIC_SEPOLIA_RPC_URL is not configured." />
          ) : records.isPending ? (
            <LoadingPanel label="Reading owner and registrar records from Sepolia…" />
          ) : records.isError ? (
            <ErrorPanel
              message={`ENS read failed. No server-cached records are substituted. ${ensErrorMessage}`}
              onRetry={() => void records.refetch()}
            />
          ) : records.data.verified ? (
            ensKeys.map((key) => (
              <div className="record-grid" key={key}>
                <span className="record-key">{key}</span>
                <span className="record-value">
                  {records.data.texts[key] ?? "—"}
                  {key === "nightshift.price" && records.data.texts[key] && (
                    <small className="record-hint">
                      {" "}
                      {formatPriceHint(records.data.texts[key]!)}
                    </small>
                  )}
                </span>
                <span
                  className={`stamp ${key === REPUTATION_KEY ? "stamp--orange" : "stamp--blue"}`}
                >
                  {key === REPUTATION_KEY ? "REGISTRAR" : "OWNER"}
                </span>
              </div>
            ))
          ) : (
            <ErrorPanel message="The live resolver did not match the registrar and directory record. On-chain text values are withheld." />
          )}
        </section>
        <aside>
          <h2 className="section-title riso">Who holds the pen</h2>
          <p className="mono-wrap small-note">
            Live resolver {records.data?.verified ? records.data.resolver : "not verified"}
          </p>
          <div className="permission-stack">
            <div className="card permission-card">
              <strong>The owner · can edit</strong>
              <p>Service description, endpoints, price, payTo, model, and context.</p>
            </div>
            <div className="card permission-card permission-card--warm">
              <strong>The registrar · reputation</strong>
              <p>
                Only the registrar may write <code>nightshift.reputation</code>.
              </p>
            </div>
            <div className="card permission-card">
              <strong>Nobody · relinking</strong>
              <p>Only a successful live chain read can verify the registered resolver.</p>
            </div>
          </div>
        </aside>
      </div>

      <section className="card hard-shadow profile-worklog section-block">
        <header className="section-header">
          <h2 className="section-title riso">Work log</h2>
          <span className="mono">public Supabase jobs · live updates</span>
        </header>
        {jobs.isPending ? (
          <LoadingPanel label="Loading recent public jobs…" />
        ) : jobs.isError ? (
          <ErrorPanel message={jobs.error.message} onRetry={() => void jobs.refetch()} />
        ) : jobs.data.length === 0 ? (
          <EmptyPanel
            title="No jobs recorded."
            detail="There are no public jobs for this agent yet."
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time UTC</th>
                  <th>Status</th>
                  <th>Paid</th>
                  <th>Latency</th>
                  <th>Hedera tx</th>
                  <th>0G request</th>
                  <th>HCS</th>
                </tr>
              </thead>
              <tbody>
                {jobs.data.map((job) => {
                  const txUrl = job.hedera_tx_id ? hashscanTransactionUrl(job.hedera_tx_id) : null;
                  const topicUrl = process.env.NEXT_PUBLIC_HEDERA_HCS_TOPIC_ID
                    ? hashscanTopicUrl(process.env.NEXT_PUBLIC_HEDERA_HCS_TOPIC_ID)
                    : null;
                  return (
                    <tr key={job.id}>
                      <td>
                        {new Date(job.created_at).toISOString().replace("T", " ").slice(0, 19)}
                      </td>
                      <td>{job.status}</td>
                      <td>
                        {job.status === "settled" ? formatUsdc(BigInt(job.price_atomic)) : "—"}
                      </td>
                      <td>{job.latency_ms === null ? "—" : `${job.latency_ms} ms`}</td>
                      <td>
                        {txUrl ? (
                          <ExternalLink href={txUrl}>
                            {truncateMiddle(job.hedera_tx_id!)} ↗
                          </ExternalLink>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {job.zg_request_id ? (
                          <CopyButton
                            value={job.zg_request_id}
                            label={truncateMiddle(job.zg_request_id)}
                          />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {topicUrl && job.hcs_sequence ? (
                          <ExternalLink href={`${topicUrl}#${job.hcs_sequence}`}>
                            #{job.hcs_sequence} ↗
                          </ExternalLink>
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

      <section id="hire" className="hire-section">
        <div>
          <div className="kick">For agent developers</div>
          <h2 className="section-title riso">Hire it in one call.</h2>
          <p>No signup. Request a quote first; a real x402 client handles payment on Hedera.</p>
        </div>
        <div className="card hard-shadow code-card">
          <div className="code-tabs">
            <button
              type="button"
              aria-pressed={codeTab === "curl"}
              onClick={() => setCodeTab("curl")}
            >
              curl
            </button>
            <button type="button" aria-pressed={codeTab === "ts"} onClick={() => setCodeTab("ts")}>
              TypeScript
            </button>
            <CopyButton value={codeTab === "curl" ? curlExample : tsExample} />
          </div>
          <pre className="mono code-block">{codeTab === "curl" ? curlExample : tsExample}</pre>
          {quote.isPending ? (
            <p className="mono">Getting a live quote…</p>
          ) : quote.isError ? (
            <ErrorPanel message={quote.error.message} onRetry={() => void quote.refetch()} />
          ) : (
            <p className="mono quote-line">
              Live quote · {quoteData?.units} {quoteData?.unit}:{" "}
              {formatUsdc(BigInt(quoteData?.amount ?? "0"))} USDC · {quoteData?.network}
            </p>
          )}
        </div>
      </section>
    </PageFrame>
  );
}

function Field({
  label,
  value,
  href,
  tone,
}: {
  label: string;
  value: ReactNode;
  href?: string;
  tone?: "orange";
}) {
  return (
    <div className="profile-field">
      <span className="mono">{label}</span>
      {href ? (
        <ExternalLink href={href}>{value}</ExternalLink>
      ) : (
        <strong className={tone ? "text-orange" : ""}>{value}</strong>
      )}
    </div>
  );
}

function parseReputation(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("success" in parsed) ||
      !("jobs" in parsed)
    )
      return null;
    const { success, jobs } = parsed as { success: unknown; jobs: unknown };
    if (typeof success !== "number" || typeof jobs !== "number") return null;
    return { success, jobs };
  } catch {
    return null;
  }
}

function formatPriceHint(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "amount" in parsed &&
      typeof parsed.amount === "string"
    ) {
      return `= ${formatUsdc(BigInt(parsed.amount))} USDC per ${"unit" in parsed && typeof parsed.unit === "string" ? parsed.unit : "unit"}`;
    }
  } catch {
    return "";
  }
  return "";
}
