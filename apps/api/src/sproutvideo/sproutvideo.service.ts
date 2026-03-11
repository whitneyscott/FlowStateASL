import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  SproutPlaylist,
  SproutPlaylistListItem,
} from './interfaces/sprout-playlist.interface';

const BLACKLIST = [
  'exam',
  'test',
  'sentence',
  'FS',
  'FS2',
  'FSA',
  'FSB',
  'MP',
  'SE',
  'SNT',
  'unknown',
];

@Injectable()
export class SproutVideoService {
  constructor(private readonly config: ConfigService) {}

  private async delay(ms: number): Promise<void> {
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  getSmartVersions(input: string): string[] {
    const match = input.match(/^([A-Z]+)[.\s]+([\d.]+)$/i);
    if (match) {
      const prefix = match[1].toUpperCase();
      const numericPart = match[2];
      const parts = numericPart.split('.');
      const dotVersion = prefix + '.' + parts.join('.');
      const spaceVersion = prefix + ' ' + parts.join(' ');
      const mixedVersion = prefix + ' ' + parts.join('.');
      return [...new Set([dotVersion, spaceVersion, mixedVersion])];
    }
    if (/^[A-Z]{2,}/i.test(input)) {
      return [input];
    }
    return [];
  }

  /** Case-insensitive exact match against blacklisted curricula. */
  isBlacklisted(curriculum: string): boolean {
    const normalized = (curriculum ?? '').trim().toLowerCase();
    if (!normalized) return false;
    return BLACKLIST.some((term) => term.toLowerCase() === normalized);
  }

  /**
   * Lists all videos in a playlist using the playlist filter endpoint.
   * This is significantly cheaper than fetching each video by ID individually.
   */
  async fetchVideosByPlaylistId(
    playlistId: string,
  ): Promise<Array<{ id: string; title: string; embed_code: string }>> {
    const apiKey = this.config.get('SPROUT_KEY');
    if (!apiKey) throw new Error('SproutVideo not configured');

    const all: Array<{ id: string; title: string; embed_code: string }> = [];
    const perPage = 100;
    let page = 1;
    const baseDelay = (() => {
      const raw = this.config.get<string>('SPROUTVIDEO_VIDEO_FETCH_DELAY_MS');
      const parsed = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300;
    })();
    let dynamicDelay = baseDelay;
    const threshold429 = (() => {
      const raw = this.config.get<string>('SPROUTVIDEO_429_THRESHOLD');
      const parsed = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(parsed) && parsed >= 1 ? parsed : 5;
    })();
    const window429Ms = (() => {
      const raw = this.config.get<string>('SPROUTVIDEO_429_WINDOW_MS');
      const parsed = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 60_000;
    })();
    const timestamps429: number[] = [];

    while (true) {
      const url = `https://api.sproutvideo.com/v1/videos?playlist_id=${encodeURIComponent(playlistId)}&per_page=${perPage}&page=${page}`;
      const maxRetries = 5;
      let backoff = dynamicDelay;
      let res: Response | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          res = await fetch(url, {
            headers: { 'SproutVideo-Api-Key': apiKey },
          });
        } catch (err) {
          if (attempt === maxRetries) throw err;
          await this.delay(backoff);
          backoff *= 2;
          continue;
        }

        if (res.ok) break;
        const isRetryable = res.status === 429 || (res.status >= 500 && res.status < 600);
        if (!isRetryable || attempt === maxRetries) {
          throw new Error(`SproutVideo API error: ${res.status}`);
        }
        if (res.status === 429) {
          const now = Date.now();
          timestamps429.push(now);
          const cutoff = now - window429Ms;
          while (timestamps429.length > 0 && timestamps429[0] < cutoff) timestamps429.shift();
          if (timestamps429.length >= threshold429) {
            dynamicDelay = Math.min(dynamicDelay * 2, 2000);
          }
        }

        let waitMs = backoff;
        const retryAfter = res.headers.get('Retry-After');
        if (retryAfter) {
          const retrySeconds = parseInt(retryAfter, 10);
          if (Number.isFinite(retrySeconds) && retrySeconds > 0) {
            waitMs = retrySeconds * 1000;
          }
        }
        await this.delay(waitMs);
        backoff *= 2;
      }

      if (!res || !res.ok) throw new Error('SproutVideo API error while listing videos');
      const data = (await res.json()) as {
        videos?: Array<{ id?: string; title?: string; embed_code?: string }>;
        total?: number;
        next_page?: string | null;
      };

      const videos = data.videos ?? [];
      for (const v of videos) {
        if (!v.id) continue;
        all.push({
          id: String(v.id),
          title: String(v.title ?? 'Vocabulary Item'),
          embed_code: String(v.embed_code ?? ''),
        });
      }

      if (typeof data.total === 'number' && page * perPage >= data.total) break;
      if (!data.next_page && videos.length < perPage) break;

      page++;
      await this.delay(dynamicDelay);
    }

    return all;
  }

  /**
   * Fetch playlists ordered by updated_at desc. If lastSyncAt is set, only returns
   * playlists with updated_at > lastSyncAt (incremental sync). Stops paginating
   * when we hit playlists older than lastSyncAt to minimize API calls.
   */
  async fetchPlaylistsUpdatedSince(lastSyncAt: Date | null): Promise<SproutPlaylist[]> {
    const apiKey = this.config.get('SPROUT_KEY');
    if (!apiKey) throw new Error('SproutVideo not configured');
    const all: SproutPlaylist[] = [];
    let page = 1;
    const perPage = 100;
    const lastMs = lastSyncAt ? lastSyncAt.getTime() : null;

    while (true) {
      const url = `https://api.sproutvideo.com/v1/playlists?order_by=updated_at&order_dir=desc&per_page=${perPage}&page=${page}`;
      const res = await fetch(url, {
        headers: { 'SproutVideo-Api-Key': apiKey },
      });
      if (!res.ok) throw new Error(`SproutVideo API error: ${res.status}`);
      const data = (await res.json()) as {
        playlists?: Array<{
          id: string;
          title: string;
          videos?: string[];
          updated_at?: string;
        }>;
      };
      const playlists = data.playlists ?? [];

      for (const p of playlists) {
        const updatedAt = typeof p.updated_at === 'string' ? p.updated_at : undefined;
        if (lastMs !== null && updatedAt) {
          const pMs = new Date(updatedAt).getTime();
          if (pMs <= lastMs) return all;
        }
        all.push({
          id: String(p.id),
          title: String(p.title ?? ''),
          videos: Array.isArray(p.videos) ? p.videos.map(String) : [],
          updated_at: updatedAt,
        });
      }

      if (playlists.length < perPage) break;
      page++;
    }
    return all;
  }

  filterPlaylists(
    playlists: SproutPlaylist[],
    searchTerms: string[],
  ): SproutPlaylistListItem[] {
    const result: SproutPlaylistListItem[] = [];
    for (const p of playlists) {
      const title = String(p.title ?? '');
      if (this.isBlacklisted(title)) continue;
      for (const term of searchTerms) {
        if (title.toLowerCase().startsWith(term.toLowerCase())) {
          result.push({ title, id: String(p.id) });
          break;
        }
      }
    }
    return result;
  }
}
