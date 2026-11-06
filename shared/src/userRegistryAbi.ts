export const userRegistryAbi = [
  {
    type: "function",
    name: "getExpiry",
    stateMutability: "view",
    inputs: [{ name: "anyId", type: "uint256" }],
    outputs: [{ name: "expiry", type: "uint64" }],
  },
  {
    type: "function",
    name: "getStatus",
    stateMutability: "view",
    inputs: [{ name: "anyId", type: "uint256" }],
    outputs: [{ name: "status", type: "uint8" }],
  },
  {
    type: "function",
    name: "getOwner",
    stateMutability: "view",
    inputs: [{ name: "anyId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const;
