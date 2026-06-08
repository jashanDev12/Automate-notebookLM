import { fetchAuthSession } from './auth';
import { needsVideoPrep, prepareFileChunks, resolveMimeType } from './chunker';
import type { EnqueueOptions, FileChunk, UploadJob, UploadProgressCallback } from './types';
import { uploadFileChunk } from './upload';
import type { VideoPrepProgress } from './video/ffmpeg';

function createJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Sequential upload queue: prepare (optional) then upload one chunk at a time.
 */
export class SequentialUploadQueue {
  private cancelled = false;
  private running = false;
  private abortController: AbortController | null = null;

  async enqueue(
    file: File,
    notebookId: string,
    onProgress: UploadProgressCallback,
    options: EnqueueOptions = {},
  ): Promise<UploadJob> {
    if (this.running) {
      throw new Error('An upload is already in progress.');
    }

    if (needsVideoPrep(file) && !options.videoPrepMode) {
      throw new Error('Video preparation mode required');
    }

    this.cancelled = false;
    this.running = true;
    this.abortController = options.signal ? null : new AbortController();
    const signal = options.signal ?? this.abortController!.signal;

    const job: UploadJob = {
      id: createJobId(),
      originalName: file.name,
      notebookId,
      status: needsVideoPrep(file) ? 'preparing' : 'running',
      phase: needsVideoPrep(file) ? 'preparing' : 'uploading',
      chunks: [],
    };

    onProgress({ ...job });

    try {
      const chunks = await prepareFileChunks(
        file,
        options.videoPrepMode,
        (prep: VideoPrepProgress) => {
          job.prepProgress = {
            message: prep.message,
            percent: prep.percent,
            part: prep.part,
            totalParts: prep.totalParts,
          };
          onProgress({ ...job, prepProgress: { ...job.prepProgress } });
        },
        signal,
      );

      if (this.cancelled) {
        job.status = 'cancelled';
        job.phase = 'idle';
        onProgress({ ...job });
        return job;
      }

      job.status = 'running';
      job.phase = 'uploading';
      job.prepProgress = undefined;
      job.chunks = chunks.map((c) => ({
        index: c.index,
        filename: c.filename,
        size: c.size,
        status: 'pending' as const,
        bytesSent: 0,
      }));
      onProgress({ ...job, chunks: [...job.chunks] });

      await this.uploadChunks(chunks, file.name, notebookId, job, onProgress, signal);
      return job;
    } catch (err) {
      if (signal.aborted || this.cancelled) {
        job.status = 'cancelled';
      } else {
        job.status = 'failed';
        const failedIndex = job.chunks.findIndex((c) => c.status === 'uploading');
        if (failedIndex >= 0) {
          job.chunks[failedIndex].status = 'failed';
          job.chunks[failedIndex].error =
            err instanceof Error ? err.message : String(err);
        }
      }
      job.phase = 'idle';
      onProgress({ ...job });
      throw err;
    } finally {
      this.running = false;
      this.abortController = null;
    }
  }

  private async uploadChunks(
    chunks: FileChunk[],
    _originalName: string,
    notebookId: string,
    job: UploadJob,
    onProgress: UploadProgressCallback,
    signal: AbortSignal,
  ): Promise<void> {
    for (let i = 0; i < chunks.length; i++) {
      if (this.cancelled || signal.aborted) {
        job.status = 'cancelled';
        job.phase = 'idle';
        onProgress({ ...job });
        return;
      }

      const chunk = chunks[i];
      const mimeType = resolveMimeType(chunk.filename);
      job.chunks[i].status = 'uploading';
      onProgress({ ...job, chunks: [...job.chunks] });

      const session = await fetchAuthSession();

      const sourceId = await uploadFileChunk(
        session,
        notebookId,
        chunk.filename,
        chunk.blob,
        mimeType,
        (sent, total) => {
          job.chunks[i].bytesSent = sent;
          onProgress({ ...job, chunks: [...job.chunks] });
        },
      );

      job.chunks[i].status = 'completed';
      job.chunks[i].sourceId = sourceId;
      job.chunks[i].bytesSent = chunk.size;
      onProgress({ ...job, chunks: [...job.chunks] });
    }

    job.status = 'completed';
    job.phase = 'idle';
    onProgress({ ...job });
  }

  cancel(): void {
    this.cancelled = true;
    this.abortController?.abort();
  }

  get isRunning(): boolean {
    return this.running;
  }
}

export const uploadQueue = new SequentialUploadQueue();
