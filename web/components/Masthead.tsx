"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { publicEnv } from "../lib/public-env";
import { truncateMiddle } from "../lib/truncate";
import { MoonAvatar } from "./ui/MoonAvatar";
import { TicketCountdown } from "./ui/TicketCountdown";

// Hosted demo (NEXT_PUBLIC_DEMO_MODE): owner pages need localhost Privy, so they are not linked.
const navigation = [
  { href: "/console", label: "Console", owner: false },
  { href: "/directory", label: "Directory", owner: false },
  { href: "/dashboard", label: "Dashboard", owner: true },
  { href: "/launch", label: "Launch", owner: true },
].filter((item) => !publicEnv.demoMode || !item.owner);

export function Masthead() {
  const pathname = usePathname();

  return (
    <header className="masthead">
      <div className="masthead__inner">
        <Link className="masthead__brand" href="/" aria-label="Nightshift home">
          <svg width="34" height="34" viewBox="0 0 300 300" aria-hidden="true">
            <defs>
              <mask id="masthead-moon-mask">
                <rect width="300" height="300" fill="#fff" />
                <circle cx="190" cy="118" r="88" fill="#000" />
              </mask>
            </defs>
            <circle
              cx="158"
              cy="158"
              r="110"
              fill="#3D63DD"
              opacity=".45"
              mask="url(#masthead-moon-mask)"
            />
            <circle
              cx="150"
              cy="150"
              r="110"
              fill="#FFC93C"
              stroke="#1F2547"
              strokeWidth="10"
              mask="url(#masthead-moon-mask)"
            />
          </svg>
          <span>nightshift</span>
        </Link>

        <nav className="masthead__nav" aria-label="Main">
          {navigation.map(({ href, label }) => {
            const active =
              pathname === href || (href === "/directory" && pathname.startsWith("/agents/"));
            return (
              <Link
                className={`masthead__link${active ? " is-active" : ""}`}
                href={href}
                key={href}
                aria-current={active ? "page" : undefined}
              >
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="masthead__actions">
          <TicketCountdown compact />
          {publicEnv.demoMode ? null : publicEnv.privyAppId ? (
            <PrivyControls />
          ) : (
            <DisabledSignIn />
          )}
        </div>
      </div>
    </header>
  );
}

function DisabledSignIn() {
  return (
    <span className="masthead__auth">
      <button className="button button--ink button--small" type="button" disabled>
        Sign in
      </button>
      <span className="sr-only">Sign in is unavailable until Privy is configured.</span>
    </span>
  );
}

function PrivyControls() {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const [error, setError] = useState<string | null>(null);
  const walletAddress = user?.wallet?.address;

  async function handleLogin(): Promise<void> {
    try {
      await login();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed");
    }
  }

  async function handleLogout(): Promise<void> {
    try {
      await logout();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign out failed");
    }
  }

  return (
    <span className="masthead__auth">
      {authenticated ? (
        <>
          <span className="chip masthead__wallet" title={walletAddress ?? undefined}>
            <MoonAvatar size={24} seed={walletAddress ?? "wallet"} />
            <span className="masthead__wallet-address">
              {walletAddress ? truncateMiddle(walletAddress) : "Wallet unavailable"}
            </span>
          </span>
          <button
            className="button button--small"
            type="button"
            onClick={() => void handleLogout()}
          >
            Sign out
          </button>
        </>
      ) : (
        <button
          className="button button--ink button--small"
          type="button"
          disabled={!ready}
          onClick={() => void handleLogin()}
        >
          Sign in
        </button>
      )}
      {error && (
        <span className="masthead__auth-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
