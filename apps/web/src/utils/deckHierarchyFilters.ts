/**
 * Client-side curriculum → unit → section → deck filtering (same order as FlashcardsPage hub).
 * Use with playlists from GET /api/flashcard/student-playlists-batch (hierarchy rows).
 */
export type PlaylistWithHierarchy = {
  id: string;
  title: string;
  curriculum: string;
  unit: string;
  section: string;
};

/** @param baseList Starting set (e.g. full catalog or already narrowed by course “current/additional” mode). */
export function computeDeckHubFilters(
  baseList: PlaylistWithHierarchy[],
  hubSelectedCurricula: string[],
  hubSelectedUnits: string[],
  hubSelectedSections: string[],
): {
  hubCurricula: string[];
  hubUnits: string[];
  hubSections: string[];
  filteredPlaylists: Array<{ id: string; title: string }>;
} {
  let list = baseList;
  const curricula = [...new Set(list.map((p) => p.curriculum).filter(Boolean))].sort();
  if (hubSelectedCurricula.length > 0) {
    list = list.filter((p) => hubSelectedCurricula.includes(p.curriculum));
  }
  const units = [...new Set(list.map((p) => p.unit).filter(Boolean))].sort();
  const sections =
    hubSelectedUnits.length > 0
      ? [
          ...new Set(
            list.filter((p) => hubSelectedUnits.includes(p.unit)).map((p) => p.section).filter(Boolean),
          ),
        ].sort()
      : [...new Set(list.map((p) => p.section).filter(Boolean))].sort();
  if (hubSelectedUnits.length > 0) {
    list = list.filter((p) => hubSelectedUnits.includes(p.unit));
  }
  if (hubSelectedSections.length > 0) {
    list = list.filter((p) => hubSelectedSections.includes(p.section));
  }
  return {
    hubCurricula: curricula,
    hubUnits: units,
    hubSections: sections,
    filteredPlaylists: list.sort((a, b) => a.title.localeCompare(b.title)).map((p) => ({ id: p.id, title: p.title })),
  };
}
