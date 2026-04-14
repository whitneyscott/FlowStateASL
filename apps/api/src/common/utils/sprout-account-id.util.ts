import type { ConfigService } from '@nestjs/config';

/**
 * Canonical Sprout account id accessor.
 * Keep behavior aligned with existing flashcards path (raw env value, no trimming).
 */
export function getSproutAccountId(config: ConfigService): string | undefined {
  return config.get<string>('SPROUT_ACCOUNT_ID') ?? undefined;
}
