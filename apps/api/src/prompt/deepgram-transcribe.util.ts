/**
 * Deepgram pre-recorded transcription → WebVTT (utterances when available).
 */

import { createReadStream } from 'node:fs';
import { DeepgramClient } from '@deepgram/sdk';

function formatVttTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(milli, 3)}`;
}

export function deepgramJsonToWebVtt(json: unknown): string {
  const root = json as {
    results?: {
      utterances?: Array<{ start: number; end: number; transcript?: string }>;
      channels?: Array<{
        alternatives?: Array<{
          transcript?: string;
          words?: Array<{ word?: string; start?: number; end?: number }>;
        }>;
      }>;
    };
  };
  const utterances = root.results?.utterances;
  if (Array.isArray(utterances) && utterances.length > 0) {
    let vtt = 'WEBVTT\n\n';
    let n = 1;
    for (const u of utterances) {
      const start = Number(u.start);
      const end = Number(u.end);
      const text = String(u.transcript ?? '').trim();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      vtt += `${n++}\n`;
      vtt += `${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}\n`;
      vtt += `${text || '(inaudible)'}\n\n`;
    }
    return vtt.trimEnd() ? vtt : 'WEBVTT\n\n';
  }

  const words =
    root.results?.channels?.[0]?.alternatives?.[0]?.words?.filter(
      (w) => w && typeof w.word === 'string' && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end)),
    ) ?? [];
  if (words.length === 0) {
    const flat = root.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
    if (flat) {
      return `WEBVTT\n\n1\n${formatVttTimestamp(0)} --> ${formatVttTimestamp(5)}\n${flat}\n`;
    }
    return 'WEBVTT\n\n';
  }

  let vtt = 'WEBVTT\n\n';
  let cue = 1;
  let lineStart = Number(words[0].start);
  let lineEnd = Number(words[0].end);
  const parts: string[] = [String(words[0].word)];

  const flush = () => {
    if (parts.length === 0) return;
    vtt += `${cue++}\n`;
    vtt += `${formatVttTimestamp(lineStart)} --> ${formatVttTimestamp(Math.max(lineEnd, lineStart + 0.1))}\n`;
    vtt += `${parts.join(' ')}\n\n`;
    parts.length = 0;
  };

  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const ws = Number(w.start);
    const we = Number(w.end);
    if (ws - lineEnd > 1.5) {
      flush();
      lineStart = ws;
      lineEnd = we;
      parts.push(String(w.word));
    } else {
      parts.push(String(w.word));
      lineEnd = we;
    }
  }
  flush();
  return vtt;
}

function deepgramErrorToHttpStyle(err: unknown): Error {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    const statusCode = Number((err as { statusCode?: number }).statusCode);
    const body = (err as { body?: unknown }).body;
    const snippet =
      typeof body === 'string'
        ? body.slice(0, 400)
        : body != null
          ? JSON.stringify(body).slice(0, 400)
          : '';
    if (Number.isFinite(statusCode)) {
      return new Error(`deepgram_http_${statusCode}: ${snippet}`);
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Stream WAV from disk to Deepgram (avoids loading the full file into memory).
 */
export async function transcribeWavFileWithDeepgram(wavPath: string, apiKey: string): Promise<{ vtt: string; raw: unknown }> {
  const key = apiKey.trim();
  if (!key) throw new Error('missing_deepgram_api_key');

  let client: DeepgramClient;
  try {
    client = new DeepgramClient({ apiKey: key });
  } catch (e) {
    console.error('[deepgram] DeepgramClient construction threw (sync)', e);
    throw e;
  }
  try {
    const response = await client.listen.v1.media.transcribeFile(createReadStream(wavPath), {
      model: 'nova-2',
      smart_format: true,
      punctuate: true,
      utterances: true,
      language: 'en',
    });
    const json: unknown =
      response && typeof response === 'object' && 'data' in response
        ? (response as { data: unknown }).data
        : response;
    return { vtt: deepgramJsonToWebVtt(json), raw: json };
  } catch (e) {
    throw deepgramErrorToHttpStyle(e);
  }
}
