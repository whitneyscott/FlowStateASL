/** Bottom-anchored opaque mask over the stimulus frame (teacher-configured only). */
export interface YoutubeSubtitleMask {
  enabled: boolean;
  /** Percent of frame height [5, 30], default 15. */
  heightPercent: number;
}

/** Persisted YouTube stimulus (normalized id only — never a raw URL). */
export interface YoutubePromptConfig {
  videoId: string;
  label?: string;
  /** Inclusive start of the clip segment (seconds from video start). */
  clipStartSec: number;
  /** Exclusive end for YouTube embed `end` param (seconds); must be > clipStartSec. */
  clipEndSec: number;
  /** When true, students get an app control to turn captions on (IFrame API). Default false. */
  allowStudentCaptions?: boolean;
  subtitleMask?: YoutubeSubtitleMask;
}

export interface VideoPromptConfig {
  selectedDecks: Array<{ id: string; title: string }>;
  totalCards: number;
  /**
   * Pre-generated randomized prompt banks (live generation fallback).
   */
  storedPromptBanks?: Array<Array<{ title: string; videoId?: string; duration: number }>>;
  /**
   * Final fallback when both live generation and stored banks fail.
   */
  staticFallbackPrompts?: string[];
}

export interface PromptConfigJson {
  /**
   * Set only on GET config responses: Canvas assignment id used for submissions,
   * after resolving from Prompt Manager Settings (map, module, single config, etc.).
   * Not persisted in the settings blob; clients use for ?assignmentId= and logging.
   */
  resolvedAssignmentId?: string;
  minutes?: number;
  prompts?: string[];
  accessCode?: string;
  assignmentName?: string;
  assignmentGroupId?: string;
  moduleId?: string;
  pointsPossible?: number;
  rubricId?: string;
  instructions?: string;
  dueAt?: string;
  unlockAt?: string;
  lockAt?: string;
  allowedAttempts?: number;
  version?: string;
  
  // NEW: Deck-based prompts from flashcard decks
  promptMode?: 'text' | 'decks' | 'youtube'; // defaults to 'text' if absent
  videoPromptConfig?: VideoPromptConfig;
  youtubePromptConfig?: YoutubePromptConfig;
}

export class PutPromptConfigDto {
  minutes?: number;
  prompts?: string[];
  accessCode?: string;
  assignmentName?: string;
  assignmentGroupId?: string;
  newGroupName?: string;
  moduleId?: string;
  pointsPossible?: number;
  rubricId?: string;
  instructions?: string;
  dueAt?: string;
  unlockAt?: string;
  lockAt?: string;
  allowedAttempts?: number;
  version?: string;
  
  // NEW: Deck-based prompts from flashcard decks
  promptMode?: 'text' | 'decks' | 'youtube';
  videoPromptConfig?: {
    selectedDecks?: Array<{ id?: string; title?: string }>;
    totalCards?: number;
    storedPromptBanks?: Array<Array<{ title?: string; videoId?: string; duration?: number }>>;
    staticFallbackPrompts?: string[];
  };
  /** Teacher may send urlOrId or videoId for normalization; persisted shape is YoutubePromptConfig only. */
  youtubePromptConfig?: {
    urlOrId?: string;
    videoId?: string;
    label?: string;
    clipStartSec?: number;
    clipEndSec?: number;
    /** @deprecated Use clipStartSec + clipEndSec; server migrates on read/write. */
    durationSec?: number;
    allowStudentCaptions?: boolean;
    subtitleMask?: { enabled?: boolean; heightPercent?: number };
  };
}
