import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

import { MAX_CHUNK_BYTES, TARGET_CHUNK_BYTES } from '../constants';

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

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

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

async function getFfmpeg(
  onProgress?: (p: VideoPrepProgress) => void,
  signal?: AbortSignal,
): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    onProgress?.({
      phase: 'loading',
      message: 'Loading FFmpeg (first time only)…',
      percent: 0,
    });
    checkAborted(signal);

    const ffmpeg = new FFmpeg();
    const coreBase = typeof chrome !== 'undefined' ? chrome.runtime.getURL('/ffmpeg') : '/ffmpeg';

    ffmpeg.on('progress', ({ progress }) => {
      onProgress?.({
        phase: 'processing',
        message: 'Processing video…',
        percent: Math.round(Math.min(1, Math.max(0, progress)) * 100),
      });
    });

    await ffmpeg.load({
      coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  return loadPromise;
}

/** Probe duration/bitrate via HTML video metadata (fast, no FFmpeg needed). */
export async function probeVideo(
  file: File,
  signal?: AbortSignal,
): Promise<VideoProbe> {
  checkAborted(signal);
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Could not read video metadata'));
    });

    checkAborted(signal);

    const durationSec = video.duration;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error('Invalid video duration');
    }

    const bitrateBps = (file.size * 8) / durationSec;
    return {
      durationSec,
      bitrateBps,
      width: video.videoWidth,
      height: video.videoHeight,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function segmentDurationSec(probe: VideoProbe): number {
  const targetBits = TARGET_CHUNK_BYTES * 8;
  const sec = targetBits / probe.bitrateBps;
  return Math.max(30, Math.min(sec, probe.durationSec));
}

async function readOutputBlob(ffmpeg: FFmpeg, path: string): Promise<Blob> {
  const data = await ffmpeg.readFile(path);
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
  return new Blob([bytes], { type: 'video/mp4' });
}

async function writeInput(ffmpeg: FFmpeg, file: File): Promise<string> {
  const inputName = 'input' + getExtension(file.name);
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  return inputName;
}

export async function compressVideo(
  file: File,
  onProgress?: (p: VideoPrepProgress) => void,
  signal?: AbortSignal,
): Promise<PreparedVideoPart> {
  const ffmpeg = await getFfmpeg(onProgress, signal);
  checkAborted(signal);

  const inputName = await writeInput(ffmpeg, file);
  const outputName = 'output.mp4';
  const probe = await probeVideo(file, signal);

  onProgress?.({ phase: 'processing', message: 'Compressing video…', percent: 5 });

  const scaleFilter =
    probe.width > 1280 ? "scale='min(1280,iw)':-2" : 'scale=iw:ih';

  const attempts: Array<{ crf: string; scale: string }> = [
    { crf: '26', scale: scaleFilter },
    { crf: '28', scale: scaleFilter },
    { crf: '30', scale: "scale='min(960,iw)':-2" },
    { crf: '32', scale: "scale='min(720,iw)':-2" },
  ];

  let blob: Blob | null = null;

  for (const attempt of attempts) {
    checkAborted(signal);
    await ffmpeg.exec([
      '-i',
      inputName,
      '-vf',
      attempt.scale,
      '-c:v',
      'libx264',
      '-crf',
      attempt.crf,
      '-preset',
      'fast',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-y',
      outputName,
    ]);

    blob = await readOutputBlob(ffmpeg, outputName);
    if (blob.size <= MAX_CHUNK_BYTES) {
      break;
    }
  }

  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  if (!blob || blob.size > MAX_CHUNK_BYTES) {
    throw new Error(
      'Could not compress video under 200 MB. Try Split mode or trim the video externally.',
    );
  }

  const ext = getExtension(file.name);
  const outExt = ext === '.mp4' ? ext : '.mp4';
  return {
    blob,
    filename: `${baseName(file.name)}_compressed${outExt}`,
  };
}

async function extractSegment(
  ffmpeg: FFmpeg,
  inputName: string,
  startSec: number,
  durationSec: number,
  outputName: string,
  reencode: boolean,
  probe: VideoProbe,
): Promise<Blob> {
  const args = ['-ss', String(startSec), '-i', inputName, '-t', String(durationSec)];

  if (reencode) {
    const scale =
      probe.width > 1280 ? "scale='min(1280,iw)':-2" : 'scale=iw:ih';
    args.push(
      '-vf',
      scale,
      '-c:v',
      'libx264',
      '-crf',
      '28',
      '-preset',
      'fast',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
    );
  } else {
    args.push('-c', 'copy');
  }

  args.push('-movflags', '+faststart', '-y', outputName);
  await ffmpeg.exec(args);
  return readOutputBlob(ffmpeg, outputName);
}

export async function splitVideo(
  file: File,
  onProgress?: (p: VideoPrepProgress) => void,
  signal?: AbortSignal,
): Promise<PreparedVideoPart[]> {
  const ffmpeg = await getFfmpeg(onProgress, signal);
  checkAborted(signal);

  onProgress?.({ phase: 'probing', message: 'Analyzing video…', percent: 2 });
  const probe = await probeVideo(file, signal);
  const segDur = segmentDurationSec(probe);
  const partCount = Math.ceil(probe.durationSec / segDur);

  const inputName = await writeInput(ffmpeg, file);
  const ext = getExtension(file.name);
  const outExt = ext === '.mp4' ? ext : '.mp4';
  const stem = baseName(file.name);
  const parts: PreparedVideoPart[] = [];

  for (let i = 0; i < partCount; i++) {
    checkAborted(signal);
    const startSec = i * segDur;
    const duration = Math.min(segDur, probe.durationSec - startSec);
    const outputName = `part${i + 1}.mp4`;

    onProgress?.({
      phase: 'processing',
      message: `Splitting part ${i + 1} of ${partCount}…`,
      percent: Math.round((i / partCount) * 100),
      part: i + 1,
      totalParts: partCount,
    });

    let blob = await extractSegment(
      ffmpeg,
      inputName,
      startSec,
      duration,
      outputName,
      false,
      probe,
    );

    if (blob.size > MAX_CHUNK_BYTES) {
      onProgress?.({
        phase: 'processing',
        message: `Re-encoding part ${i + 1} (too large for stream copy)…`,
        percent: Math.round((i / partCount) * 100),
        part: i + 1,
        totalParts: partCount,
      });
      blob = await extractSegment(
        ffmpeg,
        inputName,
        startSec,
        duration,
        outputName,
        true,
        probe,
      );
    }

    if (blob.size > MAX_CHUNK_BYTES) {
      throw new Error(
        `Part ${i + 1} is still ${(blob.size / (1024 * 1024)).toFixed(0)} MB after re-encode. ` +
          'Try Compress mode or a shorter source video.',
      );
    }

    parts.push({
      blob,
      filename: `${stem}_Part${i + 1}${outExt}`,
    });
    await ffmpeg.deleteFile(outputName);
  }

  await ffmpeg.deleteFile(inputName);
  return parts;
}

export function terminateFfmpeg(): void {
  if (ffmpegInstance) {
    void ffmpegInstance.terminate();
    ffmpegInstance = null;
    loadPromise = null;
  }
}
