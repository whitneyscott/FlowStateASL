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

  parsePlaylistTitle(
    title: string,
  ): { curriculum: string; unit: string; section: string } {
    const parts = title.split('.').map((p) => p.trim()).filter((p) => p.length > 0);
    const curriculum = parts[0] ?? '';
    const unit = parts[1] ?? '';
    const section = parts[2] ?? '';
    return { curriculum, unit, section };
  }

  async getCurriculumHierarchy(): Promise<{
    curricula: string[];
    unitsByCurriculum: Record<string, string[]>;
    sectionsByCurriculumUnit: Record<string, string[]>;
    playlistsRetrieved: number;
  }> {
    const playlists = await this.fetchAllPlaylists();
    console.log('[SproutVideo] curriculum-hierarchy: API accessed, playlists retrieved:', playlists.length);
    const curriculaSet = new Set<string>();
    const unitsMap = new Map<string, Set<string>>();
    const sectionsMap = new Map<string, Set<string>>();

    for (const p of playlists) {
      const title = String(p.title ?? '');
      if (this.isBlacklisted(title)) continue;
      const { curriculum, unit, section } = this.parsePlaylistTitle(title);
      if (!curriculum) continue;
      curriculaSet.add(curriculum);
      if (unit) {
        const key = curriculum;
        if (!unitsMap.has(key)) unitsMap.set(key, new Set());
        unitsMap.get(key)!.add(unit);
      }
      if (unit && section) {
        const key = `${curriculum}|${unit}`;
        if (!sectionsMap.has(key)) sectionsMap.set(key, new Set());
        sectionsMap.get(key)!.add(section);
      }
    }

    const curricula = Array.from(curriculaSet).sort();
    const unitsByCurriculum: Record<string, string[]> = {};
    for (const [c, set] of unitsMap) {
      unitsByCurriculum[c] = Array.from(set).sort();
    }
    const sectionsByCurriculumUnit: Record<string, string[]> = {};
    for (const [k, set] of sectionsMap) {
      sectionsByCurriculumUnit[k] = Array.from(set).sort();
    }

    return {
      curricula,
      unitsByCurriculum,
      sectionsByCurriculumUnit,
      playlistsRetrieved: playlists.length,
    };
  }

  filterPlaylistsByHierarchy(
    playlists: SproutPlaylist[],
    curriculum: string,
    unit: string,
    section: string,
  ): SproutPlaylistListItem[] {
    const result: SproutPlaylistListItem[] = [];
    for (const p of playlists) {
      const title = String(p.title ?? '');
      if (this.isBlacklisted(title)) continue;
      const parsed = this.parsePlaylistTitle(title);
      if (parsed.curriculum !== curriculum) continue;
      if (unit && parsed.unit !== unit) continue;
      if (section && parsed.section !== section) continue;
      result.push({ title, id: String(p.id) });
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

  async fetchAllPlaylists(): Promise<SproutPlaylist[]> {
    const apiKey = this.config.get('SPROUT_KEY');
    if (!apiKey) throw new Error('SproutVideo not configured');
    const all: SproutPlaylist[] = [];
    let page = 1;
    const perPage = 100;
    let hasMore = true;
    while (hasMore && all.length < 500) {
      const url = `https://api.sproutvideo.com/v1/playlists?per_page=${perPage}&page=${page}`;
      const res = await fetch(url, {
        headers: { 'SproutVideo-Api-Key': apiKey },
      });
      if (!res.ok) throw new Error(`SproutVideo API error: ${res.status}`);
      const data = (await res.json()) as { playlists?: Array<{ id: string; title: string }> };
      const playlists = data.playlists ?? [];
      for (const p of playlists) {
        all.push({ id: String(p.id), title: String(p.title ?? '') });
      }
      hasMore = playlists.length === perPage;
      page++;
    }
    return all;
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
    return this.filterPlaylists(playlists, searchTerms);
  }
}
