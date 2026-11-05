// GET /directory (search) and GET /directory/:name (one agent), served from the indexer's cache.
import { Router } from "express";
import { env } from "../config.js";
import { db } from "../db/client.js";
import { ApiError, UpstreamError } from "../errors.js";
import {
  DirectoryQuery,
  labelFromIdentifier,
  queryDirectory,
  toDirectoryAgent,
  type DirectoryRow,
} from "./directoryLogic.js";

export const directoryRouter = Router();

directoryRouter.get("/directory", async (req, res) => {
  const q = DirectoryQuery.safeParse(req.query);
  if (!q.success)
    throw new ApiError(422, "invalid_input", "invalid directory query", q.error.issues);
  const r = await db.from("directory").select("*");
  if (r.error) throw new UpstreamError("db", `directory: ${r.error.message}`);
  const agents = (r.data as DirectoryRow[]).map((row) =>
    toDirectoryAgent(row, env.HEDERA_USDC_TOKEN_ID),
  );
  res.json(queryDirectory(agents, q.data));
});

directoryRouter.get("/directory/:name", async (req, res) => {
  const label = labelFromIdentifier(String(req.params.name));
  if (!label)
    throw new ApiError(422, "invalid_label", "expected <label> or <label>.nightshift.eth");
  const r = await db.from("directory").select("*").eq("label", label).maybeSingle();
  if (r.error) throw new UpstreamError("db", `directory ${label}: ${r.error.message}`);
  if (!r.data) throw new ApiError(404, "not_found", `no agent ${label} in the directory`);
  res.json(toDirectoryAgent(r.data as DirectoryRow, env.HEDERA_USDC_TOKEN_ID));
});
