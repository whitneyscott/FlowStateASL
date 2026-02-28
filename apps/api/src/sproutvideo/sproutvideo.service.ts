import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  SproutPlaylist,
  SproutPlaylistListItem,
} from './interfaces/sprout-playlist.interface';
import type { SproutVideoItem } from './interfaces/sprout-video-item.interface';

const BLACKLIST = ['exam', 'test', 'sentence'];

@Injectable()
export class SproutVideoService {
  constructor(private readonly config: ConfigService) {}

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

  isBlacklisted(title: string): boolean {
    const lower = title.toLowerCase();
    return BLACKLIST.some((term) => lower.includes(term));
  }

  async getPlaylistCount(): Promise<number> {
    const apiKey = this.config.get('SPROUT_KEY');
    if (!apiKey) return 0;
    try {
      const res = await fetch(
        'https://api.sproutvideo.com/v1/playlists?per_page=1&page=1',
        { headers: { 'SproutVideo-Api-Key': apiKey } },
      );
      if (!res.ok) return 0;
      const data = (await res.json()) as { total?: number; playlists?: unknown[] };
      if (typeof data.total === 'number') return data.total;
      return 0;
    } catch {
      return 0;
    }
  }

  async fetchAllPlaylists(): Promise<SproutPlaylist[]> {
    const apiKey = this.config.get('SPROUT_KEY');
    if (!apiKey) throw new Error('SproutVideo not configured');
    const all: SproutPlaylist[] = [];
    let page = 1;
    const perPage = 100;
    let hasMore = true;
    while (hasMore) {
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
        all.push({
          id: String(p.id),
          title: String(p.title ?? ''),
          videos: Array.isArray(p.videos) ? p.videos.map(String) : [],
          updated_at: typeof p.updated_at === 'string' ? p.updated_at : undefined,
        });
      }
      hasMore = playlists.length === perPage;
      page++;
    }
    return all;
  }

  async getPlaylists(): Promise<Array<{ id: string; title: string }>> {
    const playlists = await this.fetchAllPlaylists();
    return playlists
      .filter((p) => !this.isBlacklisted(String(p.title ?? '')))
      .map((p) => ({ id: String(p.id), title: String(p.title ?? '') }));
  }

  async getPlaylistItems(
    filter: string,
    playlistId?: string,
  ): Promise<SproutPlaylistListItem[] | SproutVideoItem[]> {
    const apiKey = this.config.get('SPROUT_KEY');
    if (!apiKey) throw new Error('SproutVideo not configured');

    if (playlistId) {
      const res = await fetch(
        `https://api.sproutvideo.com/v1/playlists/${playlistId}`,
        { headers: { 'SproutVideo-Api-Key': apiKey } },
      );
      if (!res.ok) throw new Error(`SproutVideo API error: ${res.status}`);
      const data = (await res.json()) as { videos?: string[] };
      const videoIds = data.videos ?? [];
      const items: SproutVideoItem[] = [];
      for (const vid of videoIds) {
        const vRes = await fetch(
          `https://api.sproutvideo.com/v1/videos/${vid}`,
          { headers: { 'SproutVideo-Api-Key': apiKey } },
        );
        if (!vRes.ok) continue;
        const vData = (await vRes.json()) as { title?: string; embed_code?: string };
        items.push({
          title: String(vData.title ?? 'Vocabulary Item'),
          embed: String(vData.embed_code ?? ''),
        });
      }
      return items;
    }

    const playlists = await this.fetchAllPlaylists();
    const searchTerms = this.getSmartVersions(filter);
    if (searchTerms.length === 0) return [];
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
