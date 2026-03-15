import { Injectable } from '@nestjs/common';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAP_KEY = (c: string, a: string, u: string) => `${c}:${a}:${u}`;

interface TitleEntry {
  title: string;
  expires: number;
}

/**
 * In-memory store for SproutVideo video titles (dev and production).
 * Keyed by (courseId, assignmentId, userId). Set at submit; used by teacher viewer
 * to look up video by title in folder when submission body doesn't contain it.
 */
@Injectable()
export class PromptVideoTitleStore {
  private readonly store = new Map<string, TitleEntry>();

  set(courseId: string, assignmentId: string, userId: string, title: string): void {
    const key = MAP_KEY(courseId, assignmentId, userId);
    this.store.set(key, { title, expires: Date.now() + TTL_MS });
  }

  get(courseId: string, assignmentId: string, userId: string): string | null {
    const key = MAP_KEY(courseId, assignmentId, userId);
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return null;
    }
    return entry.title;
  }
}
