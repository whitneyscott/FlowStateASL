import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type JobState = 'queued' | 'running' | 'completed' | 'failed';

interface QueueJob<T> {
  id: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  enqueuedAt: number;
}

interface IdempotencyRecord<T> {
  state: JobState;
  updatedAt: number;
  expiresAt: number;
  result?: T;
  error?: string;
}

@Injectable()
export class UploadResilienceService {
  private readonly queue: Array<QueueJob<unknown>> = [];
  private readonly idempotency = new Map<string, IdempotencyRecord<unknown>>();
  private active = 0;

  constructor(private readonly config: ConfigService) {}

  get maxConcurrent(): number {
    return this.getInt('UPLOAD_MAX_CONCURRENT', 2, 1, 20);
  }

  get maxQueueDepth(): number {
    return this.getInt('UPLOAD_QUEUE_MAX_DEPTH', 20, 1, 500);
  }

  get maxFileBytes(): number {
    return this.getInt('UPLOAD_MAX_FILE_BYTES', 80 * 1024 * 1024, 1, 2 * 1024 * 1024 * 1024);
  }

  get maxRssBytes(): number {
    return this.getInt('UPLOAD_MAX_RSS_BYTES', 1200 * 1024 * 1024, 64 * 1024 * 1024, 64 * 1024 * 1024 * 1024);
  }

  private get idempotencyTtlMs(): number {
    return this.getInt('UPLOAD_IDEMPOTENCY_TTL_MS', 20 * 60 * 1000, 30 * 1000, 24 * 60 * 60 * 1000);
  }

  private getInt(key: string, fallback: number, min: number, max: number): number {
    const raw = this.config.get<string>(key);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  queueDepth(): number {
    return this.queue.length;
  }

  isMemoryPressured(): boolean {
    const rss = process.memoryUsage().rss;
    return rss >= this.maxRssBytes;
  }

  assertFileSizeOrThrow(sizeBytes: number): void {
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return;
    if (sizeBytes > this.maxFileBytes) {
      const mb = Math.round(this.maxFileBytes / (1024 * 1024));
      throw new Error(`UPLOAD_TOO_LARGE: video exceeds ${mb} MB limit.`);
    }
  }

  getIdempotentResult<T>(key: string): { state: JobState; result?: T; error?: string } | null {
    this.gc();
    const rec = this.idempotency.get(key);
    if (!rec) return null;
    return { state: rec.state, result: rec.result as T | undefined, error: rec.error };
  }

  markInProgress(key: string): void {
    this.gc();
    this.idempotency.set(key, {
      state: 'running',
      updatedAt: Date.now(),
      expiresAt: Date.now() + this.idempotencyTtlMs,
    });
  }

  markCompleted<T>(key: string, result: T): void {
    this.idempotency.set(key, {
      state: 'completed',
      updatedAt: Date.now(),
      expiresAt: Date.now() + this.idempotencyTtlMs,
      result,
    });
  }

  markFailed(key: string, error: unknown): void {
    this.idempotency.set(key, {
      state: 'failed',
      updatedAt: Date.now(),
      expiresAt: Date.now() + this.idempotencyTtlMs,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  async enqueue<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.isMemoryPressured() && this.queue.length >= Math.floor(this.maxQueueDepth / 2)) {
      throw new Error('MEMORY_PRESSURE: queue throttled while memory is constrained.');
    }
    if (this.queue.length >= this.maxQueueDepth) {
      throw new Error('QUEUE_FULL: server busy, please try again in 30 seconds.');
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id,
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
      });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active += 1;
      void job
        .run()
        .then((value) => job.resolve(value))
        .catch((err) => job.reject(err))
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, v] of this.idempotency.entries()) {
      if (v.expiresAt <= now) this.idempotency.delete(k);
    }
  }
}

