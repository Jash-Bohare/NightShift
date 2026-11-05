// P0.7 spike: server-side Privy access-token verification with @privy-io/node.
// The web spike page POSTs its token here; we never log the token itself.
// Run: pnpm -C scripts exec tsx spikes/privy-verify.ts
import { createServer } from "node:http";
import { PrivyClient } from "@privy-io/node";
import { need } from "../env.js";

const PORT = 8788;
const ORIGIN = need("WEB_ORIGIN");
const privy = new PrivyClient({ appId: need("PRIVY_APP_ID"), appSecret: need("PRIVY_APP_SECRET") });

createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "authorization");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method !== "POST" || req.url !== "/verify") return res.writeHead(404).end();

  const token = req.headers.authorization?.replace(/^Bearer /, "");
  try {
    if (!token) throw new Error("missing bearer token");
    const claims = await privy.utils().auth().verifyAccessToken(token);
    console.log(
      `[privy] verified user=${claims.user_id} app=${claims.app_id} exp=${new Date(claims.expiration * 1000).toISOString()}`,
    );
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        ok: true,
        user_id: claims.user_id,
        app_id: claims.app_id,
        expiration: claims.expiration,
      }),
    );
  } catch (err) {
    console.log(`[privy] verify failed: ${(err as Error).message}`);
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
  }
}).listen(PORT, () => console.log(`[privy] verify spike on :${PORT}, allowing ${ORIGIN}`));
