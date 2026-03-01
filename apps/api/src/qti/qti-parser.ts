import AdmZip from 'adm-zip';

export interface QtiVideoItem {
  videoId: string;
  title: string;
}

export interface QtiParsedPlaylist {
  playlistId: string;
  title: string;
  videos: QtiVideoItem[];
}

/**
 * Derives a URL-safe playlist ID from a zip filename.
 * Example: "FS1.03.01.FS PL - Fast_.zip" -> "qti-FS1-03-01-FS-PL-Fast"
 */
export function playlistIdFromFilename(filename: string): string {
  const base = filename.replace(/\.zip$/i, '').trim();
  const slug = base
    .replace(/[^a-zA-Z0-9.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `qti-${slug}`;
}

/**
 * Extracts SproutVideo playlist ID from assessment_meta description iframe, if present.
 */
function extractSproutPlaylistIdFromDescription(description: string): string | null {
  const m = description.match(/sproutvideo\.com\/playlist\/([a-f0-9]+)\//i);
  return m ? m[1] : null;
}

/**
 * Parses a QTI zip buffer into playlist title and video items.
 * Extracts: playlist title, video ids (item ident), video titles (varequal text).
 */
export function parseQtiZip(zipBuffer: Buffer, filename: string): QtiParsedPlaylist | null {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  let mainXmlContent: string | null = null;
  let assessmentMetaContent: string | null = null;

  for (const e of entries) {
    if (e.isDirectory) continue;
    const name = e.entryName.replace(/^[^/]+\//, '').toLowerCase();
    const content = e.getData().toString('utf8');
    if (name === 'imsmanifest.xml') {
      // Skip manifest - we get the main file path from it
      const resourceMatch = content.match(
        /<resource[^>]+type="imsqti_xmlv1p2"[^>]*>[\s\S]*?<file\s+href="([^"]+)"/i
      );
      if (resourceMatch) {
        const href = resourceMatch[1];
        for (const e2 of entries) {
          if (e2.entryName.replace(/\\/g, '/').endsWith(href.replace(/\\/g, '/'))) {
            mainXmlContent = e2.getData().toString('utf8');
            break;
          }
        }
      }
    } else if (name === 'assessment_meta.xml') {
      assessmentMetaContent = content;
    }
  }

  // Fallback: find main QTI XML by scanning for <assessment in a non-meta file
  if (!mainXmlContent) {
    for (const e of entries) {
      if (e.isDirectory) continue;
      const name = (e.entryName.split('/').pop() ?? '').toLowerCase();
      if (name === 'assessment_meta.xml') continue;
      const content = e.getData().toString('utf8');
      if (content.includes('<assessment') && content.includes('<item ')) {
        mainXmlContent = content;
        break;
      }
    }
  }

  if (!mainXmlContent) return null;

  // Playlist title: from assessment title="..." or assessment_meta <title>
  let title = '';
  const titleAttr = mainXmlContent.match(/<assessment[^>]*\s+title="([^"]*)"/);
  if (titleAttr) title = titleAttr[1].trim();
  if (!title && assessmentMetaContent) {
    const metaTitle = assessmentMetaContent.match(/<title>([^<]*)<\/title>/);
    if (metaTitle) title = metaTitle[1].trim();
  }
  if (!title) title = filename.replace(/\.zip$/i, '').trim();

  // Video ids: <item ident="hexid"
  const itemIdents: string[] = [];
  const itemRegex = /<item\s+ident="([a-f0-9]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(mainXmlContent)) !== null) {
    itemIdents.push(m[1]);
  }

  // Video titles: <varequal respident="response1">text</varequal> (one per item)
  const varequalRegex = /<varequal[^>]*>([^<]*)<\/varequal>/g;
  const varequalTexts: string[] = [];
  while ((m = varequalRegex.exec(mainXmlContent)) !== null) {
    varequalTexts.push(m[1].trim());
  }

  const videos: QtiVideoItem[] = [];
  for (let i = 0; i < itemIdents.length; i++) {
    videos.push({
      videoId: itemIdents[i],
      title: varequalTexts[i] ?? 'Vocabulary Item',
    });
  }

  // Prefer SproutVideo playlist ID from assessment_meta if present
  let playlistId = playlistIdFromFilename(filename);
  if (assessmentMetaContent) {
    const descMatch = assessmentMetaContent.match(/<description>([\s\S]*?)<\/description>/);
    if (descMatch) {
      const sproutId = extractSproutPlaylistIdFromDescription(descMatch[1]);
      if (sproutId) playlistId = sproutId;
    }
  }

  return { playlistId, title, videos };
}
