// Measure audio duration locally (no 0G call) so units can be checked before payment.
import { parseBuffer } from "music-metadata";

export const AUDIO_MIME = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
] as const;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Duration in seconds; throws if the file is not decodable audio. */
export async function audioDurationSeconds(buf: Buffer, mime: string): Promise<number> {
  const meta = await parseBuffer(
    new Uint8Array(buf),
    { mimeType: mime, size: buf.length },
    { duration: true, skipCovers: true },
  );
  const d = meta.format.duration;
  if (d === undefined || !Number.isFinite(d) || d <= 0)
    throw new Error("could not determine audio duration");
  return d;
}
