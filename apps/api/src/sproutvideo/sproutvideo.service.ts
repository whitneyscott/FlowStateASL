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

  /** Blacklist terms for SQL exact NOT match: WHERE curriculum != ALL($1). */
  getBlacklistForSql(): string[] {
    return [...BLACKLIST];
  }

  /**
   * Lists all videos in a playlist using the playlist filter endpoint.
   * This is significantly cheaper than fetching each video by ID individually.
   */
  async fetchVideosByPlaylistId(
    playlistId: string,
  ): Promise<
    Array<{ id: string; title: string; embed_code: string; durationSeconds: number | null }>
  > {
    const apiKey = this.config.get('SPROUT_KEY');
    if (!apiKey) throw new Error('SproutVideo not configured');

    const all: Array<{
      id: string;
      title: string;
      embed_code: string;
      durationSeconds: number | null;
    }> = [];
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
        videos?: Array<{
          id?: string;
          title?: string;
          embed_code?: string;
          duration?: number | null;
          length?: number | null;
        }>;
        total?: number;
        next_page?: string | null;
      };

      const videos = data.videos ?? [];
      for (const v of videos) {
        if (!v.id) continue;
        const raw =
          typeof v.duration === 'number' && Number.isFinite(v.duration) && v.duration > 0
            ? v.duration
            : typeof v.length === 'number' && Number.isFinite(v.length) && v.length > 0
              ? v.length
              : null;
        all.push({
          id: String(v.id),
          title: String(v.title ?? 'Vocabulary Item'),
          embed_code: String(v.embed_code ?? ''),
          durationSeconds: raw,
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

  /**
   * Find a folder by name. Lists folders (paginated) and returns the id of the first match, or null.
   * Uses case-insensitive match. Follows next_page until the folder is found or all pages are exhausted.
   */
  async findFolderByName(name: string): Promise<string | null> {
    const apiKey = this.config.get('SPROUT_KEY');
    if (!apiKey) return null;
    const trimmed = (name ?? '').trim();
    if (!trimmed) return null;
    const targetLower = trimmed.toLowerCase();
    let url: string | null = `https://api.sproutvideo.com/v1/folders?per_page=100&page=1`;
    const headers = { 'SproutVideo-Api-Key': apiKey };
    while (url) {
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        folders?: Array<{ id?: string; name?: string }>;
        next_page?: string | null;
        total?: number;
      };
      const folders = data.folders ?? [];
      const found = folders.find((f) => (f.name ?? '').trim().toLowerCase() === targetLower);
      if (found?.id) return String(found.id);
      url = (data.next_page ?? '').trim() || null;
    }
    return null;
  }

  /**
   * List videos in a folder (paginated). Returns id, title, embedUrl for each.
   */
  async listVideosByFolderId(folderId: string): Promise<Array<{ id: string; title: string; embedUrl: string }>> {
    const apiKey = this.config.get('SPROUT_KEY');
    if (!apiKey) return [];
    const out: Array<{ id: string; title: string; embedUrl: string }> = [];
    let url: string | null = `https://api.sproutvideo.com/v1/videos?folder_id=${encodeURIComponent(folderId)}&per_page=100&page=1`;
    const headers = { 'SproutVideo-Api-Key': apiKey };
    while (url) {
      const res = await fetch(url, { headers });
      if (!res.ok) break;
      const data = (await res.json()) as {
        videos?: Array<{ id?: string; title?: string; security_token?: string; embed_code?: string }>;
        next_page?: string | null;
      };
      const videos = data.videos ?? [];
      for (const v of videos) {
        const id = v.id ?? '';
        if (!id) continue;
        const securityToken = v.security_token ?? '';
        const embedUrl =
          securityToken
            ? `https://videos.sproutvideo.com/embed/${id}/${securityToken}`
            : (v.embed_code?.match(/src='([^']+)'/) ?? [])[1] ?? `https://videos.sproutvideo.com/embed/${id}`;
        out.push({ id, title: (v.title ?? '').trim(), embedUrl });
      }
      url = (data.next_page ?? '').trim() || null;
    }
    return out;
  }

  /**
   * Find a video by exact title in a folder. Uses folder id to list folder contents (no global
   * title search); then matches title in that list. Case-insensitive match.
   */
  async findVideoByTitleInFolder(
    folderId: string,
    title: string,
  ): Promise<{ id: string; embedUrl: string } | null> {
    const trimmed = (title ?? '').trim();
    if (!trimmed) return null;
    const targetLower = trimmed.toLowerCase();
    const videos = await this.listVideosByFolderId(folderId);
    const found = videos.find((v) => (v.title ?? '').trim().toLowerCase() === targetLower);
    return found ? { id: found.id, embedUrl: found.embedUrl } : null;
  }

  /**
   * Create a folder in SproutVideo (e.g. "PromptSubmissions" for dev fallback uploads).
   * Returns the folder id.
   */
  async createFolder(name: string): Promise<string> {
    const apiKey = this.config.get('SPROUT_KEY');
    if (!apiKey) throw new Error('SproutVideo not configured');
    const res = await fetch('https://api.sproutvideo.com/v1/folders', {
      method: 'POST',
      headers: {
        'SproutVideo-Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SproutVideo createFolder failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { id?: string };
    const id = data?.id ?? '';
    if (!id) throw new Error('SproutVideo createFolder returned no id');
    return String(id);
  }

  /**
   * Get video details including duration for a list of video IDs (Sprout `duration` field, seconds).
   * Returns a map of video ID to duration in seconds.
   */
  async getVideoDurations(videoIds: string[]): Promise<Map<string, number>> {
    const apiKey = this.config.get('SPROUT_KEY');
    if (!apiKey || videoIds.length === 0) return new Map();

    const result = new Map<string, number>();
    const perPage = 100;
    const baseDelay = (() => {
      const raw = this.config.get<string>('SPROUTVIDEO_VIDEO_FETCH_DELAY_MS');
      const parsed = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300;
    })();

    // Fetch videos in batches using the videos endpoint with ids filter
    for (let i = 0; i < videoIds.length; i += perPage) {
      const batch = videoIds.slice(i, i + perPage);
      const idsParam = batch.map(id => `id=${encodeURIComponent(id)}`).join('&');
      const url = `https://api.sproutvideo.com/v1/videos?${idsParam}`;

      let res: Response | null = null;
      const maxRetries = 3;
      let backoff = baseDelay;

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
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          if (attempt === maxRetries) throw new Error(`SproutVideo API error: ${res.status}`);
          const retryAfter = res.headers.get('Retry-After');
          const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : backoff;
          await this.delay(waitMs);
          backoff *= 2;
          continue;
        }
        throw new Error(`SproutVideo API error: ${res.status}`);
      }

      if (!res || !res.ok) continue;

      const data = (await res.json()) as {
        videos?: Array<{ id?: string; duration?: number | null; length?: number | null }>;
      };

      const videos = data.videos ?? [];
      for (const v of videos) {
        if (!v.id) continue;
        const raw =
          typeof v.duration === 'number' && Number.isFinite(v.duration) && v.duration > 0
            ? v.duration
            : typeof v.length === 'number' && Number.isFinite(v.length) && v.length > 0
              ? v.length
              : null;
        if (raw != null) {
          result.set(String(v.id), raw);
        }
      }

      await this.delay(baseDelay);
    }

    return result;
  }

  /**
   * Upload a video to SproutVideo (multipart/form-data). Optional folder_id for organization.
   * Returns the video id, security_token, and embed URL for use as fallback link.
   */
  async uploadVideo(
    buffer: Buffer,
    filename: string,
    options?: { folderId?: string; title?: string },
  ): Promise<{ id: string; embedUrl: string }> {
    const apiKey = this.config.get('SPROUT_KEY');
    if (!apiKey) throw new Error('SproutVideo not configured');
    const formData = new FormData();
    formData.append('source_video', new Blob([buffer]), filename);
    const title = options?.title ?? filename;
    formData.append('title', title);
    if (options?.folderId) {
      formData.append('folder_id', options.folderId);
    }
    const res = await fetch('https://api.sproutvideo.com/v1/videos', {
      method: 'POST',
      headers: {
        'SproutVideo-Api-Key': apiKey,
      },
      body: formData,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SproutVideo uploadVideo failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as {
      id?: string;
      security_token?: string;
      embed_code?: string;
    };
    const id = data?.id ?? '';
    const securityToken = data?.security_token ?? '';
    if (!id) throw new Error('SproutVideo uploadVideo returned no id');
    const embedUrl =
      securityToken && id
        ? `https://videos.sproutvideo.com/embed/${id}/${securityToken}`
        : (data.embed_code?.match(/src='([^']+)'/) ?? [])[1] ?? '';
    return { id, embedUrl: embedUrl || `https://videos.sproutvideo.com/embed/${id}` };
  }
}
