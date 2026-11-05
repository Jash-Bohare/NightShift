#!/usr/bin/env bash
# P1.6 live smoke on Sepolia: register SMOKE_LABEL through the registrar, then prove the split
# permissions with real transactions (owner write OK, owner reputation write REVERTS on-chain,
# registrar reputation write OK). Prints Etherscan links; run from contracts/ with ../.env loaded.
set -euo pipefail
RPC="$SEPOLIA_RPC_URL"
LABEL="${SMOKE_LABEL:-hello2}"
NAME="$LABEL.nightshift.eth"
REGISTRAR=$(python3 -c 'import json;print(json.load(open("deployments/sepolia.json"))["nightshiftRegistrar"])')
link() { echo "https://sepolia.etherscan.io/tx/$1"; }

if [ "$(cast call "$REGISTRAR" 'available(string)(bool)' "$LABEL" --rpc-url "$RPC")" = "true" ]; then
  forge script script/02_SmokeRegister.s.sol --rpc-url sepolia --broadcast --skip-simulation -g 110 --slow \
    | grep -E "registered|resolver:|owner:"
  python3 -c 'import json;b=json.load(open("broadcast/02_SmokeRegister.s.sol/11155111/run-latest.json"));r=b["receipts"][0];print("register tx", r["transactionHash"], "status", r["status"], "gas", int(r["gasUsed"],16))'
else
  echo "$NAME already registered"
fi

RESOLVER=$(cast call "$REGISTRAR" 'resolverOf(bytes32)(address)' "$(cast keccak "$LABEL")" --rpc-url "$RPC")
DNS=$(cast call "$REGISTRAR" 'dnsNameOf(string)(bytes)' "$LABEL" --rpc-url "$RPC")
echo "resolver $RESOLVER"

send() { # key, to, sig, args... ; prints "status hash"
  local key=$1 to=$2; shift 2
  cast send "$to" "$@" --private-key "$key" --rpc-url "$RPC" --json \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(int(d["status"],16), d["transactionHash"])'
}

read -r s h < <(send "$SMOKE_OWNER_PRIVATE_KEY" "$RESOLVER" 'setText(bytes,string,string)' "$DNS" description "Updated by the agent owner")
echo "owner setText(description): status=$s $(link "$h")"

# Fixed gas limit so cast broadcasts instead of refusing on the failed estimate: we want the
# revert on-chain as proof.
read -r s h < <(send "$SMOKE_OWNER_PRIVATE_KEY" "$RESOLVER" 'setText(bytes,string,string)' "$DNS" nightshift.reputation '{"jobs":9999}' --gas-limit 600000)
echo "owner setText(nightshift.reputation): status=$s (expect 0) $(link "$h")"

read -r s h < <(send "$ENS_OPERATOR_PRIVATE_KEY" "$REGISTRAR" 'setReputation(string,string)' "$LABEL" '{"jobs":1,"success_rate":1,"source":"smoke"}')
echo "registrar setReputation: status=$s $(link "$h")"
