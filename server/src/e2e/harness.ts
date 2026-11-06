// SIMULATED end-to-end harness. Real: Express app + middleware order, x402 resource server and
// hooks, quote signing/verification, nonce redemption, budget logic, job/settlement code, and
// the real buyer (discovery, ENS verification logic, quote checks, x402 client + spend policy,
// execution, digest and job-status verification). Simulated (and labelled SIMULATED): ENS chain
// reads, the x402 facilitator, Hedera Mirror Node, 0G inference, HCS and the database.
// No network request leaves localhost and no transaction is created.
import express from "express";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { labelhash, type Address } from "viem";

export const SIMULATED_TX_PREFIX = "SIMULATED-NOT-A-HEDERA-TX";
export const BUYER_ACCOUNT = "0.0.7000001";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export type SettleMode = "ok" | "definite_failure" | "uncertain";

/** Local stand-in for an x402 facilitator. It never signs or submits anything. */
export class SimulatedFacilitator {
  settleMode: SettleMode = "ok";
  verifyCalls = 0;
  settleCalls = 0;
  private server?: Server;
  url = "";

  async start(): Promise<void> {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.get("/supported", (_req, res) => {
      res.json({
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: "hedera:testnet",
            extra: { feePayer: "0.0.7000002" },
          },
        ],
        extensions: [],
        signers: {},
      });
    });
    app.post("/verify", (_req, res) => {
      this.verifyCalls++;
      res.json({ isValid: true, payer: BUYER_ACCOUNT });
    });
    app.post("/settle", (_req, res) => {
      this.settleCalls++;
      if (this.settleMode === "definite_failure") {
        res.status(400).json({
          success: false,
          errorReason: "insufficient_funds",
          transaction: "",
          network: "hedera:testnet",
        });
        return;
      }
      if (this.settleMode === "uncertain") {
        res.status(504).type("text/plain").send("SIMULATED upstream timeout");
        return;
      }
      res.json({
        success: true,
        transaction: `${SIMULATED_TX_PREFIX}-${this.settleCalls}`,
        network: "hedera:testnet",
        payer: BUYER_ACCOUNT,
      });
    });
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, "127.0.0.1", () => resolve());
    });
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

/** Simulated Sepolia state for the buyer's EnsReader and the server's registry check. */
export interface SimulatedWorker {
  label: string;
  owner: Address;
  resolver: Address;
  status: number;
  expirySeconds: bigint;
  texts: Record<string, string>;
}

export class SimulatedChain {
  readonly workers = new Map<string, SimulatedWorker>();
  // Matches contracts/deployments/sepolia.json, which the buyer checks the registrar against.
  registry: Address = "0x68177337D020e03815bE894450914d7C94682425";

  add(worker: SimulatedWorker): void {
    this.workers.set(worker.label, worker);
  }

  byLabelhash(hash: bigint): SimulatedWorker | undefined {
    return [...this.workers.values()].find((w) => BigInt(labelhash(w.label)) === hash);
  }

  ensReader() {
    const label = (name: string) => name.split(".")[0]!;
    return {
      chainId: async () => 11155111,
      registrarRegistry: async () => this.registry,
      registrarResolver: async (l: string) => this.workers.get(l)?.resolver ?? ZERO_ADDRESS,
      ensResolver: async (name: string) => this.workers.get(label(name))?.resolver ?? null,
      registryStatus: async (l: string) => this.workers.get(l)?.status ?? 0,
      registryExpiry: async (l: string) => this.workers.get(l)?.expirySeconds ?? 0n,
      registryOwner: async (l: string) => this.workers.get(l)?.owner ?? ZERO_ADDRESS,
      text: async (name: string, key: string) => this.workers.get(label(name))?.texts[key] ?? null,
    };
  }
}

/** A non-signing x402 scheme client: produces a payload marked SIMULATED, no Hedera transaction. */
export const simulatedPaymentScheme = {
  scheme: "exact",
  async createPaymentPayload(x402Version: number) {
    return {
      x402Version,
      payload: { simulated: true, note: "SIMULATED payment payload; no Hedera transaction" },
    };
  },
};

/** ES256 Privy-style access tokens signed by a locally generated key (test only). */
export class LocalPrivyIssuer {
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  readonly publicKeyPem = this.keys.publicKey.export({ format: "pem", type: "spki" }).toString();

  token(
    claims: { sub: string; aud: string; iss?: string; expiresIn?: number },
    options: { key?: ReturnType<typeof generateKeyPairSync>["privateKey"] } = {},
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "ES256", typ: "JWT" });
    const payload = encode({
      iss: claims.iss ?? "privy.io",
      aud: claims.aud,
      sub: claims.sub,
      sid: "session-test",
      iat: now - 5,
      exp: now + (claims.expiresIn ?? 600),
    });
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
      key: options.key ?? this.keys.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    return `${header}.${payload}.${signature}`;
  }
}

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
