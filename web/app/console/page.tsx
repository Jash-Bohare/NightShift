"use client";

import Link from "next/link";
import { useEffect, useReducer, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePrivy } from "@privy-io/react-auth";
import { SKILL_IDS } from "@nightshift/shared/constants";
import { formatUsdc } from "@nightshift/shared/money";
import type { BuyerEvent } from "@nightshift/shared/buyerEvents";
import { Button } from "../../components/ui/Button";
import { MoonAvatar } from "../../components/ui/MoonAvatar";
import { ErrorPanel, EmptyPanel, LoadingPanel, PageFrame } from "../../components/Product";
import { serverGet, type BuyerBudget } from "../../lib/api";
import {
  reduceConsole,
  initialConsoleState,
  parseBuyerEvent,
  parseSseFrame,
} from "../../lib/console";
import { formatElapsed } from "../../lib/time";
import { publicEnv } from "../../lib/public-env";
import { hashscanTransactionUrl } from "../../lib/explorers";
import { useClock } from "../../lib/use-clock";

const skillNames: Record<(typeof SKILL_IDS)[number], string> = {
  "transcribe:ta": "Transcribe · Tamil",
  "transcribe:hi": "Transcribe · Hindi",
  "transcribe:en": "Transcribe · English",
};

export default function ConsolePage() {
  // Hosted demo: Privy sign-in only works on localhost, so paid runs stay local-only.
  if (!publicEnv.privyAppId || publicEnv.demoMode) return <ConsolePageContent auth={null} />;
  return <PrivyConsolePage />;
}

function PrivyConsolePage() {
  const { authenticated, getAccessToken, login } = usePrivy();
  return (
    <ConsolePageContent
      auth={{
        authenticated,
        getAccessToken,
        login: () => void login(),
      }}
    />
  );
}

interface ConsoleAuth {
  authenticated: boolean;
  getAccessToken: () => Promise<string | null>;
  login: () => void;
}

function ConsolePageContent({ auth }: { auth: ConsoleAuth | null }) {
  const [skill, setSkill] = useState<(typeof SKILL_IDS)[number]>("transcribe:ta");
  const [state, dispatch] = useReducer(reduceConsole, initialConsoleState);
  const [showFull, setShowFull] = useState(false);
  // Paid runs require an explicit, per-page-load acknowledgement; opening the page never pays.
  const [acknowledged, setAcknowledged] = useState(false);
  const [watchingDurableEvents, setWatchingDurableEvents] = useState(false);
  const startAt = useRef<number>(0);
  const now = useClock() ?? Date.now();
  const budget = useQuery({
    queryKey: ["buyer-budget", Boolean(auth?.authenticated)],
    enabled: Boolean(auth?.authenticated),
    queryFn: async ({ signal }) => {
      const accessToken = await auth?.getAccessToken();
      if (!accessToken)
        throw new Error("Sign in with an authorized Privy account to view the buyer budget.");
      return serverGet<BuyerBudget>("/buyer-console/budget", signal, accessToken);
    },
    refetchInterval: 30_000,
  });
  const persistedEvents = useQuery({
    queryKey: ["buyer-run-events", state.runId],
    enabled: watchingDurableEvents && Boolean(state.runId) && Boolean(auth?.authenticated),
    refetchInterval: watchingDurableEvents ? 2_500 : false,
    queryFn: async ({ signal }) => {
      if (!state.runId) throw new Error("The run identifier is unavailable.");
      const accessToken = await auth?.getAccessToken();
      if (!accessToken)
        throw new Error("Sign in with an authorized Privy account to resume this run.");
      const response = await serverGet<{
        events: { event_type: string; payload: Record<string, unknown>; created_at: string }[];
      }>(`/buyer-console/events/${encodeURIComponent(state.runId)}`, signal, accessToken);
      return response.events;
    },
  });
  const elapsed =
    state.phase === "running" || state.phase === "resuming"
      ? formatElapsed(now - startAt.current)
      : null;

  useEffect(() => {
    if (!watchingDurableEvents || !persistedEvents.data || !state.runId) return;
    for (const row of persistedEvents.data) {
      if (!isPersistedEvent(row, state.runId)) continue;
      try {
        const event = parseBuyerEvent(row.event_type, JSON.stringify(row.payload));
        if (event) dispatch({ type: "event", event });
      } catch (error) {
        dispatch({
          type: "connection-error",
          message:
            error instanceof Error ? error.message : "The persisted buyer event was malformed.",
        });
        setWatchingDurableEvents(false);
        return;
      }
    }
  }, [persistedEvents.data, state.runId, watchingDurableEvents]);

  useEffect(() => {
    if (!watchingDurableEvents || !persistedEvents.isError) return;
    dispatch({
      type: "connection-error",
      message: `Could not resume persisted events: ${persistedEvents.error.message}`,
    });
    setWatchingDurableEvents(false);
  }, [persistedEvents.error, persistedEvents.isError, watchingDurableEvents]);

  async function run(): Promise<void> {
    if (!auth?.authenticated) {
      auth?.login();
      return;
    }
    if (state.phase === "running" || state.phase === "resuming" || !budget.data || !acknowledged)
      return;
    if (
      !window.confirm("This starts a real buyer run and spends test USDC and 0G credits. Continue?")
    )
      return;
    dispatch({ type: "reset" });
    setWatchingDurableEvents(false);
    dispatch({ type: "start", runId: "" });
    startAt.current = Date.now();
    const requestController = new AbortController();
    const timeout = setTimeout(() => requestController.abort(), 120_000);
    let knownRejected = false;
    try {
      const accessToken = await auth.getAccessToken();
      if (!accessToken) {
        knownRejected = true;
        throw new Error("Privy did not provide an access token; no buyer request was sent.");
      }
      const response = await fetch(
        `${publicEnv.serverUrl}/buyer-console/run?skill=${encodeURIComponent(skill)}`,
        {
          method: "POST",
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${accessToken}`,
          },
          signal: requestController.signal,
          cache: "no-store",
        },
      );
      if (!response.ok) {
        knownRejected = true;
        let detail = `Buyer run could not start (${response.status}).`;
        try {
          const body: unknown = await response.json();
          if (
            typeof body === "object" &&
            body !== null &&
            "message" in body &&
            typeof body.message === "string"
          ) {
            detail = body.message;
          }
        } catch {
          // Keep the HTTP status when the server does not return JSON.
        }
        throw new Error(detail);
      }
      if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
        throw new Error("The server did not open an SSE stream.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let complete = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;
          if (parsed.comment && /^run-\d+$/.test(parsed.comment)) {
            dispatch({ type: "set-run-id", runId: parsed.comment });
          }
          if (parsed.event === "complete") {
            const result: unknown = JSON.parse(parsed.data);
            if (!isCompleteEvent(result))
              throw new Error("Malformed complete event from buyer stream.");
            dispatch({
              type: "complete",
              success: result.success,
              message: result.error ?? undefined,
            });
            complete = true;
            continue;
          }
          const event = parseBuyerEvent(parsed.event, parsed.data);
          if (event) dispatch({ type: "event", event });
        }
        if (complete) {
          await reader.cancel();
          break;
        }
      }
      if (!complete) {
        dispatch({
          type: "connection-error",
          message:
            "The SSE stream closed before completion. The server may still be processing this paid run; it cannot safely be restarted.",
        });
      }
    } catch (error) {
      dispatch({
        ...(knownRejected
          ? {
              type: "complete" as const,
              success: false,
              message: error instanceof Error ? error.message : "The server rejected the run.",
            }
          : {
              type: "connection-error" as const,
              message:
                error instanceof Error
                  ? error.message
                  : "The buyer stream connection failed. The server may still be processing the run.",
            }),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  function resumePersistedEvents(): void {
    if (!state.runId) return;
    dispatch({ type: "resume" });
    setWatchingDurableEvents(true);
  }

  function stopWatchingEvents(): void {
    setWatchingDurableEvents(false);
    dispatch({
      type: "connection-error",
      message: "Stopped watching this run’s persisted events.",
    });
  }

  const workers = Object.entries(state.wire);

  return (
    <PageFrame
      kicker="Buyer console"
      title="Watch an agent"
      accent="hire a worker."
      description="The buyer finds a worker, checks its ENS identity, asks for a quote, pays, and receives the work. Run starts a real paid testnet operation."
    >
      <div className="card hard-shadow console-controls">
        <label className="control-label">
          Skill
          <select
            className="form-control"
            value={skill}
            onChange={(event) => setSkill(event.target.value as (typeof SKILL_IDS)[number])}
            disabled={state.phase === "running"}
          >
            {SKILL_IDS.map((id) => (
              <option key={id} value={id}>
                {skillNames[id]} ({id})
              </option>
            ))}
          </select>
        </label>
        <span className="chip console-sample">Server configured sample audio</span>
        <Button
          variant="ink"
          disabled={
            !publicEnv.privyAppId ||
            (Boolean(auth?.authenticated) && (!budget.data || !acknowledged)) ||
            state.phase === "running" ||
            state.phase === "resuming"
          }
          onClick={() => void run()}
        >
          {state.phase === "running"
            ? `Running${elapsed ? ` · ${elapsed}` : ""}`
            : state.phase === "resuming"
              ? "Watching event log…"
              : state.phase === "complete"
                ? "Run again"
                : state.phase === "disconnected"
                  ? "Start new paid run"
                  : auth?.authenticated
                    ? "▶ Run buyer agent"
                    : "Sign in to run buyer"}
        </Button>
        {publicEnv.demoMode ? (
          <p role="status" className="mono control-disclaimer">
            Hosted demo: paid buyer runs spend real test USDC, so they run only from the local
            console. The demo video shows a full run; worker pages show its on-chain proofs.
          </p>
        ) : !publicEnv.privyAppId ? (
          <p role="status" className="mono control-disclaimer">
            Paid buyer console unavailable: Privy app configuration is missing.
          </p>
        ) : !auth?.authenticated ? (
          <p role="status" className="mono control-disclaimer">
            Sign in with an authorized account before starting or resuming a buyer run.
          </p>
        ) : null}
        <label className="mono control-disclaimer">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            disabled={!auth?.authenticated || state.phase === "running"}
          />{" "}
          I understand Run spends real test USDC and 0G credits and an uncertain payment is never
          retried automatically.
        </label>
        <p className="mono control-disclaimer">
          One run at a time, 20 seconds apart. Disabled unless the server enables the paid console.
        </p>
      </div>

      {!auth?.authenticated ? (
        <EmptyPanel
          title="Buyer budget is private."
          detail="Sign in with an allow-listed Privy account to view spending rules and run events."
        />
      ) : budget.isPending ? (
        <LoadingPanel label="Reading buyer spending rules…" />
      ) : budget.isError ? (
        <ErrorPanel message={budget.error.message} onRetry={() => void budget.refetch()} />
      ) : (
        <section className="wire-section card hard-shadow" aria-label="The wire">
          <header className="section-header">
            <div className="kick">The wire · who the buyer talks to</div>
            <span className="mono">
              {watchingDurableEvents
                ? "● durable event log · final status not recorded"
                : state.phase === "running"
                  ? "● streaming"
                  : (state.runId ?? "waiting")}
            </span>
          </header>
          <div className="wire-layout">
            <div className="buyer-card card">
              <strong>Buyer agent</strong>
              <span className="mono">Public buyer run</span>
              <div className="muted small-note">
                Hedera mirror-node wallet balance is not exposed by the available frontend API.
              </div>
              <div className="mono budget-line">
                spent today{" "}
                <b>
                  {formatUsdc(BigInt(budget.data.state.dailySpentAtomic))} /{" "}
                  {formatUsdc(BigInt(budget.data.rules.dailyBudgetAtomic))} USDC
                </b>
              </div>
              <div className="budget-bar">
                <span style={{ width: `${budgetPercent(budget.data)}%` }} />
              </div>
            </div>
            <div className="wire-connector" aria-hidden="true">
              ·························
            </div>
            <div className="wire-list">
              {workers.length === 0 ? (
                <EmptyPanel
                  title="No workers in this run yet."
                  detail="Worker cards appear only from actual buyer events."
                />
              ) : (
                workers.map(([name, status]) => (
                  <Link
                    className="wire-worker"
                    href={`/agents/${encodeURIComponent(name)}`}
                    key={name}
                  >
                    <MoonAvatar size={34} label={`${name}, ${status}`} />
                    <span className="wire-worker__name">
                      <strong>{name}</strong>
                      <small className="mono">{statusLabel(status)}</small>
                    </span>
                  </Link>
                ))
              )}
            </div>
          </div>
        </section>
      )}

      <div className="console-columns">
        <section className="card console-tape" aria-label="Run tape">
          <header className="section-header">
            <strong className="mono">THE TAPE · LIVE FROM SSE</strong>
            <span className="mono">POST /buyer-console/run</span>
          </header>
          {state.events.length === 0 && state.phase === "idle" && (
            <EmptyPanel
              title="Quiet night so far."
              detail="Press Run to start a paid buyer operation. Each server event will print here."
            />
          )}
          {state.events.map((event, index) => (
            <EventRow
              event={event}
              key={`${event.timestamp}-${index}`}
              showFull={showFull}
              onToggleFull={() => setShowFull((value) => !value)}
            />
          ))}
          {(state.phase === "running" || state.phase === "resuming") && (
            <div className="event-row">
              <span className="mono">now</span>
              <strong className="text-orange">
                {state.phase === "resuming" ? "RECONNECTED" : "RUNNING"}
              </strong>
              <span>
                {state.phase === "resuming"
                  ? "Watching durable run events. The server does not persist a terminal complete event."
                  : "Waiting for the next event…"}
              </span>
            </div>
          )}
          {state.phase === "complete" && (
            <div className="complete-banner">
              <span className="stamp stamp--green stamp--tilt-left">SHIFT COMPLETE</span>
              <span className="mono">{state.events.length} real events received.</span>
            </div>
          )}
          {state.phase === "error" && state.error && <ErrorPanel message={state.error} />}
          {state.phase === "disconnected" && state.error && (
            <div className="reconnect-warning" role="alert">
              <strong>Connection lost; no automatic retry.</strong>
              <p>{state.error}</p>
              <p>
                The server exposes an allow-listed durable event log; repeating the paid GET cannot
                safely resume a run.
              </p>
              {state.runId && (
                <Button onClick={resumePersistedEvents}>Resume persisted events</Button>
              )}
              {watchingDurableEvents && <Button onClick={stopWatchingEvents}>Stop watching</Button>}
              <Button
                onClick={() => {
                  if (watchingDurableEvents) stopWatchingEvents();
                  else dispatch({ type: "reset" });
                }}
              >
                Dismiss run status
              </Button>
            </div>
          )}
          {state.phase === "resuming" && (
            <div className="complete-banner">
              <span className="stamp stamp--blue">RECONNECTED TO EVENT LOG</span>
              <Button onClick={stopWatchingEvents}>Stop watching</Button>
            </div>
          )}
        </section>
        <aside className="note-card">
          <h2>House rules</h2>
          {!auth?.authenticated ? (
            <EmptyPanel
              title="Buyer budget is private."
              detail="Sign in with an allow-listed Privy account to view spending rules and run events."
            />
          ) : budget.isPending ? (
            <LoadingPanel label="Loading rules…" />
          ) : budget.isError ? (
            <ErrorPanel message={budget.error.message} />
          ) : (
            <ul className="mono">
              <li>max {formatUsdc(BigInt(budget.data.rules.maxPerJobAtomic))} USDC per job</li>
              <li>daily {formatUsdc(BigInt(budget.data.rules.dailyBudgetAtomic))} USDC</li>
              <li>
                human approval above{" "}
                {formatUsdc(BigInt(budget.data.rules.humanApprovalAboveAtomic))}
              </li>
              <li>success rate at least {Math.round(budget.data.rules.minSuccess * 100)}%</li>
              <li>names under {budget.data.rules.allowParentNames.join(", ")}</li>
              <li>assets {budget.data.rules.allowedAssets.join(", ")}</li>
              <li>networks {budget.data.rules.allowedNetworks.join(", ")}</li>
            </ul>
          )}
        </aside>
      </div>
    </PageFrame>
  );
}

function isPersistedEvent(
  value: unknown,
  runId: string,
): value is { event_type: string; payload: Record<string, unknown> } {
  if (typeof value !== "object" || value === null || !("payload" in value)) return false;
  const row = value as { event_type?: unknown; payload?: unknown };
  return (
    typeof row.event_type === "string" &&
    typeof row.payload === "object" &&
    row.payload !== null &&
    "runId" in row.payload &&
    row.payload.runId === runId
  );
}

function isCompleteEvent(value: unknown): value is { success: boolean; error?: string | null } {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    typeof value.success === "boolean"
  );
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

function budgetPercent(budget: BuyerBudget) {
  const daily = BigInt(budget.rules.dailyBudgetAtomic);
  if (daily <= 0n) return 0;
  const used = BigInt(budget.state.dailySpentAtomic);
  return Math.min(100, Number((used * 100n) / daily));
}

function EventRow({
  event,
  showFull,
  onToggleFull,
}: {
  event: BuyerEvent;
  showFull: boolean;
  onToggleFull: () => void;
}) {
  const time = new Date(event.timestamp).toISOString().slice(11, 19);
  let summary = "";
  let detail = "";
  let tone = "";
  let extra: React.ReactNode = null;
  switch (event.kind) {
    case "plan":
      summary = `Plan · ${event.task.skill}`;
      detail = `${event.task.units} billed units${event.task.file ? ` · ${event.task.file}` : ""}`;
      break;
    case "discover":
      summary = `Discovered ${event.candidates.length} workers`;
      detail = event.candidates
        .map((candidate) => `${candidate.ensName} · ${formatUsdc(BigInt(candidate.priceAtomic))}`)
        .join(" · ");
      break;
    case "verify":
      summary = `${event.ensName} ${event.ok ? "verified" : "not verified"}`;
      detail = event.ok
        ? `resolver ${event.resolver ?? "not reported"} · payTo ${event.payTo ?? "not reported"}`
        : (event.reason ?? "ENS verification failed");
      tone = event.ok ? "blue" : "red";
      break;
    case "decide":
      summary = `Selected ${event.chosen.ensName}`;
      detail = event.rationale;
      tone = "blue";
      break;
    case "quote":
      summary = `${event.label} quote`;
      detail = `${formatUsdc(BigInt(event.amount))} ${event.asset} · ${event.units} units`;
      break;
    case "refused":
      summary = `${event.label} refused · ${event.status}`;
      detail = `${event.reason} · nothing charged`;
      tone = "red";
      break;
    case "payment_failed":
      summary = `${event.label} payment failed`;
      detail = event.error;
      tone = "red";
      break;
    case "paid": {
      const txUrl = hashscanTransactionUrl(event.txId);
      summary = `Paid ${event.label}`;
      detail = `${formatUsdc(BigInt(event.amount))} USDC · ${event.txId}`;
      tone = "orange";
      extra = txUrl ? (
        <a
          className="button button--orange button--small"
          href={txUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          View on HashScan ↗
        </a>
      ) : (
        <span className="muted">Invalid Hedera transaction id</span>
      );
      break;
    }
    case "result":
      summary = `Result · ${event.label}`;
      detail = `${event.latencyMs === undefined ? "latency not reported" : `${event.latencyMs} ms`} · ${event.zgRequestId ? `0G ${event.zgRequestId}` : "no 0G request id"}`;
      extra = (
        <div className="transcript">
          <div className="mono transcript-head">TRANSCRIPT · {event.text.length} CHARS</div>
          <p className="ta" lang="ta">
            {showFull || event.text.length < 240 ? event.text : `${event.text.slice(0, 240)}…`}
          </p>
          {event.text.length >= 240 && (
            <button className="button button--small" type="button" onClick={onToggleFull}>
              {showFull ? "Show less" : "Show full transcript"}
            </button>
          )}
        </div>
      );
      break;
    case "error":
      summary = `Error${event.step ? ` · ${event.step}` : ""}`;
      detail = event.message;
      tone = "red";
      break;
  }
  return (
    <article className={`event-row${tone ? ` event-row--${tone}` : ""}`}>
      <time className="mono">{time}</time>
      <strong className="mono">{event.kind.toUpperCase()}</strong>
      <span>
        <b>{summary}</b>
        <span className="event-detail"> {detail}</span>
        {extra && <span className="event-extra">{extra}</span>}
      </span>
    </article>
  );
}
