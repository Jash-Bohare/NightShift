// Skill registry: id -> {model, unit, measure, execute}. MVP ships transcribe:* only (docs/04).
import type { SkillId } from "@nightshift/shared";
import { env } from "../config.js";
import { audioMinutes } from "../pricing.js";
import { transcribe, type ZgResult } from "../zg/router.js";
import { AUDIO_MIME, audioDurationSeconds } from "./audio.js";

/** Parsed job input, produced by runPrecheck from the multipart upload. */
export interface AudioInput {
  kind: "audio";
  buf: Buffer;
  mime: string;
  filename: string;
}
export type SkillInput = AudioInput;

export interface Measured {
  /** Billable units for the buyer (USDC price × units). */
  units: number;
  /** Units the 0G model bills (Whisper: seconds of audio), for the budget estimate. */
  meterUnits: bigint;
}

export interface Skill {
  id: SkillId;
  model: string;
  unit: "minute";
  /** 0G meter units in one billed unit (Whisper bills seconds, buyers pay per minute). */
  meterPerUnit: bigint;
  /** Validate and measure the input locally. Throws a message on bad input. */
  measure(input: SkillInput): Promise<Measured>;
  execute(args: { key: string; model: string; input: SkillInput }): Promise<ZgResult>;
}

function transcribeSkill(id: SkillId, language: string): Skill {
  return {
    id,
    model: env.ZG_WHISPER_MODEL,
    unit: "minute",
    meterPerUnit: 60n,
    async measure(input) {
      if (!(AUDIO_MIME as readonly string[]).includes(input.mime))
        throw new Error(`unsupported audio type ${input.mime}`);
      const seconds = await audioDurationSeconds(input.buf, input.mime);
      // Router bills Whisper per started second: the 95.1 s sample billed 96 input tokens.
      return { units: audioMinutes(seconds), meterUnits: BigInt(Math.ceil(seconds)) };
    },
    execute: ({ key, model, input }) =>
      transcribe({
        key,
        model,
        audio: input.buf,
        filename: input.filename,
        mime: input.mime,
        language,
      }),
  };
}

export const skills: Record<SkillId, Skill> = {
  "transcribe:ta": transcribeSkill("transcribe:ta", "ta"),
  "transcribe:hi": transcribeSkill("transcribe:hi", "hi"),
  "transcribe:en": transcribeSkill("transcribe:en", "en"),
};

export function getSkill(id: string): Skill | undefined {
  return (skills as Record<string, Skill>)[id];
}
