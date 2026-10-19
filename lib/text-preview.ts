import fs from "fs";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";

export interface TextPreviewChunk {
  content: string;
  nextOffset: number;
  truncated: boolean;
}

function utf8SequenceLength(byte: number): number {
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

export function readTextPreviewChunk(
  filePath: string,
  fileSize: number,
  offset: number,
): TextPreviewChunk {
  const length = Math.min(TEXT_PREVIEW_MAX_BYTES + 1, fileSize - offset);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, "r");
  let bytesRead: number;
  try {
    bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
  } finally {
    fs.closeSync(descriptor);
  }

  return chunkFromBuffer(buffer, bytesRead, fileSize, offset);
}

/**
 * Build a preview chunk from bytes already fetched for `[offset, fileSize)`.
 *
 * Split out of `readTextPreviewChunk` so a device file — whose bytes arrive
 * over the gateway instead of from `fs.readSync` — produces a byte-identical
 * chunk, including the UTF-8 sequence boundary trim that keeps a multi-byte
 * character from being cut in half.
 */
export function chunkFromBuffer(
  buffer: Buffer,
  bytesRead: number,
  fileSize: number,
  offset: number,
): TextPreviewChunk {
  let end = Math.min(bytesRead, TEXT_PREVIEW_MAX_BYTES);
  if (offset + end < fileSize) {
    let sequenceStart = end;
    while (sequenceStart > end - 3 && (buffer[sequenceStart] & 0xc0) === 0x80) {
      sequenceStart--;
    }
    if (utf8SequenceLength(buffer[sequenceStart]) > end - sequenceStart) {
      end = sequenceStart;
    }
  }
  const nextOffset = offset + end;

  return {
    content: buffer.toString("utf8", 0, end),
    nextOffset,
    truncated: nextOffset < fileSize,
  };
}
