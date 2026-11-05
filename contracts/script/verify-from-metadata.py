#!/usr/bin/env python3
"""Etherscan verification from the build's own solc metadata.

forge 1.8.1's `--verify` drops sources that are resolved through context-specific remappings
(ens-contracts -> openzeppelin-contracts-v4), so Etherscan can't compile the upload. This script
rebuilds the exact standard-JSON input from out/<Contract>.json metadata, proves locally that it
reproduces the deployed bytecode, then submits it to the Etherscan v2 API.

Usage (from contracts/, with ../.env loaded):
  python3 script/verify-from-metadata.py <address> <constructor-args-hex> [--submit]
"""
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

ARTIFACT = "out/NightshiftRegistrar.sol/NightshiftRegistrar.json"
CHAIN_ID = 11155111


def standard_json() -> tuple[dict, str, str]:
    art = json.load(open(ARTIFACT))
    meta = json.loads(art["rawMetadata"])
    settings = dict(meta["settings"])
    target_file, target_name = next(iter(settings.pop("compilationTarget").items()))
    settings["outputSelection"] = {"*": {"*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"]}}
    sources = {}
    for path, info in meta["sources"].items():
        content = open(path).read()
        sources[path] = {"content": content}
    return (
        {"language": meta["language"], "sources": sources, "settings": settings},
        f"{target_file}:{target_name}",
        meta["compiler"]["version"],
    )


def check_reproduces(inp: dict, target: str, version: str) -> None:
    v = version.split("+")[0]
    candidates = [f"~/.local/share/svm/{v}/solc-{v}", f"~/.svm/{v}/solc-{v}"]
    solc = next(p for p in map(os.path.expanduser, candidates) if os.path.exists(p))
    out = subprocess.run([solc, "--standard-json"], input=json.dumps(inp), capture_output=True, text=True, check=True)
    result = json.loads(out.stdout)
    errors = [e for e in result.get("errors", []) if e["severity"] == "error"]
    if errors:
        sys.exit(f"solc errors: {errors[0]['formattedMessage']}")
    file, name = target.split(":")
    rebuilt = result["contracts"][file][name]["evm"]["deployedBytecode"]["object"]
    built = json.load(open(ARTIFACT))["deployedBytecode"]["object"].removeprefix("0x")
    if rebuilt != built:
        sys.exit("rebuilt deployedBytecode differs from forge artifact; not submitting")
    print(f"OK: standard-json input reproduces the artifact bytecode exactly ({len(built) // 2} bytes)")


def etherscan(params: dict, post: bool = False) -> dict:
    url = f"https://api.etherscan.io/v2/api?chainid={CHAIN_ID}"
    data = urllib.parse.urlencode({**params, "apikey": os.environ["ETHERSCAN_API_KEY"]}).encode()
    req = urllib.request.Request(url, data=data if post else None)
    if not post:
        req = urllib.request.Request(url + "&" + data.decode())
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main() -> None:
    address, ctor_args = sys.argv[1], sys.argv[2].removeprefix("0x")
    inp, target, version = standard_json()
    check_reproduces(inp, target, version)
    if "--submit" not in sys.argv:
        return
    res = etherscan(
        {
            "module": "contract",
            "action": "verifysourcecode",
            "contractaddress": address,
            "sourceCode": json.dumps(inp),
            "codeformat": "solidity-standard-json-input",
            "contractname": target,
            "compilerversion": f"v{version}",
            "constructorArguements": ctor_args,
        },
        post=True,
    )
    print("submit:", res)
    if res.get("status") != "1":
        sys.exit(1)
    guid = res["result"]
    for _ in range(20):
        time.sleep(5)
        status = etherscan({"module": "contract", "action": "checkverifystatus", "guid": guid})
        print("status:", status.get("result"))
        if "Pending" not in str(status.get("result")):
            break


if __name__ == "__main__":
    main()
