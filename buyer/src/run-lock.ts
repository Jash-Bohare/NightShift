import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export interface BuyerRunLock {
  release(): void;
}

export function acquireBuyerRunLock(path: string): BuyerRunLock {
  mkdirSync(dirname(path), { recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `buyer run lock exists at ${path}; refusing a concurrent or unresolved execution`,
        { cause: error },
      );
    throw error;
  }
  const token = randomUUID();
  try {
    writeFileSync(
      descriptor,
      JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }),
    );
  } catch (error) {
    closeSync(descriptor);
    if (existsSync(path)) unlinkSync(path);
    throw error;
  }
  closeSync(descriptor);
  return {
    release() {
      try {
        const content = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
        if (content.token === token) unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new Error("could not safely release buyer run lock", { cause: error });
      }
    },
  };
}
