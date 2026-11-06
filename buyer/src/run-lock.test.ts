import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireBuyerRunLock } from "./run-lock.js";

let directory = "";

afterEach(() => {
  if (directory) {
    if (existsSync(join(directory, "run.lock"))) unlinkSync(join(directory, "run.lock"));
    rmdirSync(directory);
  }
  directory = "";
});

describe("buyer execution lock", () => {
  it("rejects duplicate execution and releases only its own lock", () => {
    directory = mkdtempSync(join(tmpdir(), "nightshift-buyer-lock-"));
    const path = join(directory, "run.lock");
    const lock = acquireBuyerRunLock(path);
    expect(() => acquireBuyerRunLock(path)).toThrow(/lock exists/);
    lock.release();
    expect(() => acquireBuyerRunLock(path)).not.toThrow();
  });
});
