import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { AudioAttachment, ReplyPayload } from "./types.ts";

const MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
};

export function extractMediaReference(
  text: string,
  logger: { warn(msg: string): void },
): { cleanedText: string; audio: AudioAttachment | undefined } {
  const pattern = /MEDIA:(\/[^\s]+)/g;
  const match = pattern.exec(text);
  if (!match) return { cleanedText: text, audio: undefined };

  const audio = readFileAsAudio(match[1], logger);
  const cleanedText = text.replace(/MEDIA:(\/[^\s]+)/g, "").trim();
  return { cleanedText, audio };
}

export function extractAudioFromPayload(
  payload: ReplyPayload,
  logger: { warn(msg: string): void },
): { text: string; audio: AudioAttachment | undefined } {
  let audio: AudioAttachment | undefined;

  if (Array.isArray(payload.mediaUrls)) {
    for (const url of payload.mediaUrls) {
      if (typeof url === "string" && url.length > 0) {
        audio = readFileAsAudio(url, logger);
        if (audio) break;
      }
    }
  }

  if (!audio && payload.mediaUrl && typeof payload.mediaUrl === "string") {
    audio = readFileAsAudio(payload.mediaUrl, logger);
  }

  let text = payload.text ?? "";

  if (!audio && text) {
    const result = extractMediaReference(text, logger);
    text = result.cleanedText;
    audio = result.audio;
  }

  return { text, audio };
}

function mimeTypeFromExtension(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "audio/mpeg";
}

function readFileAsAudio(
  filePath: string,
  logger: { warn(msg: string): void },
): AudioAttachment | undefined {
  try {
    const buf = readFileSync(filePath);
    return {
      data: buf.toString("base64"),
      mimeType: mimeTypeFromExtension(filePath),
    };
  } catch (err) {
    logger.warn(`[multibot] failed to read media file ${filePath}: ${err}`);
    return undefined;
  }
}
