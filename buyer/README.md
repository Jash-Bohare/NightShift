# Buyer execution and verification

The buyer is a deterministic TypeScript client. It discovers candidates from the public
`/directory` API, verifies each candidate against Sepolia ENS, the deployed NightShift registrar,
and UserRegistry, then checks the server quote and buyer spend rules before creating an x402
payment-capable fetch.

## Verification boundaries

- Directory fields are discovery hints, not identity proof. Registrar registry/resolver, ENS
  resolver, UserRegistry status/expiry/owner, and ENS worker records are read on Sepolia.
- Quotes are Ed25519-signed by the server, bind worker identity and payment requirements, and
  expire after 120 seconds. The buyer validates the signature and claims before preparing payment.
- A successful job response and `PAYMENT-RESPONSE` header are not independent settlement proof.
  Payment is checked against Hedera Mirror Node transfers; a job-specific signed capability
  retrieves allow-listed status from `GET /jobs/:id/status`. The buyer matches worker, amount,
  transaction, output digest, and settled status. HCS is checked when a sequence is available.
- The server records each quote nonce only after x402 payment verification. A nonce can be claimed
  once; a repeated paid request is rejected. An unpaid x402 challenge does not consume the nonce.
- Before deploying this server revision, apply
  `supabase/migrations/0004_signed_quotes_and_job_integrity.sql`; it adds the output digest and
  service-role-only quote redemption table. The migration is not applied by the buyer or tests.
- The server and buyer compare the UTF-8 output's SHA-256 digest with the job record and HCS log.
  This verifies output integrity linkage only; it does not prove provider authenticity or TEE
  attestation.
- An uncertain paid request or incomplete settlement retains `.buyer-run.lock`. Resolve the
  transaction and job manually before removing that lock. The buyer will not retry an uncertain
  paid request automatically.
- Only the server's structured `over_budget` and `no_credits` HTTP 503 prechecks are treated as
  safe unpaid refusals. Any other 503 is uncertain and blocks automatic fallback.
- `runBuyer` accepts injected dependencies for tests. The automated test suite uses mocked
  providers and does not submit transactions or execute paid jobs.

## Configuration

The CLI loads the repository `.env` file when present. Required settings for an execution include `BUYER_SERVER_URL`,
`BUYER_HEDERA_ACCOUNT_ID`, `BUYER_HEDERA_PRIVATE_KEY`, `NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY`,
`SEPOLIA_RPC_URL`, and `HEDERA_MIRROR_URL`. The signing private key
`NIGHTSHIFT_QUOTE_SIGNING_PRIVATE_KEY` belongs only on the server. HCS verification is optional
for the buyer and requires `HEDERA_HCS_TOPIC_ID`. The buyer uses deterministic policy-based worker
selection and does not require an 0G/LLM API key.

Generate a matching Ed25519 key pair locally:

```powershell
node -e "const {generateKeyPairSync}=require('node:crypto');const p=generateKeyPairSync('ed25519');console.log('NIGHTSHIFT_QUOTE_SIGNING_PRIVATE_KEY='+p.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'));console.log('NIGHTSHIFT_QUOTE_VERIFY_PUBLIC_KEY='+p.publicKey.export({format:'der',type:'spki'}).toString('base64'))"
```

Keep the first base64 value as the server-only private key. Set the second as the verification
public key in server and buyer environments. Store the private value as a secret and do not send it
to the buyer or frontend.

Run the read-only integration preflight before an end-to-end attempt:

```powershell
pnpm -C buyer start -- --preflight
```

It reports `PASS`, `FAIL`, and `NOT CONFIGURED`, checks public endpoints, Sepolia, worker
registration, signed quotes and the Hedera Mirror Node, and never creates a payment-capable
request. `PREFLIGHT_SKILL` can select a different directory skill.

Run the unit tests and static check with:

```powershell
pnpm -C buyer test
pnpm -C buyer typecheck
```

Live provider connectivity, real account balances, transaction submission, and settlement have not
been exercised by these automated tests.
