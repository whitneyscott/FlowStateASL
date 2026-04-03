export interface VideoPromptConfig {
  selectedDecks: Array<{ id: string; title: string }>;
  totalCards: number;
}

export interface PromptConfigJson {
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
  promptMode?: 'text' | 'decks'; // defaults to 'text' if absent
  videoPromptConfig?: VideoPromptConfig;
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
  promptMode?: 'text' | 'decks';
  videoPromptConfig?: {
    selectedDecks?: Array<{ id?: string; title?: string }>;
    totalCards?: number;
  };
}
