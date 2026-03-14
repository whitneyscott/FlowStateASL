# QTI-Based Seeding Plan

This document describes the plan for seeding playlists and videos from QTI export files (zip archives).

## Overview

QTI (Question and Test Interoperability) exports from course platforms can be used as a source of playlist data. Each zip file represents one playlist; the zip contents are parsed to extract playlist metadata and video information.

## Directory and Files

| Item | Path |
|------|------|
| QTI content directory | `qtifiles/` |
| Example file | `qtifiles/FS1.03.01.FS PL - Fast_.zip` |
| Gitignore | `qtifile/` and `qtifiles/` are in `.gitignore` (QTI exports may contain course content and are not committed) |

The filename `FS1.03.01.FS PL - Fast_.zip` suggests the playlist ID can be derived (e.g. slug: `FS1-03-01`).

## Implementation Steps

### 1. Extract and Inspect the Zip

Before implementing the parser:

1. Extract the example zip and inspect the layout
2. Expected structure typically includes:
   - `imsmanifest.xml` — manifest with metadata
   - Item XML files — per-item content (video references, titles)

### 2. Identify Extraction Points

The parser must extract:

| Data | Source |
|------|--------|
| Playlist title | Description or manifest |
| Video id | Per item |
| Video title | Per item (often the "answer" in QTI) |

### 3. Implement the Seed Script

- Parser: read zip contents, extract playlist title and per-item video id/title
- Seed script: call parser for each zip in `qtifiles/`, then upsert into `sprout_playlists` and `sprout_playlist_videos` (or equivalent tables used for QTI-sourced data)

## Implementation (Done)

- **Parser**: `apps/api/src/qti/qti-parser.ts` — parses zip contents, extracts playlist title, video ids (item `ident`), and video titles (varequal text)
- **Seed script**: `apps/api/src/scripts/seed-qti.ts` — runs `npm run seed:qti`, reads `qtifiles/*.zip`, and upserts into `sprout_playlists` and `sprout_playlist_videos`

Playlist IDs: uses SproutVideo playlist ID from `assessment_meta.xml` description iframe when present; otherwise a slug from the zip filename (e.g. `qti-FS1-03-01-FS-PL-Fast`).

## Relation to Existing Seeding

See [HOWTO-SEED-DATABASE.md](HOWTO-SEED-DATABASE.md) for SproutVideo-based seeding. QTI-based seeding is an alternative/additional source when course exports are available instead of or in addition to live SproutVideo API data.
