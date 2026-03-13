import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (allow grading same/subsequent day)
const MAP_KEY = (c: string, a: string, u: string) => `${c}:${a}:${u}`;

interface StoredFile {
  buffer: Buffer;
  contentType: string;
  expires: number;
}

interface TokenMapping {
  token: string;
  expires: number;
}

@Injectable()
export class LtiDeepLinkFileStore {
  private readonly store = new Map<string, StoredFile>();
  private readonly tokenByUser = new Map<string, TokenMapping>();

  /**
   * Store a file for one-time retrieval. Returns a token to use in the deep link content item URL.
   */
  set(buffer: Buffer, contentType: string): string {
    const token = randomBytes(24).toString('hex');
    this.store.set(token, {
      buffer,
      contentType,
      expires: Date.now() + TTL_MS,
    });
    return token;
  }

  /**
   * Retrieve the file for the token without removing it. Returns null if missing or expired.
   * Use for viewing submissions multiple times.
   */
  get(token: string): { buffer: Buffer; contentType: string } | null {
    const entry = this.store.get(token);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.store.delete(token);
      return null;
    }
    return { buffer: entry.buffer, contentType: entry.contentType };
  }

  /**
   * Retrieve and remove the file for the token. Returns null if missing or expired.
   */
  consume(token: string): { buffer: Buffer; contentType: string } | null {
    const entry = this.store.get(token);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.store.delete(token);
      return null;
    }
    this.store.delete(token);
    return { buffer: entry.buffer, contentType: entry.contentType };
  }

  /**
   * Register a token for (courseId, assignmentId, userId) so getSubmissions can resolve
   * videoUrl for LTI link submissions.
   */
  registerSubmissionToken(courseId: string, assignmentId: string, userId: string, token: string): void {
    const key = MAP_KEY(courseId, assignmentId, userId);
    this.tokenByUser.set(key, { token, expires: Date.now() + TTL_MS });
  }

  /**
   * Get the submission token for a user's LTI link submission, or null if none/missing/expired.
   */
  getSubmissionToken(courseId: string, assignmentId: string, userId: string): string | null {
    const key = MAP_KEY(courseId, assignmentId, userId);
    const entry = this.tokenByUser.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.tokenByUser.delete(key);
      return null;
    }
    return entry.token;
  }
}
