import { fileURLToPath } from "node:url";

/** Written by dev/simulated-stack.ts (public quote key + URLs only), read by dev/simulated-buyer.ts. */
export const STACK_INFO_PATH = fileURLToPath(
  new URL("../../.simulated-stack.json", import.meta.url),
);
