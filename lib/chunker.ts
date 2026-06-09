import {
  MAX_CHUNK_BYTES,
  MAX_SOURCE_BYTES,
  MIME_BY_EXTENSION,
  SUPPORTED_EXTENSIONS,
  VIDEO_EXTENSIONS,
  WARN_SOURCE_BYTES,
} from './constants';
import { createLogger } from './logger';
import type { FileChunk, VideoPrepMode } from './types';
import { compressVideo, splitVideo, type VideoPrepProgress } from './video/ffmpeg';

const log = createLogger('chunker');

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

export function isVideoFile(filename: string): boolean {
  return VIDEO_EXTENSIONS.has(getExtension(filename));
}

export function needsVideoPrep(file: File): boolean {
  return isVideoFile(file.name) && file.size > MAX_CHUNK_BYTES;
}

/** Return a user-facing error, or null if the file can proceed. */
export function getFileValidationError(file: File): string | null {
  const ext = getExtension(file.name);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return `Unsupported file type "${ext || '(none)'}". Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`;
  }
  if (file.size > MAX_SOURCE_BYTES) {
    const sizeGb = (file.size / (1024 * 1024 * 1024)).toFixed(1);
    return `File is ${sizeGb} GB. Maximum supported size is 2 GB (browser memory limit).`;
  }
  return null;
}

export function getFileValidationWarning(file: File): string | null {
  if (file.size > WARN_SOURCE_BYTES && file.size <= MAX_SOURCE_BYTES) {
    const sizeGb = (file.size / (1024 * 1024 * 1024)).toFixed(1);
    return `Large file (${sizeGb} GB). Processing may be slow and use significant memory.`;
  }
  return null;
}

export function validateFile(file: File): void {
  const error = getFileValidationError(file);
  if (error) throw new Error(error);
}

export function resolveMimeType(filename: string): string {
  const ext = getExtension(filename);
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/**
 * Byte-split documents (PDF/TXT/MD) only. Never byte-split video.
 */
export function chunkDocument(file: File): FileChunk[] {
  validateFile(file);
  if (isVideoFile(file.name)) {
    throw new Error('Use prepareFileChunks for video files');
  }

  if (file.size <= MAX_CHUNK_BYTES) {
    return [
      {
        index: 0,
        blob: file,
        filename: file.name,
        size: file.size,
      },
    ];
  }

  const ext = getExtension(file.name);
  const baseName = ext ? file.name.slice(0, -ext.length) : file.name;
  const chunks: FileChunk[] = [];
  let offset = 0;
  let part = 1;

  while (offset < file.size) {
    const end = Math.min(offset + MAX_CHUNK_BYTES, file.size);
    const blob = file.slice(offset, end);
    chunks.push({
      index: part - 1,
      blob,
      filename: `${baseName}_Part${part}${ext}`,
      size: end - offset,
    });
    offset = end;
    part++;
  }

  return chunks;
}

export function chunkFile(file: File): FileChunk[] {
  if (isVideoFile(file.name)) {
    if (file.size <= MAX_CHUNK_BYTES) {
      return [
        {
          index: 0,
          blob: file,
          filename: file.name,
          size: file.size,
        },
      ];
    }
    throw new Error('Oversized video requires preparation (compress or split)');
  }
  return chunkDocument(file);
}

export async function prepareFileChunks(
  file: File,
  videoPrepMode: VideoPrepMode | undefined,
  onPrepProgress: (p: VideoPrepProgress) => void,
  signal?: AbortSignal,
): Promise<FileChunk[]> {
  validateFile(file);

  if (!isVideoFile(file.name) || file.size <= MAX_CHUNK_BYTES) {
    return chunkFile(file);
  }

  if (!videoPrepMode) {
    throw new Error('Video preparation mode required for files over 200 MB');
  }

  log.info('Starting video prep', {
    mode: videoPrepMode,
    name: file.name,
    sizeMb: (file.size / (1024 * 1024)).toFixed(1),
  });

  if (videoPrepMode === 'compress') {
    const part = await compressVideo(file, onPrepProgress, signal);
    return [
      {
        index: 0,
        blob: part.blob,
        filename: part.filename,
        size: part.blob.size,
      },
    ];
  }

  const parts = await splitVideo(file, onPrepProgress, signal);
  return parts.map((part, index) => ({
    index,
    blob: part.blob,
    filename: part.filename,
    size: part.blob.size,
  }));
}
