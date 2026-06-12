// import { fetchAuthSession } from './auth';
// import { needsVideoPrep, prepareFileChunks, resolveMimeType } from './chunker';
// import {
//   deleteStoredJob,
//   loadStoredJob,
//   saveStoredJob,
//   updateStoredJob,
// } from './chunk-store';
// import { createLogger } from './logger';
// import type { EnqueueOptions, FileChunk, UploadJob, UploadProgressCallback } from './types';
// import { uploadFileChunk } from './upload';
// import { terminateFfmpeg, type VideoPrepProgress } from './video/ffmpeg';

// const log = createLogger('queue');

// function createJobId(): string {
//   return `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
// }

// function formatChunkError(err: unknown): string {
//   return err instanceof Error ? err.message : String(err);
// }

// /**
//  * Sequential upload queue: prepare (optional) then upload one chunk at a time.
//  */
// export class SequentialUploadQueue {
//   private cancelled = false;
//   private running = false;
//   private abortController: AbortController | null = null;
//   /** Prepared blobs kept in memory for retry without re-splitting. */
//   private preparedChunks: FileChunk[] = [];
//   private activeJobId: string | null = null;

//   /** Restore in-memory chunks from a previous session (IndexedDB). */
//   hydrateFromStore(chunks: FileChunk[], jobId: string): void {
//     this.preparedChunks = chunks;
//     this.activeJobId = jobId;
//   }

//   private async persistJob(job: UploadJob, chunks?: FileChunk[]): Promise<void> {
//     try {
//       if (chunks) {
//         await saveStoredJob(job, chunks);
//       } else {
//         await updateStoredJob(job);
//       }
//     } catch (err) {
//       log.warn('Failed to persist job locally', { jobId: job.id, error: formatChunkError(err) });
//     }
//   }

//   private async ensurePreparedChunks(job: UploadJob): Promise<void> {
//     if (this.preparedChunks.length > 0) return;

//     const stored = await loadStoredJob(job.id);
//     if (!stored?.chunks.length) {
//       throw new Error('Prepared parts were cleared — please upload the file again.');
//     }

//     this.preparedChunks = stored.chunks;
//     this.activeJobId = job.id;
//     log.info('Loaded prepared parts from local storage', {
//       jobId: job.id,
//       parts: stored.chunks.length,
//     });
//   }

//   async enqueue(
//     file: File,
//     notebookId: string,
//     onProgress: UploadProgressCallback,
//     options: EnqueueOptions = {},
//   ): Promise<UploadJob> {
//     if (this.running) {
//       throw new Error('An upload is already in progress.');
//     }

//     if (needsVideoPrep(file) && !options.videoPrepMode) {
//       throw new Error('Video preparation mode required');
//     }

//     this.cancelled = false;
//     this.running = true;
//     this.preparedChunks = [];
//     this.abortController = options.signal ? null : new AbortController();
//     const signal = options.signal ?? this.abortController!.signal;

//     const job: UploadJob = {
//       id: createJobId(),
//       originalName: file.name,
//       notebookId,
//       status: needsVideoPrep(file) ? 'preparing' : 'running',
//       phase: needsVideoPrep(file) ? 'preparing' : 'uploading',
//       chunks: [],
//     };

//     onProgress({ ...job });

//     log.info('Job enqueued', {
//       jobId: job.id,
//       file: file.name,
//       bytes: file.size,
//       notebookId,
//       needsVideoPrep: needsVideoPrep(file),
//       videoPrepMode: options.videoPrepMode,
//     });

//     try {
//       const chunks = await prepareFileChunks(
//         file,
//         options.videoPrepMode,
//         (prep: VideoPrepProgress) => {
//           job.prepProgress = {
//             message: prep.message,
//             percent: prep.percent,
//             part: prep.part,
//             totalParts: prep.totalParts,
//           };
//           onProgress({ ...job, prepProgress: { ...job.prepProgress } });
//         },
//         signal,
//       );

//       if (this.cancelled) {
//         job.status = 'cancelled';
//         job.phase = 'idle';
//         onProgress({ ...job });
//         return job;
//       }

//       this.preparedChunks = chunks;
//       this.activeJobId = job.id;
//       await this.persistJob(job, chunks);

//       job.status = 'running';
//       job.phase = 'uploading';
//       job.prepProgress = undefined;
//       job.chunks = chunks.map((c) => ({
//         index: c.index,
//         filename: c.filename,
//         size: c.size,
//         status: 'pending' as const,
//         bytesSent: 0,
//       }));
//       onProgress({ ...job, chunks: [...job.chunks] });

//       log.info('Prep complete — uploading chunks', { jobId: job.id, chunkCount: chunks.length });
//       await this.uploadChunks(chunks, notebookId, job, onProgress, signal);
//       this.finishJob(job, onProgress);
//       log.info('Job completed', { jobId: job.id });
//       return job;
//     } catch (err) {
//       if (signal.aborted || this.cancelled) {
//         log.info('Job cancelled', { jobId: job.id });
//         job.status = 'cancelled';
//         job.phase = 'idle';
//       } else {
//         log.error('Job failed', err, { jobId: job.id, status: job.status });
//         job.status = 'failed';
//         job.phase = 'idle';
//       }
//       onProgress({ ...job });
//       throw err;
//     } finally {
//       this.running = false;
//       this.abortController = null;
//     }
//   }

//   /** Re-upload one failed part; only one retry runs at a time until it completes. */
//   async retryChunk(
//     job: UploadJob,
//     chunkIndex: number,
//     onProgress: UploadProgressCallback,
//   ): Promise<UploadJob> {
//     if (this.running) {
//       throw new Error('A retry is already in progress.');
//     }

//     if (job.phase === 'retrying') {
//       throw new Error('Finish the current retry before starting another.');
//     }

//     if (chunkIndex < 0 || chunkIndex >= job.chunks.length) {
//       throw new Error(`Invalid part index: ${chunkIndex + 1}`);
//     }

//     if (job.chunks[chunkIndex].status !== 'failed') {
//       throw new Error(`Part ${chunkIndex + 1} did not fail — nothing to retry.`);
//     }

//     await this.ensurePreparedChunks(job);

//     const chunk = this.preparedChunks[chunkIndex];
//     if (!chunk) {
//       throw new Error(`Missing prepared data for part ${chunkIndex + 1}`);
//     }

//     this.cancelled = false;
//     this.running = true;
//     this.abortController = new AbortController();
//     const signal = this.abortController.signal;

//     log.info('Retrying chunk', {
//       jobId: job.id,
//       index: chunkIndex + 1,
//       filename: chunk.filename,
//     });

//     job.status = 'running';
//     job.phase = 'retrying';
//     job.retryingChunkIndex = chunkIndex;
//     onProgress({ ...job, chunks: [...job.chunks] });
//     void this.persistJob(job);

//     try {
//       if (this.cancelled || signal.aborted) {
//         job.chunks[chunkIndex].status = 'failed';
//         job.chunks[chunkIndex].error = 'Cancelled';
//         this.finishJob(job, onProgress);
//         return job;
//       }

//       await this.uploadOneChunk(chunk, chunkIndex, job, onProgress, signal);
//       this.finishJob(job, onProgress);
//       return job;
//     } finally {
//       this.running = false;
//       this.abortController = null;
//     }
//   }

//   private finishJob(job: UploadJob, onProgress: UploadProgressCallback): void {
//     const failed = job.chunks.filter((c) => c.status === 'failed').length;
//     job.status = failed > 0 ? 'failed' : 'completed';
//     job.phase = 'done';
//     job.retryingChunkIndex = undefined;
//     onProgress({ ...job, chunks: [...job.chunks] });
//     void this.persistJob(job);
//   }

//   private touchJob(job: UploadJob): void {
//     void this.persistJob(job);
//   }

//   private async uploadChunks(
//     chunks: FileChunk[],
//     notebookId: string,
//     job: UploadJob,
//     onProgress: UploadProgressCallback,
//     signal: AbortSignal,
//   ): Promise<void> {
//     for (let i = 0; i < chunks.length; i++) {
//       if (this.cancelled || signal.aborted) {
//         job.status = 'cancelled';
//         job.phase = 'idle';
//         onProgress({ ...job });
//         return;
//       }
//       await this.uploadOneChunk(chunks[i], i, job, onProgress, signal);
//     }
//   }

//   private async uploadOneChunk(
//     chunk: FileChunk,
//     index: number,
//     job: UploadJob,
//     onProgress: UploadProgressCallback,
//     signal: AbortSignal,
//   ): Promise<void> {
//     const mimeType = resolveMimeType(chunk.filename);

//     log.info('Uploading chunk', {
//       jobId: job.id,
//       index: index + 1,
//       total: job.chunks.length,
//       filename: chunk.filename,
//       bytes: chunk.size,
//     });

//     job.chunks[index].status = 'uploading';
//     job.chunks[index].error = undefined;
//     job.chunks[index].bytesSent = 0;
//     onProgress({ ...job, chunks: [...job.chunks] });
//     this.touchJob(job);

//     try {
//       const session = await fetchAuthSession();
//       const sourceId = await uploadFileChunk(
//         session,
//         job.notebookId,
//         chunk.filename,
//         chunk.blob,
//         mimeType,
//         {
//           onProgress: (sent) => {
//             job.chunks[index].bytesSent = sent;
//             onProgress({ ...job, chunks: [...job.chunks] });
//           },
//           onPhase: (phase) => {
//             job.chunks[index].status = phase === 'processing' ? 'processing' : 'uploading';
//             if (phase === 'processing') {
//               job.chunks[index].bytesSent = chunk.size;
//             }
//             onProgress({ ...job, chunks: [...job.chunks] });
//             this.touchJob(job);
//           },
//         },
//         { signal },
//       );

//       job.chunks[index].status = 'completed';
//       job.chunks[index].sourceId = sourceId;
//       job.chunks[index].bytesSent = chunk.size;
//       onProgress({ ...job, chunks: [...job.chunks] });
//       this.touchJob(job);
//     } catch (err) {
//       if (signal.aborted || this.cancelled || (err as Error).name === 'AbortError') {
//         job.chunks[index].status = 'failed';
//         job.chunks[index].error = 'Cancelled';
//         onProgress({ ...job, chunks: [...job.chunks] });
//         return;
//       }

//       const msg = formatChunkError(err);
//       log.error('Chunk upload/processing failed', err, {
//         jobId: job.id,
//         index: index + 1,
//         filename: chunk.filename,
//       });
//       job.chunks[index].status = 'failed';
//       job.chunks[index].error = msg;
//       onProgress({ ...job, chunks: [...job.chunks] });
//       this.touchJob(job);
//     }
//   }

//   cancel(): void {
//     log.info('Upload cancelled by user');
//     this.cancelled = true;
//     this.abortController?.abort();
//     terminateFfmpeg();
//   }

//   async clearPreparedChunks(jobId?: string): Promise<void> {
//     const id = jobId ?? this.activeJobId;
//     this.preparedChunks = [];
//     this.activeJobId = null;
//     if (id) {
//       try {
//         await deleteStoredJob(id);
//       } catch (err) {
//         log.warn('Failed to delete stored job', { jobId: id, error: formatChunkError(err) });
//       }
//     }
//   }

//   get isRunning(): boolean {
//     return this.running;
//   }

//   get hasPreparedChunks(): boolean {
//     return this.preparedChunks.length > 0;
//   }
// }

// export const uploadQueue = new SequentialUploadQueue();



import { fetchAuthSession } from './auth';
import { needsVideoPrep, prepareFileChunks, resolveMimeType } from './chunker';
import {
  deleteStoredJob,
  loadStoredJob,
  saveStoredJob,
  updateStoredJob,
} from './chunk-store';
import { createLogger } from './logger';
import {
  SourceProcessingError,
  SourceProcessingTimeoutError,
  SourceStatus,
  getNotebookSource,
} from './source-status';
import type { ChunkProgress, EnqueueOptions, FileChunk, UploadJob, UploadProgressCallback } from './types';
import {
  uploadFileChunk,
  uploadFileChunksParallel,
  waitForChunkProcessing,
  type MultiPartProgress,
} from './upload';
import { terminateFfmpeg, type VideoPrepProgress } from './video/ffmpeg';

const log = createLogger('queue');

function createJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function formatChunkError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function canResumeProcessingOnly(chunk: { sourceId?: string; failureKind?: string }): boolean {
  return Boolean(chunk.sourceId && chunk.failureKind === 'processing_timeout');
}

function applyChunkFailure(
  chunk: ChunkProgress,
  err: unknown,
  isCancelled: boolean,
): void {
  chunk.status = 'failed';
  chunk.statusDetail = undefined;

  if (isCancelled) {
    chunk.failureKind = 'cancelled';
    chunk.error = 'Cancelled';
    return;
  }

  if (err instanceof SourceProcessingTimeoutError) {
    chunk.failureKind = 'processing_timeout';
    chunk.sourceId = err.sourceId;
    chunk.bytesSent = chunk.size;
    chunk.error =
      `${err.message} The file is already on NotebookLM — click "Resume waiting" (do not re-upload).`;
    return;
  }

  if (err instanceof SourceProcessingError) {
    chunk.failureKind = 'processing';
    chunk.sourceId = err.sourceId;
    chunk.bytesSent = chunk.size;
    chunk.error = err.message;
    return;
  }

  chunk.failureKind = 'upload';
  chunk.error = formatChunkError(err);
}

/**
 * Upload queue: prepare (optional) then upload all chunks in parallel.
 *
 * Retry safety
 * ────────────
 * Each chunk carries its own status ('pending' | 'uploading' | 'processing' |
 * 'completed' | 'failed'). Parallel uploads update these independently, so a
 * failure in part 2 never affects parts 1, 3, 4 … which may have already
 * succeeded. The caller can retry any individual failed part without re-doing
 * the others.
 */
export class SequentialUploadQueue {
  private cancelled = false;
  private running = false;
  private abortController: AbortController | null = null;
  /** Prepared blobs kept in memory for retry without re-splitting. */
  private preparedChunks: FileChunk[] = [];
  private activeJobId: string | null = null;

  hydrateFromStore(chunks: FileChunk[], jobId: string): void {
    this.preparedChunks = chunks;
    this.activeJobId = jobId;
  }

  /**
   * Reconcile local job state with NotebookLM on startup.
   * If parts were left mid-processing, we check Google's servers to see if they
   * actually finished while the side panel was closed.
   */
  async verifyAndHydrateStoredJob(job: UploadJob, chunks: FileChunk[]): Promise<UploadJob> {
    this.hydrateFromStore(chunks, job.id);
    let changed = false;

    // Only verify if there is at least one part that might have finished in background
    const needsVerification = job.chunks.some(
      (c) => (c.status === 'polling' || c.status === 'processing' || c.status === 'uploading') && c.sourceId,
    );

    if (needsVerification && job.phase !== 'done') {
      try {
        const session = await fetchAuthSession();
        for (const chunk of job.chunks) {
          if (
            (chunk.status === 'polling' || chunk.status === 'processing' || chunk.status === 'uploading') &&
            chunk.sourceId
          ) {
            log.info('Verifying part status with NotebookLM', {
              jobId: job.id,
              index: chunk.index + 1,
              sourceId: chunk.sourceId,
            });

            const remote = await getNotebookSource(session, job.notebookId, chunk.sourceId);
            if (remote?.status === SourceStatus.READY) {
              log.info('Part verified as completed on server', { index: chunk.index + 1 });
              chunk.status = 'completed';
              chunk.error = undefined;
              chunk.failureKind = undefined;
              changed = true;
            } else if (remote?.status === SourceStatus.ERROR) {
              log.warn('Part verified as failed on server', { index: chunk.index + 1 });
              chunk.status = 'failed';
              chunk.error = 'Processing failed on NotebookLM servers.';
              chunk.failureKind = 'processing';
              changed = true;
            }
          }
        }
      } catch (err) {
        log.warn('Verification failed during hydration', { error: formatChunkError(err) });
      }
    }

    if (changed) {
      const allDone = job.chunks.every((c) => c.status === 'completed');
      if (allDone) {
        job.status = 'completed';
        job.phase = 'done';
      } else if (job.chunks.some((c) => c.status === 'failed')) {
        job.status = 'failed';
        job.phase = 'done';
      }
      await updateStoredJob(job);
    }

    return job;
  }

  private async persistJob(job: UploadJob, chunks?: FileChunk[]): Promise<void> {
    try {
      if (chunks) {
        await saveStoredJob(job, chunks);
      } else {
        await updateStoredJob(job);
      }
    } catch (err) {
      log.warn('Failed to persist job locally', { jobId: job.id, error: formatChunkError(err) });
    }
  }

  private async ensurePreparedChunks(job: UploadJob): Promise<void> {
    if (this.preparedChunks.length > 0) return;

    const stored = await loadStoredJob(job.id);
    if (!stored?.chunks.length) {
      throw new Error('Prepared parts were cleared — please upload the file again.');
    }

    this.preparedChunks = stored.chunks;
    this.activeJobId = job.id;
    log.info('Loaded prepared parts from local storage', {
      jobId: job.id,
      parts: stored.chunks.length,
    });
  }

  async enqueue(
    file: File,
    notebookId: string,
    onProgress: UploadProgressCallback,
    options: EnqueueOptions = {},
  ): Promise<UploadJob> {
    if (this.running) throw new Error('An upload is already in progress.');
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
      // ── Step 1: prepare (split / compress) ─────────────────────────────
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
      this.activeJobId = job.id;
      await this.persistJob(job, chunks);

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

      log.info('Prep complete — uploading chunks in parallel', {
        jobId: job.id,
        chunkCount: chunks.length,
      });

      // ── Step 2: upload all chunks in parallel ───────────────────────────
      await this.uploadChunksParallel(chunks, notebookId, job, onProgress, signal);

      this.finishJob(job, onProgress);
      log.info('Job completed', { jobId: job.id });
      return job;
    } catch (err) {
      if (signal.aborted || this.cancelled) {
        log.info('Job cancelled', { jobId: job.id });
        job.status = 'cancelled';
        job.phase = 'idle';
      } else {
        log.error('Job failed', err, { jobId: job.id });
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

  /**
   * Retry one specific failed part.
   *
   * Only that part is re-uploaded; all already-completed parts are untouched.
   * The job stays in 'failed' state until every part is completed.
   */
  async retryChunk(
    job: UploadJob,
    chunkIndex: number,
    onProgress: UploadProgressCallback,
  ): Promise<UploadJob> {
    if (this.running) throw new Error('A retry is already in progress.');
    if (job.phase === 'retrying') throw new Error('Finish the current retry before starting another.');

    if (chunkIndex < 0 || chunkIndex >= job.chunks.length) {
      throw new Error(`Invalid part index: ${chunkIndex + 1}`);
    }
    if (job.chunks[chunkIndex].status !== 'failed') {
      throw new Error(`Part ${chunkIndex + 1} did not fail — nothing to retry.`);
    }

    await this.ensurePreparedChunks(job);

    const chunk = this.preparedChunks[chunkIndex];
    if (!chunk) throw new Error(`Missing prepared data for part ${chunkIndex + 1}`);

    this.cancelled = false;
    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    log.info('Retrying chunk', { jobId: job.id, index: chunkIndex + 1, filename: chunk.filename });

    job.status = 'running';
    job.phase = 'retrying';
    job.retryingChunkIndex = chunkIndex;
    onProgress({ ...job, chunks: [...job.chunks] });
    void this.persistJob(job);

    try {
      await this.uploadOneChunk(chunk, chunkIndex, job, onProgress, signal);
      this.finishJob(job, onProgress);
      return job;
    } finally {
      this.running = false;
      this.abortController = null;
    }
  }

  /**
   * Retry ALL failed parts in parallel (convenience helper for "retry all" button).
   */
  async retryAllFailed(
    job: UploadJob,
    onProgress: UploadProgressCallback,
  ): Promise<UploadJob> {
    if (this.running) throw new Error('An upload is already in progress.');

    const failedIndices = job.chunks
      .map((c, i) => ({ ...c, i }))
      .filter((c) => c.status === 'failed')
      .map((c) => c.i);

    if (failedIndices.length === 0) {
      throw new Error('No failed parts to retry.');
    }

    await this.ensurePreparedChunks(job);

    this.cancelled = false;
    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    log.info('Retrying all failed chunks', {
      jobId: job.id,
      failedIndices,
    });

    job.status = 'running';
    job.phase = 'uploading';
    job.retryingChunkIndex = undefined;
    onProgress({ ...job, chunks: [...job.chunks] });
    void this.persistJob(job);

    try {
      const failedChunks = failedIndices.map((i) => this.preparedChunks[i]);
      await this.uploadChunksParallel(
        failedChunks,
        job.notebookId,
        job,
        onProgress,
        signal,
        failedIndices, // pass original indices so progress maps to correct slots
      );
      this.finishJob(job, onProgress);
      return job;
    } catch (err) {
      if (signal.aborted || this.cancelled) {
        job.status = 'cancelled';
        job.phase = 'idle';
      } else {
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

  // ── Private helpers ──────────────────────────────────────────────────────

  private finishJob(job: UploadJob, onProgress: UploadProgressCallback): void {
    const failed = job.chunks.filter((c) => c.status === 'failed').length;
    job.status = failed > 0 ? 'failed' : 'completed';
    job.phase = 'done';
    job.retryingChunkIndex = undefined;
    onProgress({ ...job, chunks: [...job.chunks] });
    void this.persistJob(job);
  }

  private touchJob(job: UploadJob): void {
    void this.persistJob(job);
  }

  /**
   * Upload chunks in parallel.
   *
   * `jobIndices` maps position-in-chunks-array → position-in-job.chunks[].
   * When uploading all parts from scratch, jobIndices === [0,1,2,…].
   * When retrying only failed parts, jobIndices might be [1, 3] meaning
   * chunks[0] maps to job.chunks[1] and chunks[1] maps to job.chunks[3].
   */
  private async uploadChunksParallel(
    chunks: FileChunk[],
    notebookId: string,
    job: UploadJob,
    onProgress: UploadProgressCallback,
    signal: AbortSignal,
    jobIndices?: number[], // defaults to [0, 1, 2, …]
  ): Promise<void> {
    const resolvedIndices = jobIndices ?? chunks.map((_, i) => i);

    if (chunks.length === 1) {
      // Single chunk — skip parallel overhead
      await this.uploadOneChunk(chunks[0], resolvedIndices[0], job, onProgress, signal);
      return;
    }

    const session = await fetchAuthSession();

    // Map MultiPartProgress (0-based within this batch) back to job.chunks[]
    const handlePartProgress = (p: MultiPartProgress): void => {
      const jobIndex = resolvedIndices[p.partIndex];
      if (jobIndex === undefined) return;

      const chunk = job.chunks[jobIndex];
      const oldPhase = chunk.status;
      chunk.status = p.phase;
      chunk.statusDetail = p.detail;
      if (p.phase === 'uploading') {
        chunk.bytesSent = p.sent;
      } else if (p.phase !== 'registering') {
        chunk.bytesSent = p.total;
      }
      onProgress({ ...job, chunks: [...job.chunks] });
      
      if (oldPhase !== p.phase) {
        this.touchJob(job);
      }
    };

    // Mark all as pending before we start so UI resets correctly on retry
    for (const ji of resolvedIndices) {
      job.chunks[ji].status = 'pending';
      job.chunks[ji].bytesSent = 0;
      job.chunks[ji].error = undefined;
    }
    onProgress({ ...job, chunks: [...job.chunks] });
    this.touchJob(job);

    // uploadFileChunksParallel resolves with per-part results even when some fail.
    // We use the allSettled variant so partial failures don't throw immediately —
    // instead we record each failure on the job chunk and let finishJob decide
    // the overall status.
    const results = await uploadFileChunksParallelSettled(
      session,
      notebookId,
      chunks.map((c) => ({
        blob: c.blob,
        filename: c.filename,
        contentType: resolveMimeType(c.filename),
      })),
      handlePartProgress,
      {
        signal,
        resumeSourceIds: resolvedIndices.map((ji) => {
          const cp = job.chunks[ji];
          return canResumeProcessingOnly(cp) ? cp.sourceId : undefined;
        }),
      },
    );

    // Write results back to job.chunks[]
    for (let i = 0; i < results.length; i++) {
      const jobIndex = resolvedIndices[i];
      if (jobIndex === undefined) continue;
      const result = results[i];

      if (result.status === 'fulfilled') {
        job.chunks[jobIndex].status = 'completed';
        job.chunks[jobIndex].sourceId = result.value.sourceId;
        job.chunks[jobIndex].bytesSent = chunks[i].size;
        job.chunks[jobIndex].error = undefined;
        job.chunks[jobIndex].failureKind = undefined;
      } else {
        const isCancelled =
          signal.aborted ||
          this.cancelled ||
          (result.reason as Error)?.name === 'AbortError';

        applyChunkFailure(job.chunks[jobIndex], result.reason, isCancelled);

        log.error('Chunk upload failed', result.reason, {
          jobId: job.id,
          partIndex: i + 1,
          jobIndex: jobIndex + 1,
          filename: chunks[i].filename,
        });
      }
    }

    onProgress({ ...job, chunks: [...job.chunks] });
    this.touchJob(job);
  }

  /** Upload a single chunk and update job state. Used for single-part and retry paths. */
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

    const chunkProgress = job.chunks[index];
    const resumeOnly = canResumeProcessingOnly(chunkProgress);

    chunkProgress.error = undefined;
    chunkProgress.statusDetail = undefined;
    if (resumeOnly) {
      chunkProgress.status = 'polling';
      chunkProgress.bytesSent = chunk.size;
    } else {
      chunkProgress.status = 'pending';
      chunkProgress.bytesSent = 0;
      chunkProgress.sourceId = undefined;
      chunkProgress.failureKind = undefined;
    }
    onProgress({ ...job, chunks: [...job.chunks] });
    this.touchJob(job);

    const phaseCallbacks = {
      onProgress: (sent: number) => {
        job.chunks[index].bytesSent = sent;
        onProgress({ ...job, chunks: [...job.chunks] });
      },
      onPhase: (phase: MultiPartProgress['phase'], detail?: string) => {
        job.chunks[index].status = phase;
        job.chunks[index].statusDetail = detail;
        if (phase === 'uploading') {
          // bytesSent updated via onProgress
        } else if (phase !== 'registering') {
          job.chunks[index].bytesSent = chunk.size;
        }
        onProgress({ ...job, chunks: [...job.chunks] });
        this.touchJob(job);
      },
    };

    try {
      const session = await fetchAuthSession();
      let sourceId = chunkProgress.sourceId;

      if (resumeOnly && sourceId) {
        log.info('Resuming NotebookLM processing (no re-upload)', {
          jobId: job.id,
          index: index + 1,
          sourceId,
          filename: chunk.filename,
        });

        const existing = await getNotebookSource(session, job.notebookId, sourceId);
        if (existing?.status === SourceStatus.READY) {
          log.info('Source already ready on resume', { sourceId, filename: chunk.filename });
        } else {
          await waitForChunkProcessing(
            session,
            job.notebookId,
            sourceId,
            chunk.filename,
            chunk.size,
            phaseCallbacks,
            { signal },
          );
        }
      } else {
        sourceId = await uploadFileChunk(
          session,
          job.notebookId,
          chunk.filename,
          chunk.blob,
          mimeType,
          phaseCallbacks,
          { signal },
        );
      }

      job.chunks[index].status = 'completed';
      job.chunks[index].sourceId = sourceId;
      job.chunks[index].bytesSent = chunk.size;
      job.chunks[index].failureKind = undefined;
      job.chunks[index].error = undefined;
      onProgress({ ...job, chunks: [...job.chunks] });
      this.touchJob(job);
    } catch (err) {
      const isCancelled =
        signal.aborted || this.cancelled || (err as Error).name === 'AbortError';

      applyChunkFailure(job.chunks[index], err, isCancelled);
      onProgress({ ...job, chunks: [...job.chunks] });
      this.touchJob(job);

      if (!isCancelled) {
        log.error('Chunk upload/processing failed', err, {
          jobId: job.id,
          index: index + 1,
          filename: chunk.filename,
          resumeOnly,
        });
      }
    }
  }

  cancel(): void {
    log.info('Upload cancelled by user');
    this.cancelled = true;
    this.abortController?.abort();
    terminateFfmpeg();
  }

  async clearPreparedChunks(jobId?: string): Promise<void> {
    const id = jobId ?? this.activeJobId;
    this.preparedChunks = [];
    this.activeJobId = null;
    if (id) {
      try {
        await deleteStoredJob(id);
      } catch (err) {
        log.warn('Failed to delete stored job', { jobId: id, error: formatChunkError(err) });
      }
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  get hasPreparedChunks(): boolean {
    return this.preparedChunks.length > 0;
  }
}

// ─── allSettled variant of parallel upload ────────────────────────────────────

import type { FileChunkInput, UploadedPart } from './upload';

type SettledUploadResult =
  | { status: 'fulfilled'; value: UploadedPart }
  | { status: 'rejected'; reason: unknown };

/**
 * Like uploadFileChunksParallel but never throws — returns a settled result
 * per part so the queue can record per-part failures without losing the
 * successful ones.
 */
async function uploadFileChunksParallelSettled(
  session: Parameters<typeof uploadFileChunksParallel>[0],
  notebookId: string,
  chunks: FileChunkInput[],
  onPartProgress?: (p: MultiPartProgress) => void,
  options?: { signal?: AbortSignal; resumeSourceIds?: (string | undefined)[] },
): Promise<SettledUploadResult[]> {
  // Re-implement the per-part fan-out here so each part is individually settled.
  // This mirrors uploadFileChunksParallel's logic but wraps each part promise.
  const {
    uploadFileChunk: uploadOne,
    startResumableUpload,
    uploadBlobResumable,
    pollPhaseFromUpdate,
  } = await import('./upload');
  const { registerFileSource } = await import('./rpc');
  const { getNotebookSource, SourceStatus, waitForSourceReady } = await import('./source-status');
  const { resolveMimeType } = await import('./chunker');

  const CONCURRENCY = 3;
  let active = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < CONCURRENCY) { active++; return Promise.resolve(); }
    return new Promise((res) => queue.push(res));
  }
  function release(): void {
    const next = queue.shift();
    if (next) next(); else active--;
  }

  const partPromises = chunks.map(
    (chunk, partIndex): Promise<SettledUploadResult> =>
      (async (): Promise<SettledUploadResult> => {
        try {
          const resumeSourceId = options?.resumeSourceIds?.[partIndex];
          if (resumeSourceId) {
            onPartProgress?.({
              partIndex,
              phase: 'polling',
              sent: chunk.blob.size,
              total: chunk.blob.size,
            });

            const existing = await getNotebookSource(session, notebookId, resumeSourceId);
            if (existing?.status !== SourceStatus.READY) {
              await waitForSourceReady(session, notebookId, resumeSourceId, chunk.filename, {
                signal: options?.signal,
                fileSizeBytes: chunk.blob.size,
                onPoll: (update) => {
                  const { phase, detail } = pollPhaseFromUpdate(update);
                  onPartProgress?.({
                    partIndex,
                    phase,
                    sent: chunk.blob.size,
                    total: chunk.blob.size,
                    detail,
                  });
                },
              });
            }

            return {
              status: 'fulfilled',
              value: { partIndex, filename: chunk.filename, sourceId: resumeSourceId },
            };
          }

          onPartProgress?.({
            partIndex,
            phase: 'registering',
            sent: 0,
            total: chunk.blob.size,
          });

          const sourceId = await registerFileSource(session, notebookId, chunk.filename);
          const uploadUrl = await startResumableUpload(
            session,
            notebookId,
            chunk.filename,
            chunk.blob.size,
            sourceId,
            chunk.contentType,
          );

          await acquire();
          options?.signal?.throwIfAborted();
          onPartProgress?.({ partIndex, phase: 'uploading', sent: 0, total: chunk.blob.size });

          try {
            await uploadBlobResumable(session, uploadUrl, chunk.blob, (sent, total) =>
              onPartProgress?.({ partIndex, phase: 'uploading', sent, total }),
            );
          } finally {
            release();
          }

          onPartProgress?.({
            partIndex,
            phase: 'uploaded',
            sent: chunk.blob.size,
            total: chunk.blob.size,
          });

          await waitForSourceReady(session, notebookId, sourceId, chunk.filename, {
            signal: options?.signal,
            fileSizeBytes: chunk.blob.size,
            onPoll: (update) => {
              const { phase, detail } = pollPhaseFromUpdate(update);
              onPartProgress?.({
                partIndex,
                phase,
                sent: chunk.blob.size,
                total: chunk.blob.size,
                detail,
              });
            },
          });

          return { status: 'fulfilled', value: { partIndex, filename: chunk.filename, sourceId } };
        } catch (reason) {
          return { status: 'rejected', reason };
        }
      })(),
  );

  return Promise.all(partPromises);
}

export const uploadQueue = new SequentialUploadQueue();