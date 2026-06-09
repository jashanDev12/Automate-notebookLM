import { fetchAuthSession } from './auth';
import { needsVideoPrep, prepareFileChunks, resolveMimeType } from './chunker';
import { createLogger } from './logger';
import type { EnqueueOptions, FileChunk, UploadJob, UploadProgressCallback } from './types';
import { uploadFileChunk } from './upload';
import { terminateFfmpeg, type VideoPrepProgress } from './video/ffmpeg';

const log = createLogger('queue');

function createJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function formatChunkError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sequential upload queue: prepare (optional) then upload one chunk at a time.
 */
export class SequentialUploadQueue {
  private cancelled = false;
  private running = false;
  private abortController: AbortController | null = null;
  /** Prepared blobs kept in memory for retry without re-splitting. */
  private preparedChunks: FileChunk[] = [];

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
    this.preparedChunks = [];
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

    log.info('Job enqueued', {
      jobId: job.id,
      file: file.name,
      bytes: file.size,
      notebookId,
      needsVideoPrep: needsVideoPrep(file),
      videoPrepMode: options.videoPrepMode,
    });

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

      this.preparedChunks = chunks;

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

      log.info('Prep complete — uploading chunks', { jobId: job.id, chunkCount: chunks.length });
      await this.uploadChunks(chunks, notebookId, job, onProgress, signal);
      this.finishJob(job, onProgress);
      log.info('Job completed', { jobId: job.id });
      return job;
    } catch (err) {
      if (signal.aborted || this.cancelled) {
        log.info('Job cancelled', { jobId: job.id });
        job.status = 'cancelled';
        job.phase = 'idle';
      } else {
        log.error('Job failed', err, { jobId: job.id, status: job.status });
        job.status = 'failed';
        job.phase = 'idle';
      }
      onProgress({ ...job });
      throw err;
    } finally {
      this.running = false;
      this.abortController = null;
    }
  }

  /** Re-upload all chunks that failed (upload or NotebookLM processing). */
  async retryFailed(job: UploadJob, onProgress: UploadProgressCallback): Promise<UploadJob> {
    const failedIndices = job.chunks
      .map((c, i) => (c.status === 'failed' ? i : -1))
      .filter((i) => i >= 0);

    if (failedIndices.length === 0) {
      throw new Error('No failed parts to retry.');
    }

    for (const i of failedIndices) {
      await this.retryChunk(job, i, onProgress);
    }
    return job;
  }

  /** Re-upload a single failed part (uses prepared blob from last enqueue). */
  async retryChunk(
    job: UploadJob,
    chunkIndex: number,
    onProgress: UploadProgressCallback,
  ): Promise<UploadJob> {
    if (this.running) {
      throw new Error('An upload is already in progress.');
    }

    if (chunkIndex < 0 || chunkIndex >= job.chunks.length) {
      throw new Error(`Invalid part index: ${chunkIndex + 1}`);
    }

    if (job.chunks[chunkIndex].status !== 'failed') {
      throw new Error(`Part ${chunkIndex + 1} did not fail — nothing to retry.`);
    }

    if (this.preparedChunks.length === 0) {
      throw new Error('Prepared parts were cleared — please upload the file again.');
    }

    const chunk = this.preparedChunks[chunkIndex];
    if (!chunk) {
      throw new Error(`Missing prepared data for part ${chunkIndex + 1}`);
    }

    this.cancelled = false;
    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    log.info('Retrying chunk', {
      jobId: job.id,
      index: chunkIndex + 1,
      filename: chunk.filename,
    });

    job.status = 'running';
    job.phase = 'uploading';
    onProgress({ ...job, chunks: [...job.chunks] });

    try {
      if (this.cancelled || signal.aborted) {
        job.status = 'cancelled';
        job.phase = 'idle';
        onProgress({ ...job });
        return job;
      }

      await this.uploadOneChunk(chunk, chunkIndex, job, onProgress, signal);
      this.finishJob(job, onProgress);
      return job;
    } finally {
      this.running = false;
      this.abortController = null;
    }
  }

  private finishJob(job: UploadJob, onProgress: UploadProgressCallback): void {
    const failed = job.chunks.filter((c) => c.status === 'failed').length;
    job.status = failed > 0 ? 'failed' : 'completed';
    job.phase = 'done';
    onProgress({ ...job, chunks: [...job.chunks] });
  }

  private async uploadChunks(
    chunks: FileChunk[],
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
      await this.uploadOneChunk(chunks[i], i, job, onProgress, signal);
    }
  }

  private async uploadOneChunk(
    chunk: FileChunk,
    index: number,
    job: UploadJob,
    onProgress: UploadProgressCallback,
    signal: AbortSignal,
  ): Promise<void> {
    const mimeType = resolveMimeType(chunk.filename);

    log.info('Uploading chunk', {
      jobId: job.id,
      index: index + 1,
      total: job.chunks.length,
      filename: chunk.filename,
      bytes: chunk.size,
    });

    job.chunks[index].status = 'uploading';
    job.chunks[index].error = undefined;
    job.chunks[index].bytesSent = 0;
    onProgress({ ...job, chunks: [...job.chunks] });

    try {
      const session = await fetchAuthSession();
      const sourceId = await uploadFileChunk(
        session,
        job.notebookId,
        chunk.filename,
        chunk.blob,
        mimeType,
        {
          onProgress: (sent) => {
            job.chunks[index].bytesSent = sent;
            onProgress({ ...job, chunks: [...job.chunks] });
          },
          onPhase: (phase) => {
            job.chunks[index].status = phase === 'processing' ? 'processing' : 'uploading';
            if (phase === 'processing') {
              job.chunks[index].bytesSent = chunk.size;
            }
            onProgress({ ...job, chunks: [...job.chunks] });
          },
        },
        { signal },
      );

      job.chunks[index].status = 'completed';
      job.chunks[index].sourceId = sourceId;
      job.chunks[index].bytesSent = chunk.size;
      onProgress({ ...job, chunks: [...job.chunks] });
    } catch (err) {
      if (signal.aborted || this.cancelled || (err as Error).name === 'AbortError') {
        job.chunks[index].status = 'failed';
        job.chunks[index].error = 'Cancelled';
        onProgress({ ...job, chunks: [...job.chunks] });
        return;
      }

      const msg = formatChunkError(err);
      log.error('Chunk upload/processing failed', err, {
        jobId: job.id,
        index: index + 1,
        filename: chunk.filename,
      });
      job.chunks[index].status = 'failed';
      job.chunks[index].error = msg;
      onProgress({ ...job, chunks: [...job.chunks] });
    }
  }

  cancel(): void {
    log.info('Upload cancelled by user');
    this.cancelled = true;
    this.abortController?.abort();
    terminateFfmpeg();
  }

  clearPreparedChunks(): void {
    this.preparedChunks = [];
  }

  get isRunning(): boolean {
    return this.running;
  }

  get hasPreparedChunks(): boolean {
    return this.preparedChunks.length > 0;
  }
}

export const uploadQueue = new SequentialUploadQueue();
