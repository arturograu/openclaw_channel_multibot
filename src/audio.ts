import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { extname, resolve } from "node:path";
import type { AudioAttachment, ReplyPayload } from "./types";

const MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
};

const ALLOWED_EXTENSIONS = new Set(Object.keys(MIME_TYPES));

const MAX_AUDIO_SIZE = 3.5 * 1024 * 1024; // 3.5 MB (stays under 5 MB relay limit after base64 + JSON overhead)

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
  const resolved = resolve(filePath);

  // Block path traversal — check both raw input and resolved path
  if (filePath.includes("..") || resolved.includes("..")) {
    logger.warn("[askred] blocked path traversal attempt");
    return undefined;
  }

  // Only allow known audio extensions
  const ext = extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    logger.warn(`[askred] blocked non-audio file extension: ${ext}`);
    return undefined;
  }

  // Open with O_NOFOLLOW to atomically reject symlinks (no TOCTOU race).
  // Then fstat the same fd to check size before reading.
  let fd: number;
  try {
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ELOOP") || msg.includes("SYMLINK")) {
      logger.warn("[askred] blocked symlink media path");
    } else {
      logger.warn(`[askred] failed to open media file: ${msg}`);
    }
    return undefined;
  }

  try {
    const stat = fstatSync(fd);
    if (stat.size > MAX_AUDIO_SIZE) {
      logger.warn(`[askred] blocked oversized file (${stat.size} bytes)`);
      return undefined;
    }

    const buf = readFileSync(fd);
    return {
      data: buf.toString("base64"),
      mimeType: mimeTypeFromExtension(filePath),
    };
  } catch (err) {
    logger.warn(`[askred] failed to read media file: ${String(err)}`);
    return undefined;
  } finally {
    closeSync(fd);
  }
}
