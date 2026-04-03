# Deck-Based Prompts Implementation Plan

## Overview

This feature enables ASL assessment using flashcard decks as the source of words. The student sees an English word on screen and expresses it in ASL while being recorded. **No videos are played** — the flashcard decks serve only as the source of words, and SproutVideo metadata provides timing for each word.

## Completed: Part 1 — Data Model Changes

### Files Modified

1. **`apps/api/src/prompt/dto/prompt-config.dto.ts`**
   - Added `VideoPromptConfig` interface
   - Extended `PromptConfigJson` with `promptMode` and `videoPromptConfig`
   - Extended `PutPromptConfigDto` with the same fields

2. **`apps/api/src/prompt/prompt.service.ts`**
   - Updated `putConfig()` to handle new fields
   - Updated `getConfig()` to default `promptMode` to `'text'` for backward compatibility

### Data Model

```typescript
interface VideoPromptConfig {
  selectedDecks: Array<{ id: string; title: string }>;
  totalCards: number;
}

interface PromptConfigJson {
  // ... all existing fields ...
  promptMode?: 'text' | 'decks'; // defaults to 'text' if absent
  videoPromptConfig?: VideoPromptConfig;
}
```

---

## Remaining Parts

### Part 2 — Prompt Selection Algorithm
- Fetch all cards from selected decks
- Deduplicate within each deck by English title (case-insensitive)
- Shuffle each deck randomly
- Select cards in round-robin order across decks
- Skip duplicates (if title already in prompt list)
- Stop when `totalCards` reached OR all decks exhausted
- Show warning if can't reach `totalCards`
- Final shuffle of selected prompts

### Part 3 — Timing Model
- `totalPromptTime = 1.5s + videoDuration`
- Fetch video duration from SproutVideo API
- Fallback: 3 seconds if duration unavailable
- Pre-fetch ALL durations before session starts

### Part 4 — Recording Architecture
- ONE continuous recording for entire session
- Timestamp each word appearance
- Store timestamps for teacher navigation during grading
- Clear transition signal between words

### Part 5 — Teacher Configuration UI
- Add "Deck Prompts" section to TeacherConfigPage
- Prompt mode selector (Text/Decks)
- Flashcard deck hierarchy selector (units → sections → decks)
- Total cards input
- Estimated session length preview

### Part 6 — Student Experience
- Extend TimerPage for decks mode
- Show English word with timing
- Transition signals between words
- Text mode completely unchanged
- No video playback — words only