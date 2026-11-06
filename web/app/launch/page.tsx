"use client";

import Link from "next/link";
import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { SKILL_IDS } from "@nightshift/shared/constants";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../components/ui/Button";
import { MoonAvatar } from "../../components/ui/MoonAvatar";
import { ErrorPanel, LoadingPanel, PageFrame } from "../../components/Product";
import { checkRegistrarAvailable } from "../../lib/chain";
import { publicEnv } from "../../lib/public-env";

const skillLabels: Record<(typeof SKILL_IDS)[number], string> = {
  "transcribe:ta": "Tamil transcription",
  "transcribe:hi": "Hindi transcription",
  "transcribe:en": "English transcription",
};

function atomicFromDecimal(value: string): bigint | null {
  if (!/^(?:\d+)(?:\.\d{0,6})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
}

export default function LaunchPage() {
  if (!publicEnv.privyAppId) {
    return (
      <PageFrame
        kicker="Form NS-1 · application for a night shift"
        title="Put tonight’s credits"
        accent="to work."
        description="A four-step launch wizard."
      >
        <ErrorPanel message="Privy and the owner launch API are not configured. You can review this form, but no credentials will be collected and no launch can be submitted." />
        <LaunchWizard authenticated={false} onSignInUnavailable />
      </PageFrame>
    );
  }
  return <PrivyLaunch />;
}

function PrivyLaunch() {
  const { ready, authenticated, login, user } = usePrivy();
  const [loginError, setLoginError] = useState<string | null>(null);
  if (!ready)
    return (
      <main className="wrap product-page">
        <LoadingPanel label="Checking Privy session…" />
      </main>
    );
  return (
    <PageFrame
      kicker="Form NS-1 · application for a night shift"
      title="Put tonight’s credits"
      accent="to work."
      description="Four steps to prepare a worker. Launch submission remains disabled until the owner API exists."
    >
      {!authenticated ? (
        <div className="alert-note launch-auth">
          <strong>Sign in with Privy to begin.</strong>
          <p>Your connected wallet would own the ENS name.</p>
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
        </div>
      ) : (
        <LaunchWizard
          authenticated
          onSignInUnavailable={false}
          wallet={user?.wallet?.address ?? ""}
        />
      )}
    </PageFrame>
  );
}

function LaunchWizard({
  authenticated,
  onSignInUnavailable,
  wallet = "",
}: {
  authenticated: boolean;
  onSignInUnavailable: boolean;
  wallet?: string;
}) {
  const [step, setStep] = useState(1);
  const [skill, setSkill] = useState<(typeof SKILL_IDS)[number]>("transcribe:ta");
  const [label, setLabel] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [cap, setCap] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const validLabel = /^[a-z0-9-]{3,32}$/.test(label);
  const priceAtomic = atomicFromDecimal(price);
  const validPrice = priceAtomic !== null && priceAtomic > 0n;
  const capAtomic = atomicFromDecimal(cap);
  const validCap = capAtomic !== null && capAtomic > 0n;
  const availability = useQuery({
    queryKey: ["label-availability", label],
    enabled: validLabel && Boolean(publicEnv.sepoliaRpcUrl),
    queryFn: () => checkRegistrarAvailable(label),
    retry: 1,
  });

  function canAdvance() {
    if (step === 1) return authenticated;
    if (step === 3)
      return validLabel && validPrice && Boolean(description.trim()) && availability.data === true;
    if (step === 4) return validCap;
    return true;
  }

  function next() {
    if (!canAdvance()) return;
    if (step < 4) setStep((current) => current + 1);
  }

  const launchAvailability = publicEnv.sepoliaRpcUrl
    ? "Name availability is read from Sepolia when the label is valid."
    : "Set a Sepolia RPC URL to check ENS name availability.";

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
              <p>Your worker spends your 0G credits, so start with your account.</p>
              {authenticated ? (
                <div className="alert-note mono-wrap">
                  <strong>Signed in with Privy</strong>
                  <br />
                  {wallet || "Wallet address unavailable"}
                  <p>
                    This wallet will own the ENS name. No wallet address is stored or submitted by
                    this frontend.
                  </p>
                </div>
              ) : (
                <ErrorPanel
                  message={
                    onSignInUnavailable
                      ? "Privy is not configured; authentication cannot be started."
                      : "Sign in before starting a launch application."
                  }
                />
              )}
              <p className="muted small-note">
                0G balance and credit expiry are not exposed by the available public API.
              </p>
            </section>
          )}
          {step === 2 && (
            <section aria-labelledby="launch-skill-title">
              <h2 id="launch-skill-title" className="section-title">
                2 · What will it sell?
              </h2>
              <p>Choose a transcription skill supported by the current server.</p>
              <div className="skill-options">
                {SKILL_IDS.map((skillId) => (
                  <button
                    aria-pressed={skill === skillId}
                    className={`skill-option${skill === skillId ? " is-selected" : ""}`}
                    key={skillId}
                    onClick={() => setSkill(skillId)}
                    type="button"
                  >
                    <strong>{skillLabels[skillId]}</strong>
                    <span className="mono">{skillId} · whisper-large-v3</span>
                  </button>
                ))}
                <div className="skill-option skill-option--disabled" aria-disabled="true">
                  <strong>
                    Read documents <span className="stamp">SOON</span>
                  </strong>
                  <span className="mono">OCR is not supported by the current server.</span>
                </div>
              </div>
            </section>
          )}
          {step === 3 && (
            <section aria-labelledby="launch-name-title">
              <h2 id="launch-name-title" className="section-title">
                3 · Name and price
              </h2>
              <p>The permanent ENS label must be available on Sepolia.</p>
              <div className="wizard-fields">
                <label className="control-label">
                  Worker name
                  <div className="label-input">
                    <input
                      className="form-control form-control--mono"
                      maxLength={32}
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
                    <span className="field-error">{launchAvailability}</span>
                  )}
                  {validLabel && publicEnv.sepoliaRpcUrl && availability.isPending && (
                    <span className="muted">Checking registrar availability…</span>
                  )}
                  {availability.data === true && (
                    <span className="stamp stamp--green">AVAILABLE ON SEPOLIA</span>
                  )}
                  {availability.data === false && (
                    <span className="field-error">This ENS label is already registered.</span>
                  )}
                  {availability.isError && (
                    <span className="field-error">
                      Availability check failed: {availability.error.message}
                    </span>
                  )}
                </label>
                <label className="control-label">
                  Price per unit (USDC)
                  <input
                    className="form-control form-control--mono"
                    inputMode="decimal"
                    value={price}
                    onChange={(event) => setPrice(event.target.value)}
                  />
                  {price && !validPrice && (
                    <span className="field-error">
                      Enter a positive value with at most six decimal places.
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
                  <span className="muted">{description.length}/500 · required</span>
                </label>
              </div>
            </section>
          )}
          {step === 4 && (
            <section aria-labelledby="launch-budget-title">
              <h2 id="launch-budget-title" className="section-title">
                4 · Budget and keys
              </h2>
              <p>The budget guard refuses work that would cross this daily credit cap.</p>
              <label className="control-label cap-input">
                Daily 0G credit cap (USD)
                <input
                  className="form-control form-control--mono"
                  inputMode="decimal"
                  value={cap}
                  onChange={(event) => setCap(event.target.value)}
                />
                {cap && !validCap && (
                  <span className="field-error">
                    Enter a positive amount with at most six decimal places.
                  </span>
                )}
              </label>
              <div className="alert-note section-block">
                <strong>Launch is unavailable — safely.</strong>
                <p>
                  The repository’s server does not implement <code>POST /me/agents</code>. No 0G
                  keys, management keys, or payout accounts are collected in this browser.
                </p>
                <p>
                  Once that owner API is available, the server must validate and encrypt keys,
                  create the Hedera account, and mint the ENS name.
                </p>
              </div>
            </section>
          )}
          {submitted && (
            <ErrorPanel message="Application not submitted. POST /me/agents is missing; no launch operation or transaction was started." />
          )}
          <div className="wizard-nav">
            <Button
              disabled={step <= 1}
              onClick={() => setStep((current) => Math.max(1, current - 1))}
            >
              ← Back
            </Button>
            {step < 4 ? (
              <Button variant="ink" disabled={!canAdvance()} onClick={next}>
                Continue →
              </Button>
            ) : (
              <Button
                variant="ink"
                disabled={!authenticated || !validCap}
                onClick={() => setSubmitted(true)}
              >
                Submit application
              </Button>
            )}
          </div>
          {step === 4 && (
            <p className="muted small-note">
              Submission remains blocked regardless of form validity until the server route is
              implemented.
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
            rate <b>{price || "—"} USDC</b>
          </span>
          <span>
            cap <b>${cap || "—"} / day</b>
          </span>
          <span>
            owner <b>{wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "not connected"}</b>
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
