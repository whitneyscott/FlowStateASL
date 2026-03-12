import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';

const TTL_MS = 15 * 60 * 1000; // 15 minutes

interface StoredFile {
  buffer: Buffer;
  contentType: string;
  expires: number;
}

@Injectable()
export class LtiDeepLinkFileStore {
  private readonly store = new Map<string, StoredFile>();

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
}
