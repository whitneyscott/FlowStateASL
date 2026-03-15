import { Injectable } from '@nestjs/common';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAP_KEY = (c: string, a: string, u: string) => `${c}:${a}:${u}`;

interface FallbackEntry {
  embedUrl: string;
  expires: number;
}

/**
 * In-memory store for SproutVideo fallback embed URLs (dev only).
 * Keyed by (courseId, assignmentId, userId). Used when in-memory video is gone (expired/restart).
 */
@Injectable()
export class PromptFallbackStore {
  private readonly store = new Map<string, FallbackEntry>();

  set(courseId: string, assignmentId: string, userId: string, embedUrl: string): void {
    const key = MAP_KEY(courseId, assignmentId, userId);
    this.store.set(key, { embedUrl, expires: Date.now() + TTL_MS });
  }

  get(courseId: string, assignmentId: string, userId: string): string | null {
    const key = MAP_KEY(courseId, assignmentId, userId);
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return null;
    }
    return entry.embedUrl;
  }
}
