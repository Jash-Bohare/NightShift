"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { SKILL_IDS } from "@nightshift/shared/constants";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../components/ui/Button";
import { MoonAvatar } from "../../components/ui/MoonAvatar";
import { ErrorPanel, ExternalLink, LoadingPanel, PageFrame } from "../../components/Product";
import { ApiError, errorMessage, serverGet, serverSend } from "../../lib/api";
import { checkRegistrarAvailable } from "../../lib/chain";
import { ensAppUrl, etherscanTransactionUrl, hashscanAccountUrl } from "../../lib/explorers";
import {
  STEP_LABELS,
  atomicFromDecimal,
  capFromCredits,
  decimalFromAtomic,
  readLaunchStream,
  stepStates,
  type LaunchLine,
  type LaunchResult,
} from "../../lib/launch";
import { publicEnv } from "../../lib/public-env";
import { formatCountdownToUtcMidnight } from "../../lib/time";
import { useClock } from "../../lib/use-clock";

type SkillId = (typeof SKILL_IDS)[number];

const skillLabels: Record<SkillId, string> = {
  "transcribe:ta": "Tamil transcription",
  "transcribe:hi": "Hindi transcription",
  "transcribe:en": "English transcription",
};

interface SkillPricing {
  id: string;
  model: string;
  unit: string;
  costUsdMicroPerUnit: string;
  suggestedPriceAtomic: string;
}

const heading = {
  kicker: "Form NS-1 · application for a night shift",
  title: "Put tonight’s credits",
  accent: "to work.",
};

export default function LaunchPage() {
  if (publicEnv.demoMode)
    return (
      <PageFrame {...heading} description="Launching workers needs a local Nightshift server.">
        <ErrorPanel message="This is the hosted demo. Sign-in and launch run on localhost:3000 only (0G’s Privy app allows only local origins). Browse the directory or run the buyer console instead." />
        <Link className="button button--ink" href="/directory">
          Browse workers →
        </Link>
      </PageFrame>
    );
  if (!publicEnv.privyAppId)
    return (
      <PageFrame {...heading} description="A four-step launch wizard.">
        <ErrorPanel message="Privy is not configured (NEXT_PUBLIC_PRIVY_APP_ID). Sign-in and launch are unavailable." />
      </PageFrame>
    );
  return <PrivyLaunch />;
}

function PrivyLaunch() {
  const { ready, authenticated, login } = usePrivy();
  if (!ready)
    return (
      <main className="wrap product-page">
        <LoadingPanel label="Checking Privy session…" />
      </main>
    );
  return (
    <PageFrame
      {...heading}
      description="Four steps. Your worker gets an ENS name, a Hedera wallet and a daily 0G budget you control."
    >
      {!authenticated ? (
        <div className="alert-note launch-auth">
          <strong>Sign in with Privy to begin.</strong>
          <p>The wallet you sign in with will own the worker’s ENS name.</p>
          <Button variant="ink" onClick={() => login()}>
            Sign in with Privy
          </Button>
        </div>
      ) : (
        <LaunchWizard />
      )}
    </PageFrame>
  );
}

function LaunchWizard() {
  const { getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const now = useClock();

  const [step, setStep] = useState(1);
  const [walletAddress, setWalletAddress] = useState("");
  const [mgmtKey, setMgmtKey] = useState("");
  const [skill, setSkill] = useState<SkillId>("transcribe:ta");
  const [label, setLabel] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [cap, setCap] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [payoutAccount, setPayoutAccount] = useState("");
  const [lines, setLines] = useState<LaunchLine[]>([]);
  const [phase, setPhase] = useState<"form" | "launching" | "done" | "failed">("form");
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);

  // Prefer the Privy embedded wallet (it signs record edits later); otherwise the first wallet.
  const ownerWallet = useMemo(() => {
    if (walletAddress) return walletAddress;
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    return (embedded ?? wallets[0])?.address ?? "";
  }, [walletAddress, wallets]);

  const credits = useMutationState<{
    creditBalanceUsdMicro: string;
    totalBalanceUsdMicro: string;
  }>();
  const pricing = useQuery({
    queryKey: ["skills-pricing"],
    queryFn: ({ signal }) => serverGet<{ skills: SkillPricing[] }>("/skills", signal),
    staleTime: 300_000,
    retry: 1,
  });
  const skillPricing = pricing.data?.skills.find((s) => s.id === skill);

  const validLabel = /^[a-z0-9-]{3,32}$/.test(label);
  const availability = useQuery({
    queryKey: ["label-availability", label],
    enabled: validLabel && Boolean(publicEnv.sepoliaRpcUrl),
    queryFn: () => checkRegistrarAvailable(label),
    retry: 1,
  });
  const priceAtomic = atomicFromDecimal(price);
  const validPrice = priceAtomic !== null && priceAtomic > 0n && priceAtomic <= 10_000_000n;
  const capMicro = atomicFromDecimal(cap);
  const validCap = capMicro !== null && capMicro > 0n && capMicro <= 1_000_000_000n;
  const validApiKey = /^sk-[A-Za-z0-9_-]{8,200}$/.test(apiKey.trim());
  const validMgmtKey = mgmtKey.trim() === "" || /^mk-[A-Za-z0-9_-]{8,200}$/.test(mgmtKey.trim());
  const validPayout = payoutAccount.trim() === "" || /^0\.0\.\d{1,12}$/.test(payoutAccount.trim());
  const creditMicro = credits.data ? BigInt(credits.data.creditBalanceUsdMicro) : null;

  const stepValid = [
    Boolean(ownerWallet) && validMgmtKey,
    true,
    validLabel && availability.data === true && validPrice && description.trim().length > 0,
    validCap && validApiKey && validPayout,
  ];
  const allValid = stepValid.every(Boolean);

  async function readCredits() {
    await credits.run(async () => {
      const token = await getAccessToken();
      if (!token) throw new Error("Privy did not provide an access token. Sign in again.");
      const balance = await serverSend<{
        creditBalanceUsdMicro: string;
        totalBalanceUsdMicro: string;
      }>("/me/zg-balance", {
        method: "POST",
        body: { zgMgmtKey: mgmtKey.trim() },
        bearerToken: token,
      });
      if (!cap) setCap(decimalFromAtomic(capFromCredits(BigInt(balance.creditBalanceUsdMicro))));
      return balance;
    });
  }

  async function submit() {
    if (!allValid || phase === "launching" || priceAtomic === null || capMicro === null) return;
    setPhase("launching");
    setLines([]);
    setLaunchError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Privy did not provide an access token. Sign in again.");
      const response = await fetch(`${publicEnv.serverUrl}/me/agents`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/x-ndjson",
        },
        body: JSON.stringify({
          label,
          skill,
          priceAtomic: priceAtomic.toString(),
          dailyCapUsdMicro: capMicro.toString(),
          zgApiKey: apiKey.trim(),
          ...(mgmtKey.trim() ? { zgMgmtKey: mgmtKey.trim() } : {}),
          ...(payoutAccount.trim() ? { hederaPayoutAccount: payoutAccount.trim() } : {}),
          description: description.trim(),
          ownerAddress: ownerWallet,
        }),
        cache: "no-store",
      });
      if (!response.ok) throw new ApiError(await errorMessage(response), response.status);
      if (!response.body) throw new Error("The server returned no launch progress.");
      let final: LaunchLine | null = null;
      await readLaunchStream(response.body, (line) => {
        setLines((prev) => [...prev, line]);
        if (line.type !== "progress") final = line;
      });
      const end = final as LaunchLine | null;
      if (end?.type === "done") {
        setResult(end.result);
        setPhase("done");
        // Keys have been handed to the server; drop them from browser memory.
        setApiKey("");
        setMgmtKey("");
      } else if (end?.type === "error") {
        setLaunchError(end.message);
        setPhase("failed");
      } else {
        setLaunchError(
          "The connection closed before the launch finished. Check the dashboard before retrying: the launch may still have completed.",
        );
        setPhase("failed");
      }
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : "Launch failed.");
      setPhase("failed");
    }
  }

  if (phase !== "form")
    return (
      <LaunchProgress
        lines={lines}
        phase={phase}
        error={launchError}
        result={result}
        onBack={() => setPhase("form")}
      />
    );

  return (
    <div className="launch-grid section-block">
      <section>
        <div className="step-tabs" role="tablist" aria-label="Launch application steps">
          {["Connect", "Skill", "Name & price", "Budget & keys"].map((name, index) => (
            <button
              aria-current={step === index + 1 ? "step" : undefined}
              className="step-tab"
              key={name}
              onClick={() => setStep(index + 1)}
              role="tab"
              type="button"
            >
              {String(index + 1).padStart(2, "0")} {name}
            </button>
          ))}
        </div>
        <div className="card hard-shadow wizard-card">
          {step === 1 && (
            <section aria-labelledby="launch-connect-title">
              <h2 id="launch-connect-title" className="section-title">
                1 · Who’s applying
              </h2>
              <p>Your worker spends your 0G credits; the wallet below will own its ENS name.</p>
              {!walletsReady ? (
                <LoadingPanel label="Loading your wallets…" />
              ) : wallets.length === 0 ? (
                <ErrorPanel message="No Ethereum wallet is linked to this Privy account. Sign out and sign in again so Privy can create one." />
              ) : (
                <label className="control-label">
                  Owner wallet (Sepolia)
                  <select
                    className="form-control form-control--mono"
                    value={ownerWallet}
                    onChange={(event) => setWalletAddress(event.target.value)}
                  >
                    {wallets.map((w) => (
                      <option key={w.address} value={w.address}>
                        {w.address} ·{" "}
                        {w.walletClientType === "privy" ? "Privy embedded" : w.walletClientType}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="control-label">
                0G management key (optional, read-only)
                <input
                  autoComplete="off"
                  className="form-control form-control--mono"
                  placeholder="mk-…"
                  spellCheck={false}
                  type="password"
                  value={mgmtKey}
                  onChange={(event) => setMgmtKey(event.target.value)}
                />
                <span className="muted">
                  Create one at <ExternalLink href="https://pc.0g.ai">pc.0g.ai</ExternalLink> → API
                  Keys with scope <code>account:read</code>. Used to show your allowance and let the
                  worker check its credits before each job.
                </span>
                {!validMgmtKey && (
                  <span className="field-error">Management keys start with mk-.</span>
                )}
              </label>
              <div className="wizard-nav">
                <Button
                  disabled={!mgmtKey.trim() || !validMgmtKey || credits.pending}
                  onClick={() => void readCredits()}
                >
                  {credits.pending ? "Reading 0G balance…" : "Read my 0G credits"}
                </Button>
              </div>
              {credits.error && (
                <p className="field-error" role="alert">
                  {credits.error}
                </p>
              )}
              {credits.data && (
                <div className="alert-note mono-wrap">
                  <strong>
                    Your daily allowance: $
                    {decimalFromAtomic(BigInt(credits.data.creditBalanceUsdMicro))} in 0G credits
                  </strong>
                  <p>
                    Unused credits expire at 00:00 UTC
                    {now !== null ? ` — in ${formatCountdownToUtcMidnight(now)}` : ""}. Total
                    balance ${decimalFromAtomic(BigInt(credits.data.totalBalanceUsdMicro))}.
                  </p>
                </div>
              )}
            </section>
          )}
          {step === 2 && (
            <section aria-labelledby="launch-skill-title">
              <h2 id="launch-skill-title" className="section-title">
                2 · What will it sell?
              </h2>
              <p>Choose a skill. Prices below are 0G’s live cost for one billed unit.</p>
              {pricing.isError && (
                <p className="field-error">
                  Live 0G pricing is unavailable: {pricing.error.message}
                </p>
              )}
              <div className="skill-options">
                {SKILL_IDS.map((skillId) => {
                  const p = pricing.data?.skills.find((s) => s.id === skillId);
                  return (
                    <button
                      aria-pressed={skill === skillId}
                      className={`skill-option${skill === skillId ? " is-selected" : ""}`}
                      key={skillId}
                      onClick={() => setSkill(skillId)}
                      type="button"
                    >
                      <strong>{skillLabels[skillId]}</strong>
                      <span className="mono">
                        {skillId} · {p?.model ?? "whisper"}
                        {p
                          ? ` · 0G cost $${decimalFromAtomic(BigInt(p.costUsdMicroPerUnit))}/${p.unit}`
                          : ""}
                      </span>
                    </button>
                  );
                })}
                <div className="skill-option skill-option--disabled" aria-disabled="true">
                  <strong>
                    Translate EN↔TA · Read documents <span className="stamp">SOON</span>
                  </strong>
                  <span className="mono">Not offered by this server yet.</span>
                </div>
              </div>
            </section>
          )}
          {step === 3 && (
            <section aria-labelledby="launch-name-title">
              <h2 id="launch-name-title" className="section-title">
                3 · Name and price
              </h2>
              <p>The ENS label is permanent and must be free on Sepolia.</p>
              <div className="wizard-fields">
                <label className="control-label">
                  Worker name
                  <div className="label-input">
                    <input
                      className="form-control form-control--mono"
                      maxLength={32}
                      spellCheck={false}
                      value={label}
                      onChange={(event) => setLabel(event.target.value.toLowerCase())}
                    />
                    <span className="mono">.{publicEnv.ensParentName}</span>
                  </div>
                  {!validLabel && label && (
                    <span className="field-error">
                      Use 3–32 lowercase letters, digits, or hyphens.
                    </span>
                  )}
                  {validLabel && !publicEnv.sepoliaRpcUrl && (
                    <span className="field-error">
                      Set NEXT_PUBLIC_SEPOLIA_RPC_URL to check name availability.
                    </span>
                  )}
                  {validLabel && publicEnv.sepoliaRpcUrl && availability.isPending && (
                    <span className="muted">Checking the registrar on Sepolia…</span>
                  )}
                  {availability.data === true && (
                    <span className="stamp stamp--green">AVAILABLE ON SEPOLIA</span>
                  )}
                  {availability.data === false && (
                    <span className="field-error">This name is already registered.</span>
                  )}
                  {availability.isError && (
                    <span className="field-error">
                      Availability check failed: {availability.error.message}
                    </span>
                  )}
                </label>
                <label className="control-label">
                  Price per {skillPricing?.unit ?? "unit"} (USDC)
                  <input
                    className="form-control form-control--mono"
                    inputMode="decimal"
                    value={price}
                    onChange={(event) => setPrice(event.target.value)}
                  />
                  {skillPricing && (
                    <span className="muted">
                      Suggested {decimalFromAtomic(BigInt(skillPricing.suggestedPriceAtomic))} USDC
                      (4× the 0G cost).{" "}
                      <button
                        className="chip chip__action"
                        type="button"
                        onClick={() =>
                          setPrice(decimalFromAtomic(BigInt(skillPricing.suggestedPriceAtomic)))
                        }
                      >
                        use suggested
                      </button>
                    </span>
                  )}
                  {price && !validPrice && (
                    <span className="field-error">
                      Enter a positive amount up to 10 USDC with at most six decimal places.
                    </span>
                  )}
                </label>
                <label className="control-label">
                  Description
                  <textarea
                    className="form-control"
                    maxLength={500}
                    rows={3}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                  <span className="muted">
                    {description.length}/500 · written to the ENS <code>description</code> record
                  </span>
                </label>
              </div>
            </section>
          )}
          {step === 4 && (
            <section aria-labelledby="launch-budget-title">
              <h2 id="launch-budget-title" className="section-title">
                4 · Budget and keys
              </h2>
              <p>
                The budget guard refuses any job that would push today’s 0G spend past this cap.
              </p>
              <div className="wizard-fields">
                <label className="control-label cap-input">
                  Daily 0G credit cap (USD)
                  <input
                    className="form-control form-control--mono"
                    inputMode="decimal"
                    value={cap}
                    onChange={(event) => setCap(event.target.value)}
                  />
                  {creditMicro !== null && creditMicro > 0n && capMicro !== null && (
                    <span className="muted">
                      {((capMicro * 100n) / creditMicro).toString()}% of today’s credits
                    </span>
                  )}
                  {cap && !validCap && (
                    <span className="field-error">
                      Enter a positive amount up to $1,000 with at most six decimal places.
                    </span>
                  )}
                </label>
                <label className="control-label">
                  0G inference key
                  <input
                    autoComplete="off"
                    className="form-control form-control--mono"
                    placeholder="sk-…"
                    spellCheck={false}
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  <span className="muted">
                    Create one at <ExternalLink href="https://pc.0g.ai">pc.0g.ai</ExternalLink> →
                    API Keys and label it <code>nightshift-{label || "<name>"}</code>. The server
                    tests it with a one-token call and stores it encrypted; it never returns to the
                    browser.
                  </span>
                  {apiKey && !validApiKey && (
                    <span className="field-error">Inference keys start with sk-.</span>
                  )}
                </label>
                <label className="control-label">
                  Hedera payout account (optional)
                  <input
                    className="form-control form-control--mono"
                    placeholder="0.0.12345"
                    spellCheck={false}
                    value={payoutAccount}
                    onChange={(event) => setPayoutAccount(event.target.value)}
                  />
                  <span className="muted">
                    Receives 90% of earnings at payday (00:00 UTC). Must hold a USDC association.
                    You can add it later on the dashboard.
                  </span>
                  {!validPayout && (
                    <span className="field-error">Use a Hedera id like 0.0.12345.</span>
                  )}
                </label>
              </div>
            </section>
          )}
          <div className="wizard-nav">
            <Button disabled={step <= 1} onClick={() => setStep((s) => Math.max(1, s - 1))}>
              ← Back
            </Button>
            {step < 4 ? (
              <Button
                variant="ink"
                disabled={!stepValid[step - 1]}
                onClick={() => setStep((s) => s + 1)}
              >
                Continue →
              </Button>
            ) : (
              <Button variant="ink" disabled={!allValid} onClick={() => void submit()}>
                Launch worker
              </Button>
            )}
          </div>
          {step === 4 && !allValid && (
            <p className="muted small-note">
              Complete every step first:{" "}
              {[
                !stepValid[0] && "wallet",
                !stepValid[2] && "name, price and description",
                !stepValid[3] && "cap and keys",
              ]
                .filter(Boolean)
                .join(", ")}
              .
            </p>
          )}
        </div>
      </section>
      <aside className="wizard-summary">
        <div className="id-card__band mono">NIGHTSHIFT · WORKER ID</div>
        <div className="wizard-preview">
          <MoonAvatar size={60} label="New worker" />
          <div>
            <strong>{label || "Your worker"}</strong>
            <span className="mono">.{publicEnv.ensParentName}</span>
          </div>
        </div>
        <div className="wizard-preview-details mono">
          <span>
            skill <b>{skill}</b>
          </span>
          <span>
            rate{" "}
            <b>
              {price || "—"} USDC / {skillPricing?.unit ?? "unit"}
            </b>
          </span>
          <span>
            cap <b>${cap || "—"} / day</b>
          </span>
          <span>
            owner <b>{ownerWallet ? `${ownerWallet.slice(0, 6)}…${ownerWallet.slice(-4)}` : "—"}</b>
          </span>
        </div>
        <div className="machine-line mono">
          NS&lt;&lt;{skill.toUpperCase()}&lt;&lt;{label.toUpperCase()}
        </div>
        <Link className="chip preview-link" href="/directory">
          See the public directory →
        </Link>
      </aside>
    </div>
  );
}

function LaunchProgress({
  lines,
  phase,
  error,
  result,
  onBack,
}: {
  lines: LaunchLine[];
  phase: "launching" | "done" | "failed";
  error: string | null;
  result: LaunchResult | null;
  onBack: () => void;
}) {
  const rows = stepStates(lines);
  return (
    <section className="section-block" aria-live="polite">
      <div className="card console-tape">
        {rows.map((row) => {
          const tx = row.txHash ? etherscanTransactionUrl(row.txHash) : null;
          const account = row.account ? hashscanAccountUrl(row.account) : null;
          const tone =
            row.status === "failed"
              ? " event-row--red"
              : row.status === "done"
                ? " event-row--blue"
                : row.status === "running" || row.status === "sent"
                  ? " event-row--orange"
                  : "";
          return (
            <article className={`event-row${tone}`} key={row.step}>
              <span className="mono">{row.step.replace("_", " ")}</span>
              <strong className="mono">
                {row.status === "done"
                  ? "✓ DONE"
                  : row.status === "sent"
                    ? "SENT"
                    : row.status === "running"
                      ? "…"
                      : row.status.toUpperCase()}
              </strong>
              <span>
                <b>{STEP_LABELS[row.step]}</b>
                {row.account && (
                  <span className="event-detail">
                    {" "}
                    {account ? (
                      <ExternalLink href={account}>{row.account}</ExternalLink>
                    ) : (
                      row.account
                    )}
                  </span>
                )}
                {row.txHash && (
                  <span className="event-detail">
                    {" "}
                    {tx ? <ExternalLink href={tx}>Sepolia tx ↗</ExternalLink> : row.txHash}
                    {row.status === "sent" ? " · waiting for confirmation (~12 s)" : ""}
                  </span>
                )}
                {row.note && <span className="event-detail"> {row.note}</span>}
              </span>
            </article>
          );
        })}
        {phase === "launching" && (
          <div className="event-row">
            <span className="mono">now</span>
            <strong className="text-orange">RUNNING</strong>
            <span>Keep this tab open. Sepolia confirmations take a few seconds each.</span>
          </div>
        )}
      </div>
      {phase === "failed" && error && <ErrorPanel message={error} />}
      {phase === "failed" && <Button onClick={onBack}>← Back to the form</Button>}
      {phase === "done" && result && (
        <div className="complete-banner section-block">
          <span className="stamp stamp--green stamp--tilt-left">WORKER LIVE</span>
          <p>
            <strong>{result.ensName}</strong> is registered and accepting paid jobs.
          </p>
          <p className="mono">
            {etherscanTransactionUrl(result.registerTx) && (
              <ExternalLink href={etherscanTransactionUrl(result.registerTx)!}>
                Registration tx ↗
              </ExternalLink>
            )}{" "}
            · <ExternalLink href={ensAppUrl(result.ensName)}>ENS records ↗</ExternalLink>
            {hashscanAccountUrl(result.hederaAccount) && (
              <>
                {" "}
                ·{" "}
                <ExternalLink href={hashscanAccountUrl(result.hederaAccount)!}>
                  Hedera {result.hederaAccount} ↗
                </ExternalLink>
              </>
            )}
          </p>
          <Link className="button button--ink" href="/dashboard">
            Open your dashboard →
          </Link>{" "}
          <Link
            className="button"
            href={`/agents/${encodeURIComponent(result.ensName.split(".")[0]!)}`}
          >
            Public profile
          </Link>
        </div>
      )}
    </section>
  );
}

/** Minimal async action state (one in-flight call, last result or error). */
function useMutationState<T>() {
  const [state, setState] = useState<{ pending: boolean; data: T | null; error: string | null }>({
    pending: false,
    data: null,
    error: null,
  });
  return {
    ...state,
    async run(fn: () => Promise<T>) {
      setState((s) => ({ ...s, pending: true, error: null }));
      try {
        const data = await fn();
        setState({ pending: false, data, error: null });
      } catch (error) {
        setState({
          pending: false,
          data: null,
          error: error instanceof Error ? error.message : "Request failed.",
        });
      }
    },
  };
}
