const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:8787";

let parsedServerUrl: URL;
try {
  parsedServerUrl = new URL(serverUrl);
} catch {
  throw new Error("NEXT_PUBLIC_SERVER_URL must be an absolute HTTP or HTTPS URL");
}

if (parsedServerUrl.protocol !== "http:" && parsedServerUrl.protocol !== "https:") {
  throw new Error("NEXT_PUBLIC_SERVER_URL must be an absolute HTTP or HTTPS URL");
}

export const publicEnv = Object.freeze({
  privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "",
  serverUrl: parsedServerUrl.toString().replace(/\/+$/, ""),
  sepoliaRpcUrl: process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "",
  ensParentName: process.env.NEXT_PUBLIC_ENS_PARENT_NAME ?? "nightshift.eth",
  registrarAddress:
    process.env.NEXT_PUBLIC_NIGHTSHIFT_REGISTRAR_ADDRESS ??
    "0x9564fFd96FBaA1bF10836966990aCc88a9865705",
  hederaHcsTopicId: process.env.NEXT_PUBLIC_HEDERA_HCS_TOPIC_ID ?? "",
});
