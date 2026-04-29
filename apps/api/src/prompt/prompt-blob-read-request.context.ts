import { AsyncLocalStorage } from 'node:async_hooks';
import type { PromptManagerSettingsBlob } from './prompt-manager-settings-blob.storage';

/**
 * One Map per HTTP request: de-duplicates `readPromptManagerSettingsBlobFromCanvas` for the same
 * (courseId, token) within a single request. Not shared across requests.
 */
export const promptManagerBlobRequestCache = new AsyncLocalStorage<
  Map<string, Promise<PromptManagerSettingsBlob | null>>
>();
