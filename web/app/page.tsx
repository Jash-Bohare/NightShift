"use client";

// P0.7 spike: bare Privy login on localhost:3000. Replaced by the real landing page in P4.2.
import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";

export default function Home() {
  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID) {
    return (
      <main style={{ fontFamily: "system-ui", padding: 24 }}>
        <h1>Nightshift — Privy spike</h1>
        <p>
          Set <code>NEXT_PUBLIC_PRIVY_APP_ID</code> in <code>web/.env.local</code> and restart{" "}
          <code>pnpm -C web dev</code>.
        </p>
      </main>
    );
  }
  return <PrivySpike />;
}

function PrivySpike() {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const [tokenInfo, setTokenInfo] = useState<string>("");

  async function checkToken() {
    const token = await getAccessToken();
    // Never render the token itself; its presence and expiry are enough for the spike.
    if (!token) return setTokenInfo("no token");
    const payload = JSON.parse(atob(token.split(".")[1]!)) as { exp: number; sub: string };
    const local = `JWT for ${payload.sub}, expires ${new Date(payload.exp * 1000).toISOString()}`;
    // Server-side check via scripts/spikes/privy-verify.ts (@privy-io/node).
    try {
      const res = await fetch("http://localhost:8788/verify", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { ok: boolean; user_id?: string };
      setTokenInfo(`${local} | server verify: ${body.ok ? `OK (${body.user_id})` : "REJECTED"}`);
    } catch {
      setTokenInfo(`${local} | server verify: verify spike not running on :8788`);
    }
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>Nightshift — Privy spike</h1>
      <p>Privy ready: {String(ready)}</p>
      {ready && !authenticated && <button onClick={login}>Log in</button>}
      {ready && authenticated && (
        <>
          <p>Privy user: {user?.id}</p>
          <p>Wallet: {user?.wallet?.address ?? "none"}</p>
          <p>Email: {user?.email?.address ?? "none"}</p>
          <button onClick={checkToken}>Get access token</button>{" "}
          <button onClick={logout}>Log out</button>
          {tokenInfo && <p>{tokenInfo}</p>}
        </>
      )}
    </main>
  );
}
