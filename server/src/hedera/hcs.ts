// HCS audit log: one JSON message per settled job / payout on HEDERA_HCS_TOPIC_ID.
import { TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { env } from "../config.js";
import { UpstreamError, withTimeout } from "../errors.js";
import { log } from "../log.js";
import { hedera } from "./client.js";

export interface JobMessage {
  v: 1;
  type: "job";
  agent: string;
  job: string;
  units: number;
  amount: string;
  asset: string;
  payer: string;
  tx: string;
  zg_request_id: string | null;
  zg_provider: string | null;
  ts: string;
}

/** Submit a message and return its topic sequence number. */
export async function submitHcs(msg: JobMessage): Promise<bigint> {
  const body = JSON.stringify(msg);
  if (Buffer.byteLength(body) > 1024) throw new UpstreamError("hedera", "HCS message over 1 KB");
  const receipt = await withTimeout(
    "hedera",
    "HCS submit",
    30_000,
    (async () => {
      const resp = await new TopicMessageSubmitTransaction()
        .setTopicId(TopicId.fromString(env.HEDERA_HCS_TOPIC_ID))
        .setMessage(body)
        .execute(hedera);
      return resp.getReceipt(hedera);
    })(),
  );
  const seq = receipt.topicSequenceNumber;
  if (seq === null) throw new UpstreamError("hedera", "HCS receipt without sequence number");
  log("hedera", "HCS message", {
    topic: env.HEDERA_HCS_TOPIC_ID,
    seq: seq.toString(),
    job: msg.job,
  });
  return BigInt(seq.toString());
}
