# Feedback

Running notes on sponsor developer experience, doc corrections and go/no-go decisions.

## 0G

- Mainnet account `0xe79e…41a1` shows `deposit_balance: 0`, `credit_balance: 0` after connecting the wallet and creating `sk-`/`mk-` keys; no hackathon credits yet. Mainnet `/v1/account/balance` reports `currency: "usd"`, not neuron as the Router docs suggest.
- Testnet Router `/v1/models` lists only `0gm-1.0-35b-a3b` and `qwen-image-edit` — no Whisper, so testnet can't serve the transcription skill.
- Asked on the 0G Discord; the team runs a credit-request thread (project name, 1–2 line description, wallet address) and granted $5 to `0xe79e3fc7463a85e43a75bcd1f191818aa3f941a1`. Asking there was quick and easy; it just isn't mentioned in the Router docs.
- Units are mixed. Balances, `x_0g_trace.billing` and usage history are all **micro-USD**; `/v1/models` `pricing` is **neuron** while `pricing_usd` is a decimal USD string. The docs only describe neuron. We moved all Nightshift 0G amounts to micro-USD (migration `0002`).
- Router `sk-` calls consume granted credits (`credit_used` in usage history), so the "daily credits" pitch holds. Whisper's id is `whisper-large-v3` (the docs example `openai/whisper-large-v3` is only the internal `model_id`), it bills per second of audio, and the audio response carries `x_0g_trace` just like chat.

## Hedera / x402

- (P2.4) Dynamic `price`/`payTo` per agent worked first try with `{asset, amount}` prices; the Hedera scheme still adds `extra.feePayer` from `/supported`. The handler→hook handoff via `transportContext.responseHeaders` is undocumented (the hook types say `transportContext: unknown`), found by reading `@x402/express` source.

- x402.org facilitator settled a USDC payment on `hedera:testnet` first try; all three facilitators (x402.org, Blocky402, Ax402) advertise `hedera:testnet` in `/supported`, but `/supported` doesn't list accepted assets, so USDC support can only be confirmed by paying.
- Corrections from reading `@x402/*@2.28.0` source: testnet USDC is the scheme's default asset (no `defaultAssets` override and no `allowedAssets` entry needed); settlement-after-handler only holds for the default `"authorization"` flow, the Hedera scheme also offers `"upfront"`.
- Hiero SDK 2.85.0 deprecates `AccountCreateTransaction.setKey` in favor of `setKeyWithoutAlias` / `setECDSAKeyWithAlias`.

## ENS

- (P2.5) `registerAgent` with 8 records cost 8.19M gas on Sepolia, about half the 16.7M per-tx cap. A launch with many more records would need a second tx.

- ENSv2 on Sepolia worked first try from viem: UserRegistry via VerifiableFactory → `setSubregistry` on ETHRegistry → per-name PermissionedResolver → `register` → `setText`, and viem 2.57's `getEnsText` resolved it through the Universal Resolver with no overrides. The deployed-ABI JSONs in `contracts/deployments/sepolia/` were the fastest source of truth.
- Corrections: registry role bit positions (`ROLE_UNREGISTER 1<<12`, `ROLE_SET_SUBREGISTRY 1<<20`, `ROLE_SET_RESOLVER 1<<24`, `ROLE_CAN_TRANSFER_ADMIN (1<<28)<<128`) and `TextUpdated` indexing (keyHash indexed, key/value in data).

## Privy

- 0G's hackathon Privy app id wasn't available; ETHGlobal staff suggested a personal Privy app. Login on localhost:3000 with email works, the embedded EVM wallet is created on first login, and `@privy-io/node` `verifyAccessToken` accepts the token server-side. Trade-off: no 0G-credit reading through Privy; owners paste 0G keys instead (documented fallback).
- Foundry 1.8.1 on Sepolia: script simulation estimated 2.7M gas for the registrar deploy, the chain needed 14.4M (out-of-gas on the first broadcast). Workaround `--skip-simulation -g 110`. Separately, `--verify` mis-collects sources behind contracts-v2's context remapping for openzeppelin-contracts-v4; verified via standard-JSON rebuilt from metadata (`contracts/script/verify-from-metadata.py`).

## Phase 0 go / no-go

- **GO on all three sponsors, no fallbacks used.**
  - **0G: GO.** Mainnet Router calls with team credits return a `request_id` (chat and Whisper). Credits are consumed, so the original pitch stands rather than "daily AI budget".
  - **Hedera: GO.** A USDC x402 payment settled on testnet via x402.org.
  - **ENS: GO.** `hello.nightshift.eth` resolved `agent-context` via viem; the registrar path was later proven on `hello2`/`hello3`.


## Tooling

- `@supabase/supabase-js` 2.119 throws at `createClient` on Node 20 ("native WebSocket not found") even when Realtime is never used; fixed by passing `realtime: { transport: ws }`. supabase-js also warns that Node ≤ 20 is deprecated.
