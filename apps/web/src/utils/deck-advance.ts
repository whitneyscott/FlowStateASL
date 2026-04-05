/**
 * Deck index rules shared with FlashcardsPage study flow (see recordScore).
 * Convention: valid indices are 0 .. deckLength-1; "last card" means no further advance.
 */

export function isLastDeckCard(currentIndex: number, deckLength: number): boolean {
  return deckLength <= 0 || currentIndex + 1 >= deckLength;
}

/** Index after advancing one card, or undefined if already on the last card (do not increment). */
export function nextDeckIndexAfterAdvance(currentIndex: number, deckLength: number): number | undefined {
  if (isLastDeckCard(currentIndex, deckLength)) return undefined;
  return currentIndex + 1;
}
