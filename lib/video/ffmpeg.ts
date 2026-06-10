// import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
// import ffmpegWorkerUrl from '@ffmpeg/ffmpeg/worker?url';
// import { fetchFile, toBlobURL } from '@ffmpeg/util';

// import { MAX_CHUNK_BYTES, TARGET_CHUNK_BYTES, TARGET_SPLIT_BYTES } from '../constants';
// import { createLogger, previewText } from '../logger';

// const log = createLogger('ffmpeg');

// function elapsedSec(startMs: number): number {
//   return Math.round((Date.now() - startMs) / 1000);
// }

// /** Periodic info logs so long FFmpeg runs don't look frozen. */
// function startHeartbeat(
//   label: string,
//   getContext?: () => Record<string, unknown>,
//   intervalMs = 15_000,
// ): () => void {
//   const startMs = Date.now();
//   const id = setInterval(() => {
//     log.info(`${label} still running`, {
//       elapsedSec: elapsedSec(startMs),
//       ...getContext?.(),
//     });
//   }, intervalMs);
//   return () => clearInterval(id);
// }

// function attachFfmpegLogHandlers(ffmpeg: FFmpeg): void {
//   ffmpeg.on('log', ({ type, message }) => {
//     const text = previewText(message, 300);
//     if (/error|failed|invalid/i.test(text)) {
//       log.warn('FFmpeg worker', { type, message: text });
//     } else {
//       log.debug('FFmpeg worker', { type, message: text });
//     }
//   });
// }

// export interface VideoProbe {
//   durationSec: number;
//   bitrateBps: number;
//   width: number;
//   height: number;
// }

// export interface VideoPrepProgress {
//   phase: 'loading' | 'probing' | 'processing';
//   message: string;
//   percent: number;
//   part?: number;
//   totalParts?: number;
// }

// export interface PreparedVideoPart {
//   blob: Blob;
//   filename: string;
// }

// let ffmpegInstance: FFmpeg | null = null;
// let loadPromise: Promise<FFmpeg> | null = null;

// function getExtension(filename: string): string {
//   const dot = filename.lastIndexOf('.');
//   return dot >= 0 ? filename.slice(dot).toLowerCase() : '.mp4';
// }

// function baseName(filename: string): string {
//   const ext = getExtension(filename);
//   return ext ? filename.slice(0, -ext.length) : filename;
// }

// function checkAborted(signal?: AbortSignal): void {
//   if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
// }

// async function getFfmpeg(
//   onProgress?: (p: VideoPrepProgress) => void,
//   signal?: AbortSignal,
// ): Promise<FFmpeg> {
//   if (ffmpegInstance?.loaded) return ffmpegInstance;
//   if (loadPromise) return loadPromise;

//   loadPromise = (async () => {
//     onProgress?.({
//       phase: 'loading',
//       message: 'Loading FFmpeg (first time only)…',
//       percent: 0,
//     });
//     checkAborted(signal);

//     const ffmpeg = new FFmpeg();
//     const coreBase = typeof chrome !== 'undefined' ? chrome.runtime.getURL('/ffmpeg') : '/ffmpeg';
//     attachFfmpegLogHandlers(ffmpeg);

//     ffmpeg.on('progress', ({ progress }) => {
//       const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
//       onProgress?.({
//         phase: 'processing',
//         message: `Encoding… ${pct}%`,
//         percent: Math.max(5, pct),
//       });
//     });

//     try {
//       log.info('Loading FFmpeg WASM', { coreBase, workerUrl: ffmpegWorkerUrl });
//       await ffmpeg.load({
//         classWorkerURL: ffmpegWorkerUrl,
//         coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, 'text/javascript'),
//         wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm'),
//       });
//       log.info('FFmpeg loaded');
//     } catch (err) {
//       loadPromise = null;
//       log.error('FFmpeg load failed', err, { coreBase });
//       throw new Error(
//         `FFmpeg failed to load. Run "npm install" in the project folder to restore public/ffmpeg/, then reload the extension. ` +
//           `(${err instanceof Error ? err.message : String(err)})`,
//       );
//     }

//     ffmpegInstance = ffmpeg;
//     return ffmpeg;
//   })();

//   return loadPromise;
// }

// /** Probe duration/bitrate via HTML video metadata (fast, no FFmpeg needed). */
// export async function probeVideo(
//   file: File,
//   signal?: AbortSignal,
// ): Promise<VideoProbe> {
//   checkAborted(signal);
//   const url = URL.createObjectURL(file);
//   try {
//     const video = document.createElement('video');
//     video.preload = 'metadata';
//     video.src = url;

//     await new Promise<void>((resolve, reject) => {
//       video.onloadedmetadata = () => resolve();
//       video.onerror = () => reject(new Error('Could not read video metadata'));
//     });

//     checkAborted(signal);

//     const durationSec = video.duration;
//     if (!Number.isFinite(durationSec) || durationSec <= 0) {
//       throw new Error('Invalid video duration');
//     }

//     const bitrateBps = (file.size * 8) / durationSec;
//     return {
//       durationSec,
//       bitrateBps,
//       width: video.videoWidth,
//       height: video.videoHeight,
//     };
//   } finally {
//     URL.revokeObjectURL(url);
//   }
// }

// function segmentDurationSec(
//   probe: VideoProbe,
//   targetBytes: number = TARGET_SPLIT_BYTES,
// ): number {
//   // Stream copy cuts on keyframes — use a safety margin below the byte target.
//   const targetBits = targetBytes * 8 * 0.8;
//   const sec = targetBits / probe.bitrateBps;
//   return Math.max(30, Math.min(sec, probe.durationSec));
// }

// interface MountedInput {
//   inputPath: string;
//   cleanup: () => Promise<void>;
//   mounted: boolean;
// }

// /** Prefer WORKERFS so the browser does not copy the whole file into WASM memory. */
// async function mountInputFile(
//   ffmpeg: FFmpeg,
//   file: File,
//   onProgress?: (p: VideoPrepProgress) => void,
// ): Promise<MountedInput> {
//   const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
//   const mountPoint = '/input';

//   try {
//     onProgress?.({
//       phase: 'processing',
//       message: `Mounting ${sizeMb} MB video (no full copy)…`,
//       percent: 4,
//     });
//     await ffmpeg.createDir(mountPoint).catch(() => undefined);
//     await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, mountPoint);
//     const inputPath = `${mountPoint}/${file.name}`;
//     log.info('Video mounted via WORKERFS', { inputPath, sizeMb });
//     return {
//       inputPath,
//       mounted: true,
//       cleanup: async () => {
//         await ffmpeg.unmount(mountPoint).catch(() => undefined);
//       },
//     };
//   } catch (err) {
//     log.warn('WORKERFS mount failed — falling back to memory copy', err, { sizeMb });
//     const inputName = 'input' + getExtension(file.name);
//     await writeInput(ffmpeg, file, onProgress);
//     return {
//       inputPath: inputName,
//       mounted: false,
//       cleanup: async () => {
//         await ffmpeg.deleteFile(inputName).catch(() => undefined);
//       },
//     };
//   }
// }

// async function listSegmentOutputs(
//   ffmpeg: FFmpeg,
//   prefix: string,
// ): Promise<string[]> {
//   const nodes = await ffmpeg.listDir('/');
//   return nodes
//     .filter((n) => !n.isDir && n.name.startsWith(prefix) && n.name.endsWith('.mp4'))
//     .map((n) => n.name)
//     .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
// }

// /** Re-split one oversized segment with stream copy (fast). */
// async function resplitOversizeBlob(
//   ffmpeg: FFmpeg,
//   blob: Blob,
//   segDurSec: number,
//   tag: string,
// ): Promise<Blob[]> {
//   const tempName = `oversize_${tag}.mp4`;
//   const outPrefix = `sub_${tag}_`;
//   const bytes = new Uint8Array(await blob.arrayBuffer());
//   await ffmpeg.writeFile(tempName, bytes);

//   const shorterSec = Math.max(20, Math.floor(segDurSec * 0.45));
//   log.info('Re-splitting oversized segment', {
//     tag,
//     inputMb: (blob.size / (1024 * 1024)).toFixed(1),
//     shorterSec,
//   });

//   await ffmpeg.exec([
//     '-i',
//     tempName,
//     '-map',
//     '0',
//     '-c',
//     'copy',
//     '-f',
//     'segment',
//     '-segment_time',
//     String(shorterSec),
//     '-reset_timestamps',
//     '1',
//     '-y',
//     `${outPrefix}%03d.mp4`,
//   ]);

//   await ffmpeg.deleteFile(tempName).catch(() => undefined);
//   const names = await listSegmentOutputs(ffmpeg, outPrefix);
//   const out: Blob[] = [];
//   for (const name of names) {
//     out.push(await readOutputBlob(ffmpeg, name));
//     await ffmpeg.deleteFile(name).catch(() => undefined);
//   }
//   return out;
// }

// async function readOutputBlob(ffmpeg: FFmpeg, path: string): Promise<Blob> {
//   const data = await ffmpeg.readFile(path);
//   const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
//   return new Blob([bytes], { type: 'video/mp4' });
// }

// async function writeInput(
//   ffmpeg: FFmpeg,
//   file: File,
//   onProgress?: (p: VideoPrepProgress) => void,
// ): Promise<string> {
//   const inputName = 'input' + getExtension(file.name);
//   const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
//   log.info('Loading video into FFmpeg', { name: file.name, sizeMb });
//   onProgress?.({
//     phase: 'processing',
//     message: `Loading ${sizeMb} MB into FFmpeg (may take a few minutes)…`,
//     percent: 1,
//   });

//   const readStart = Date.now();
//   const data = await fetchFile(file);
//   log.info('Video read into memory', { sizeMb, elapsedSec: elapsedSec(readStart) });

//   onProgress?.({
//     phase: 'processing',
//     message: 'Writing to FFmpeg filesystem…',
//     percent: 3,
//   });
//   const writeStart = Date.now();
//   await ffmpeg.writeFile(inputName, data);
//   log.info('Video written to FFmpeg FS', { inputName, elapsedSec: elapsedSec(writeStart) });
//   return inputName;
// }

// // video/ffmpeg.ts — optimized compressVideo: skip if stream-copy split is enough
// export async function compressVideo(
//   file: File,
//   onProgress?: (p: VideoPrepProgress) => void,
//   signal?: AbortSignal,
// ): Promise<PreparedVideoPart> {
//   // Fast path: if bitrate is low enough, stream-copy transcode to mp4 container only
//   const probe = await probeVideo(file, signal);
//   const estimatedOutputSize = probe.bitrateBps * probe.durationSec / 8;

//   // If estimated output is already under limit with just a container remux, do that
//   if (estimatedOutputSize <= MAX_CHUNK_BYTES * 0.9) {
//     const ffmpeg = await getFfmpeg(onProgress, signal);
//     const { inputPath, cleanup } = await mountInputFile(ffmpeg, file, onProgress);
//     try {
//       onProgress?.({ phase: 'processing', message: 'Remuxing (no re-encode)…', percent: 10 });
//       await ffmpeg.exec([
//         '-i', inputPath,
//         '-c', 'copy',   // stream copy = seconds not minutes
//         '-movflags', '+faststart',
//         '-y', 'output.mp4',
//       ]);
//       const blob = await readOutputBlob(ffmpeg, 'output.mp4');
//       await ffmpeg.deleteFile('output.mp4').catch(() => undefined);
//       if (blob.size <= MAX_CHUNK_BYTES) {
//         return { blob, filename: `${baseName(file.name)}_compressed.mp4` };
//       }
//       // Fall through to re-encode if remux wasn't enough
//     } finally {
//       await cleanup();
//     }
//   }

//   // True re-encode (slow, last resort) — keep your existing logic here
//   // but start at crf:32 + 720p immediately to minimize attempts
//   return compressVideoReencode(file, onProgress, signal, probe);
// }

// async function extractSegment(
//   ffmpeg: FFmpeg,
//   inputName: string,
//   startSec: number,
//   durationSec: number,
//   outputName: string,
//   reencode: boolean,
//   probe: VideoProbe,
// ): Promise<Blob> {
//   const args = ['-ss', String(startSec), '-i', inputName, '-t', String(durationSec)];

//   if (reencode) {
//     const scale =
//       probe.width > 1280 ? "scale='min(1280,iw)':-2" : 'scale=iw:ih';
//     args.push(
//       '-vf',
//       scale,
//       '-c:v',
//       'libx264',
//       '-crf',
//       '28',
//       '-preset',
//       'ultrafast',
//       '-c:a',
//       'aac',
//       '-b:a',
//       '96k',
//     );
//   } else {
//     args.push('-c', 'copy');
//   }

//   args.push('-movflags', '+faststart', '-y', outputName);
//   await ffmpeg.exec(args);
//   return readOutputBlob(ffmpeg, outputName);
// }

// /** Last resort: re-encode one segment blob that is still over the size limit. */
// async function reencodeBlobPart(
//   ffmpeg: FFmpeg,
//   blob: Blob,
//   probe: VideoProbe,
//   tag: string,
// ): Promise<Blob> {
//   const tempName = `reenc_in_${tag}.mp4`;
//   const outputName = `reenc_out_${tag}.mp4`;
//   await ffmpeg.writeFile(tempName, new Uint8Array(await blob.arrayBuffer()));
//   const scale =
//     probe.width > 1280 ? "scale='min(1280,iw)':-2" : 'scale=iw:ih';
//   await ffmpeg.exec([
//     '-i',
//     tempName,
//     '-vf',
//     scale,
//     '-c:v',
//     'libx264',
//     '-crf',
//     '30',
//     '-preset',
//     'ultrafast',
//     '-c:a',
//     'aac',
//     '-b:a',
//     '96k',
//     '-movflags',
//     '+faststart',
//     '-y',
//     outputName,
//   ]);
//   const out = await readOutputBlob(ffmpeg, outputName);
//   await ffmpeg.deleteFile(tempName).catch(() => undefined);
//   await ffmpeg.deleteFile(outputName).catch(() => undefined);
//   return out;
// }

// // video/ffmpeg.ts — optimized splitVideo: one-pass, stream copy only, no re-encode fallback unless forced

// export async function splitVideo(
//   file: File,
//   onProgress?: (p: VideoPrepProgress) => void,
//   signal?: AbortSignal,
// ): Promise<PreparedVideoPart[]> {
//   const ffmpeg = await getFfmpeg(onProgress, signal);
//   checkAborted(signal);

//   onProgress?.({ phase: 'probing', message: 'Analyzing video…', percent: 2 });
//   const probe = await probeVideo(file, signal); // fast, no FFmpeg needed

//   // If file already fits, return immediately — no FFmpeg at all
//   if (file.size <= MAX_CHUNK_BYTES) {
//     return [{ blob: file, filename: file.name }];
//   }

//   const segDur = segmentDurationSec(probe); // uses TARGET_SPLIT_BYTES
//   const { inputPath, cleanup, mounted } = await mountInputFile(ffmpeg, file, onProgress);

//   try {
//     const segPrefix = 'seg_';
//     const stem = baseName(file.name);
//     const outExt = '.mp4';

//     onProgress?.({
//       phase: 'processing',
//       message: `Splitting (stream copy, no re-encode)…`,
//       percent: 8,
//     });

//     // Single FFmpeg pass — stream copy is near-instant vs encoding
//     await ffmpeg.exec([
//       '-i', inputPath,
//       '-map', '0',
//       '-c', 'copy',           // ← stream copy: 50-100x faster than libx264
//       '-f', 'segment',
//       '-segment_time', String(Math.floor(segDur)),
//       '-reset_timestamps', '1',
//       '-avoid_negative_ts', 'make_zero',  // prevents A/V sync issues
//       '-y',
//       `${segPrefix}%03d.mp4`,
//     ]);

//     const segNames = await listSegmentOutputs(ffmpeg, segPrefix);
//     if (!segNames.length) throw new Error('No segments produced');

//     const parts: PreparedVideoPart[] = [];

//     for (let i = 0; i < segNames.length; i++) {
//       checkAborted(signal);
//       onProgress?.({
//         phase: 'processing',
//         message: `Reading part ${i + 1}/${segNames.length}…`,
//         percent: Math.round(15 + (i / segNames.length) * 80),
//         part: i + 1,
//         totalParts: segNames.length,
//       });

//       const blob = await readOutputBlob(ffmpeg, segNames[i]);
//       await ffmpeg.deleteFile(segNames[i]).catch(() => undefined);

//       // Only re-encode if stream copy still overshoots (rare with tuned segDur)
//       if (blob.size > MAX_CHUNK_BYTES) {
//         // Halve segment time and re-split instead of re-encoding
//         // This stays in stream-copy territory
//         const subBlobs = await resplitOversizeBlob(ffmpeg, blob, segDur, String(i));
//         subBlobs.forEach((b, j) =>
//           parts.push({ blob: b, filename: `${stem}_Part${parts.length + 1}${outExt}` })
//         );
//       } else {
//         parts.push({ blob, filename: `${stem}_Part${parts.length + 1}${outExt}` });
//       }
//     }

//     return parts;
//   } finally {
//     await cleanup();
//   }
// }

// export function terminateFfmpeg(): void {
//   if (ffmpegInstance) {
//     void ffmpegInstance.terminate();
//     ffmpegInstance = null;
//     loadPromise = null;
//   }
// }



import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import ffmpegWorkerUrl from '@ffmpeg/ffmpeg/worker?url';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

import { MAX_CHUNK_BYTES, TARGET_CHUNK_BYTES, TARGET_SPLIT_BYTES } from '../constants';
import { createLogger, previewText } from '../logger';

const log = createLogger('ffmpeg');

function elapsedSec(startMs: number): number {
  return Math.round((Date.now() - startMs) / 1000);
}

/** FFmpeg WASM may return Uint8Array<ArrayBufferLike>; Blob/File need ArrayBuffer-backed parts. */
function ffmpegDataToBlobPart(data: Uint8Array | string): BlobPart {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}

function ffmpegReadFileToBlob(data: Uint8Array | string, type = 'video/mp4'): Blob {
  return new Blob([ffmpegDataToBlobPart(data)], { type });
}

function ffmpegReadFileToFile(data: Uint8Array | string, name: string, type = 'video/mp4'): File {
  return new File([ffmpegDataToBlobPart(data)], name, { type });
}

/** Periodic info logs so long FFmpeg runs don't look frozen. */
function startHeartbeat(
  label: string,
  getContext?: () => Record<string, unknown>,
  intervalMs = 15_000,
): () => void {
  const startMs = Date.now();
  const id = setInterval(() => {
    log.info(`${label} still running`, {
      elapsedSec: elapsedSec(startMs),
      ...getContext?.(),
    });
  }, intervalMs);
  return () => clearInterval(id);
}

function attachFfmpegLogHandlers(ffmpeg: FFmpeg): void {
  ffmpeg.on('log', ({ type, message }) => {
    const text = previewText(message, 300);
    if (/error|failed|invalid/i.test(text)) {
      log.warn('FFmpeg worker', { type, message: text });
    } else {
      log.debug('FFmpeg worker', { type, message: text });
    }
  });
}

export interface VideoProbe {
  durationSec: number;
  bitrateBps: number;
  width: number;
  height: number;
}

export interface VideoPrepProgress {
  phase: 'loading' | 'probing' | 'processing';
  message: string;
  percent: number;
  part?: number;
  totalParts?: number;
}

export interface PreparedVideoPart {
  blob: Blob;
  filename: string;
}

// ─── MP4 atom / box parser ────────────────────────────────────────────────────

interface Atom {
  type: string;
  offset: number;   // byte offset inside the scanned buffer
  size: number;     // total box size in bytes (header + payload)
}

/**
 * Parse the top-level ISO-BMFF / MP4 atoms from an ArrayBuffer.
 * Only reads the 8-byte header of each box — never copies payload bytes.
 */
function parseTopLevelAtoms(buffer: ArrayBuffer): Atom[] {
  const view = new DataView(buffer);
  const atoms: Atom[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.byteLength) {
    const size = view.getUint32(offset);           // big-endian 32-bit size
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    );

    if (size < 8) break; // malformed / padding — stop parsing
    atoms.push({ type, offset, size });
    offset += size;
  }

  return atoms;
}

/**
 * Returns true when the MP4 `moov` atom starts within the first MAX_HEADER_SCAN
 * bytes of the file (i.e. the file was written with `+faststart`).
 * We only need to read a small header slice — no full-file read required.
 */
const MAX_HEADER_SCAN = 8 * 1024 * 1024; // 8 MB is always enough to find moov

async function isMoovAtStart(file: File): Promise<boolean> {
  const scanSize = Math.min(file.size, MAX_HEADER_SCAN);
  const buffer = await file.slice(0, scanSize).arrayBuffer();
  const atoms = parseTopLevelAtoms(buffer);
  // moov present AND it started before we ran out of our scan window
  return atoms.some((a) => a.type === 'moov');
}

// ─── FFmpeg singleton ─────────────────────────────────────────────────────────

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
let loadingFfmpeg: FFmpeg | null = null;

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '.mp4';
}

function baseName(filename: string): string {
  const ext = getExtension(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function bindAbortTermination(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  const handler = () => onAbort();
  signal.addEventListener('abort', handler);
  return () => signal.removeEventListener('abort', handler);
}

function killFfmpegInstance(ffmpeg: FFmpeg): void {
  void ffmpeg.terminate();
  if (ffmpegInstance === ffmpeg) ffmpegInstance = null;
  if (loadingFfmpeg === ffmpeg) loadingFfmpeg = null;
  loadPromise = null;
}

async function execWithAbort(
  ffmpeg: FFmpeg,
  args: string[],
  signal?: AbortSignal,
): Promise<void> {
  checkAborted(signal);
  const release = bindAbortTermination(signal, () => {
    log.info('FFmpeg exec cancelled — terminating worker');
    killFfmpegInstance(ffmpeg);
  });
  try {
    await ffmpeg.exec(args);
    checkAborted(signal);
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw err;
  } finally {
    release();
  }
}

async function getFfmpeg(
  onProgress?: (p: VideoPrepProgress) => void,
  signal?: AbortSignal,
): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    onProgress?.({
      phase: 'loading',
      message: 'Loading FFmpeg (~30 MB, first time only — may take 20–40 s)…',
      percent: 1,
    });
    checkAborted(signal);

    const ffmpeg = new FFmpeg();
    loadingFfmpeg = ffmpeg;
    const releaseAbort = bindAbortTermination(signal, () => {
      log.info('FFmpeg load cancelled — terminating worker');
      killFfmpegInstance(ffmpeg);
    });
    const coreBase =
      typeof chrome !== 'undefined' ? chrome.runtime.getURL('/ffmpeg') : '/ffmpeg';
    attachFfmpegLogHandlers(ffmpeg);

    ffmpeg.on('progress', ({ progress }) => {
      const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
      onProgress?.({
        phase: 'processing',
        message: `Encoding… ${pct}%`,
        percent: Math.max(5, pct),
      });
    });

    const loadStart = Date.now();
    const stopHeartbeat = startHeartbeat('FFmpeg WASM load');
    try {
      log.info('Loading FFmpeg WASM', { coreBase, workerUrl: ffmpegWorkerUrl });
      await ffmpeg.load({
        classWorkerURL: ffmpegWorkerUrl,
        coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      log.info('FFmpeg loaded', { elapsedSec: elapsedSec(loadStart) });
      onProgress?.({
        phase: 'loading',
        message: 'FFmpeg ready',
        percent: 4,
      });
    } catch (err) {
      loadPromise = null;
      loadingFfmpeg = null;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      log.error('FFmpeg load failed', err, { coreBase });
      throw new Error(
        `FFmpeg failed to load. Run "npm install" in the project folder to restore public/ffmpeg/, then reload the extension. ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      stopHeartbeat();
      releaseAbort();
      loadingFfmpeg = null;
    }

    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw err;
  }
}

// ─── Video probe ──────────────────────────────────────────────────────────────

/** Probe duration/bitrate via HTML video metadata (fast, no FFmpeg needed). */
export async function probeVideo(file: File, signal?: AbortSignal): Promise<VideoProbe> {
  checkAborted(signal);
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      video.onloadedmetadata = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      video.onerror = () => {
        signal?.removeEventListener('abort', onAbort);
        reject(new Error('Could not read video metadata'));
      };
    });

    checkAborted(signal);

    const durationSec = video.duration;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error('Invalid video duration');
    }

    const bitrateBps = (file.size * 8) / durationSec;
    return { durationSec, bitrateBps, width: video.videoWidth, height: video.videoHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function segmentDurationSec(probe: VideoProbe, targetBytes: number = TARGET_SPLIT_BYTES): number {
  // Stream copy cuts on keyframes — use a safety margin below the byte target.
  const targetBits = targetBytes * 8 * 0.8;
  const sec = targetBits / probe.bitrateBps;
  return Math.max(30, Math.min(sec, probe.durationSec));
}

// ─── FFmpeg filesystem helpers ────────────────────────────────────────────────

interface MountedInput {
  inputPath: string;
  cleanup: () => Promise<void>;
  mounted: boolean;
}

/** Prefer WORKERFS so the browser does not copy the whole file into WASM memory. */
async function mountInputFile(
  ffmpeg: FFmpeg,
  file: File,
  onProgress?: (p: VideoPrepProgress) => void,
  signal?: AbortSignal,
): Promise<MountedInput> {
  checkAborted(signal);
  const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
  const mountPoint = '/input';

  try {
    onProgress?.({
      phase: 'processing',
      message: `Mounting ${sizeMb} MB video (no full copy)…`,
      percent: 4,
    });
    await ffmpeg.createDir(mountPoint).catch(() => undefined);
    await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, mountPoint);
    const inputPath = `${mountPoint}/${file.name}`;
    log.info('Video mounted via WORKERFS', { inputPath, sizeMb });
    return {
      inputPath,
      mounted: true,
      cleanup: async () => {
        await ffmpeg.unmount(mountPoint).catch(() => undefined);
      },
    };
  } catch (err) {
    log.warn('WORKERFS mount failed — falling back to memory copy', err, { sizeMb });
    const inputName = 'input' + getExtension(file.name);
    await writeInput(ffmpeg, file, onProgress, signal);
    return {
      inputPath: inputName,
      mounted: false,
      cleanup: async () => {
        await ffmpeg.deleteFile(inputName).catch(() => undefined);
      },
    };
  }
}

async function listSegmentOutputs(ffmpeg: FFmpeg, prefix: string): Promise<string[]> {
  const nodes = await ffmpeg.listDir('/');
  return nodes
    .filter((n) => !n.isDir && n.name.startsWith(prefix) && n.name.endsWith('.mp4'))
    .map((n) => n.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function readOutputBlob(ffmpeg: FFmpeg, path: string): Promise<Blob> {
  const data = await ffmpeg.readFile(path);
  return ffmpegReadFileToBlob(data instanceof Uint8Array ? data : String(data));
}

async function writeInput(
  ffmpeg: FFmpeg,
  file: File,
  onProgress?: (p: VideoPrepProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  checkAborted(signal);
  const inputName = 'input' + getExtension(file.name);
  const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
  log.info('Loading video into FFmpeg', { name: file.name, sizeMb });
  onProgress?.({
    phase: 'processing',
    message: `Loading ${sizeMb} MB into FFmpeg (may take a few minutes)…`,
    percent: 1,
  });

  const readStart = Date.now();
  const data = await fetchFile(file);
  checkAborted(signal);
  log.info('Video read into memory', { sizeMb, elapsedSec: elapsedSec(readStart) });

  onProgress?.({ phase: 'processing', message: 'Writing to FFmpeg filesystem…', percent: 3 });
  checkAborted(signal);
  const writeStart = Date.now();
  await ffmpeg.writeFile(inputName, data);
  log.info('Video written to FFmpeg FS', { inputName, elapsedSec: elapsedSec(writeStart) });
  return inputName;
}

/** Re-split one oversized segment with stream copy (fast, no re-encode). */
async function resplitOversizeBlob(
  ffmpeg: FFmpeg,
  blob: Blob,
  segDurSec: number,
  tag: string,
  signal?: AbortSignal,
): Promise<Blob[]> {
  checkAborted(signal);
  const tempName = `oversize_${tag}.mp4`;
  const outPrefix = `sub_${tag}_`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await ffmpeg.writeFile(tempName, bytes);

  const shorterSec = Math.max(20, Math.floor(segDurSec * 0.45));
  log.info('Re-splitting oversized segment', {
    tag,
    inputMb: (blob.size / (1024 * 1024)).toFixed(1),
    shorterSec,
  });

  await execWithAbort(
    ffmpeg,
    [
      '-i', tempName,
      '-map', '0',
      '-c', 'copy',
      '-f', 'segment',
      '-segment_time', String(shorterSec),
      '-reset_timestamps', '1',
      '-y',
      `${outPrefix}%03d.mp4`,
    ],
    signal,
  );

  await ffmpeg.deleteFile(tempName).catch(() => undefined);
  const names = await listSegmentOutputs(ffmpeg, outPrefix);
  const out: Blob[] = [];
  for (const name of names) {
    out.push(await readOutputBlob(ffmpeg, name));
    await ffmpeg.deleteFile(name).catch(() => undefined);
  }
  return out;
}

/** Last resort: re-encode one segment blob that is still over the size limit. */
async function reencodeBlobPart(
  ffmpeg: FFmpeg,
  blob: Blob,
  probe: VideoProbe,
  tag: string,
): Promise<Blob> {
  const tempName = `reenc_in_${tag}.mp4`;
  const outputName = `reenc_out_${tag}.mp4`;
  await ffmpeg.writeFile(tempName, new Uint8Array(await blob.arrayBuffer()));
  const scale = probe.width > 1280 ? "scale='min(1280,iw)':-2" : 'scale=iw:ih';
  await ffmpeg.exec([
    '-i', tempName,
    '-vf', scale,
    '-c:v', 'libx264',
    '-crf', '30',
    '-preset', 'ultrafast',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
    '-y', outputName,
  ]);
  const out = await readOutputBlob(ffmpeg, outputName);
  await ffmpeg.deleteFile(tempName).catch(() => undefined);
  await ffmpeg.deleteFile(outputName).catch(() => undefined);
  return out;
}

// ─── FFmpeg stream-copy split ───────────────────────────────────────────────

/**
 * Split using FFmpeg with `-c copy` (stream copy, no re-encode).
 * Much faster than encoding: typically 15–60 s for a 1 GB file vs 15–45 min.
 * Used as fallback when the fast byte-slice path is not applicable.
 */
async function splitVideoStreamCopy(
  file: File,
  probe: VideoProbe,
  onProgress?: (p: VideoPrepProgress) => void,
  signal?: AbortSignal,
): Promise<PreparedVideoPart[]> {
  const ffmpeg = await getFfmpeg(onProgress, signal);
  checkAborted(signal);

  const { inputPath, cleanup, mounted } = await mountInputFile(ffmpeg, file, onProgress, signal);
  const stem = baseName(file.name);
  const segDur = segmentDurationSec(probe);
  const segPrefix = 'seg_';
  const totalStart = Date.now();

  try {
    const partCountEstimate = Math.ceil(probe.durationSec / segDur);
    onProgress?.({
      phase: 'processing',
      message: `Splitting (~${partCountEstimate} parts, stream copy — no re-encode)…`,
      percent: 8,
      totalParts: partCountEstimate,
    });

    const stopHeartbeat = startHeartbeat('split stream-copy', () => ({ segmentSec: Math.round(segDur), mounted }));
    try {
      await execWithAbort(
        ffmpeg,
        [
          '-i', inputPath,
          '-map', '0',
          '-c', 'copy',
          '-f', 'segment',
          '-segment_time', String(Math.max(30, Math.floor(segDur))),
          '-reset_timestamps', '1',
          '-avoid_negative_ts', 'make_zero',
          '-y',
          `${segPrefix}%03d.mp4`,
        ],
        signal,
      );
    } finally {
      stopHeartbeat();
    }

    log.info('stream-copy split done', { elapsedSec: elapsedSec(totalStart) });

    const segNames = await listSegmentOutputs(ffmpeg, segPrefix);
    if (!segNames.length) {
      throw new Error('FFmpeg produced no segments. Try a different video file.');
    }

    const parts: PreparedVideoPart[] = [];

    for (let i = 0; i < segNames.length; i++) {
      checkAborted(signal);
      onProgress?.({
        phase: 'processing',
        message: `Reading part ${i + 1}/${segNames.length}…`,
        percent: Math.round(15 + (i / segNames.length) * 80),
        part: i + 1,
        totalParts: segNames.length,
      });

      let blob = await readOutputBlob(ffmpeg, segNames[i]);
      await ffmpeg.deleteFile(segNames[i]).catch(() => undefined);

      // Over-limit after stream copy? Re-split (still no encode).
      if (blob.size > MAX_CHUNK_BYTES) {
        onProgress?.({
          phase: 'processing',
          message: `Part ${i + 1} oversize — re-splitting (stream copy)…`,
          percent: Math.round(15 + (i / segNames.length) * 80),
          part: i + 1,
          totalParts: segNames.length,
        });
        const subBlobs = await resplitOversizeBlob(ffmpeg, blob, segDur, String(i + 1), signal);
        for (const b of subBlobs) {
          parts.push({ blob: b, filename: `${stem}_Part${parts.length + 1}.mp4` });
        }
        continue;
      }

      parts.push({ blob, filename: `${stem}_Part${parts.length + 1}.mp4` });
    }

    log.info('splitVideoStreamCopy done', {
      partCount: parts.length,
      totalElapsedSec: elapsedSec(totalStart),
    });

    return parts;
  } finally {
    await cleanup();
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Split a video file into parts ≤ MAX_CHUNK_BYTES.
 *
 * Always uses FFmpeg stream-copy segmentation so every part is a valid video file.
 * Raw byte-slicing MP4 produces invalid parts 2+ (missing moov atom).
 */
export async function splitVideo(
  file: File,
  onProgress?: (p: VideoPrepProgress) => void,
  signal?: AbortSignal,
): Promise<PreparedVideoPart[]> {
  const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
  log.info('splitVideo start', { name: file.name, sizeMb });

  if (file.size <= MAX_CHUNK_BYTES) {
    log.info('splitVideo: file fits, returning as-is');
    return [{ blob: file, filename: file.name }];
  }

  onProgress?.({ phase: 'probing', message: 'Analyzing video…', percent: 2 });
  const probe = await probeVideo(file, signal);

  // Stream-copy segment split reads the file sequentially — moov-at-end is fine.
  // (Remuxing a 600+ MB file into memory first was slow and could hang the browser.)
  log.info('splitVideo: FFmpeg stream-copy segment split', { sizeMb });
  return splitVideoStreamCopy(file, probe, onProgress, signal);
}

// ─── compressVideo ────────────────────────────────────────────────────────────

/**
 * Compress a video to fit under MAX_CHUNK_BYTES.
 *
 * Fast path: if the file's own bitrate suggests it already fits after a
 * container remux (stream copy), do that — completes in seconds.
 * Slow path: re-encode with libx264, trying progressively higher CRF / lower
 * resolution until the output fits.
 */
export async function compressVideo(
  file: File,
  onProgress?: (p: VideoPrepProgress) => void,
  signal?: AbortSignal,
): Promise<PreparedVideoPart> {
  const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
  log.info('compressVideo start', { name: file.name, sizeMb });
  const totalStart = Date.now();

  onProgress?.({ phase: 'probing', message: 'Analyzing video…', percent: 2 });
  const probe = await probeVideo(file, signal);

  log.info('Video probed', {
    durationSec: Math.round(probe.durationSec),
    width: probe.width,
    height: probe.height,
    bitrateMbps: (probe.bitrateBps / 1_000_000).toFixed(1),
  });

  // ── Fast path: stream-copy remux might be enough ──────────────────────────
  const estimatedSize = (probe.bitrateBps * probe.durationSec) / 8;
  if (estimatedSize <= MAX_CHUNK_BYTES * 0.9) {
    const ffmpeg = await getFfmpeg(onProgress, signal);
    const { inputPath, cleanup } = await mountInputFile(ffmpeg, file, onProgress, signal);
    try {
      onProgress?.({ phase: 'processing', message: 'Remuxing (no re-encode)…', percent: 10 });
      await execWithAbort(
        ffmpeg,
        ['-i', inputPath, '-c', 'copy', '-movflags', '+faststart', '-y', 'output.mp4'],
        signal,
      );
      const blob = await readOutputBlob(ffmpeg, 'output.mp4');
      await ffmpeg.deleteFile('output.mp4').catch(() => undefined);

      if (blob.size <= MAX_CHUNK_BYTES) {
        log.info('compressVideo: remux succeeded', {
          outputMb: (blob.size / (1024 * 1024)).toFixed(1),
          totalElapsedSec: elapsedSec(totalStart),
        });
        return { blob, filename: `${baseName(file.name)}_compressed.mp4` };
      }
      // Remux wasn't enough — fall through to re-encode
      log.info('compressVideo: remux output still too large, falling back to encode');
    } finally {
      await cleanup();
    }
  }

  // ── Slow path: re-encode with libx264 ────────────────────────────────────
  const ffmpeg = await getFfmpeg(onProgress, signal);
  const { inputPath, cleanup } = await mountInputFile(ffmpeg, file, onProgress, signal);
  const outputName = 'output.mp4';

  try {
    onProgress?.({
      phase: 'processing',
      message: `Compressing ${sizeMb} MB video (can take 15–45+ min in browser)…`,
      percent: 5,
    });

    const scaleFilter = probe.width > 1280 ? "scale='min(1280,iw)':-2" : 'scale=iw:ih';

    // Start at the most aggressive settings to minimise number of attempts
    const attempts: Array<{ crf: string; scale: string }> = [
      { crf: '28', scale: scaleFilter },
      { crf: '30', scale: "scale='min(960,iw)':-2" },
      { crf: '32', scale: "scale='min(720,iw)':-2" },
      { crf: '34', scale: "scale='min(720,iw)':-2" },
    ];

    let blob: Blob | null = null;

    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      checkAborted(signal);
      log.info('compress attempt', { attempt: i + 1, crf: attempt.crf, scale: attempt.scale });

      const stopHeartbeat = startHeartbeat('compress encode', () => ({
        attempt: i + 1,
        crf: attempt.crf,
      }));
      const execStart = Date.now();
      try {
        await execWithAbort(
          ffmpeg,
          [
            '-i', inputPath,
            '-vf', attempt.scale,
            '-c:v', 'libx264',
            '-crf', attempt.crf,
            '-preset', 'fast',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-y', outputName,
          ],
          signal,
        );
      } finally {
        stopHeartbeat();
      }
      log.info('compress encode finished', { attempt: i + 1, elapsedSec: elapsedSec(execStart) });

      blob = await readOutputBlob(ffmpeg, outputName);
      log.info('compress output size', {
        attempt: i + 1,
        outputMb: (blob.size / (1024 * 1024)).toFixed(1),
      });
      if (blob.size <= MAX_CHUNK_BYTES) break;
    }

    await ffmpeg.deleteFile(outputName).catch(() => undefined);

    if (!blob || blob.size > MAX_CHUNK_BYTES) {
      throw new Error(
        'Could not compress video under 200 MB. Try Split mode or trim the video externally.',
      );
    }

    log.info('compressVideo done', {
      outputMb: (blob.size / (1024 * 1024)).toFixed(1),
      totalElapsedSec: elapsedSec(totalStart),
    });

    return { blob, filename: `${baseName(file.name)}_compressed.mp4` };
  } finally {
    await cleanup();
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export function terminateFfmpeg(): void {
  log.info('terminateFfmpeg called');
  if (loadingFfmpeg) {
    killFfmpegInstance(loadingFfmpeg);
  }
  if (ffmpegInstance) {
    killFfmpegInstance(ffmpegInstance);
  }
  loadPromise = null;
  loadingFfmpeg = null;
  ffmpegInstance = null;
}