import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { resolveLtiContextValue } from '../utils/lti-context';
import { TeacherSettings } from '../components/TeacherSettings';
import { ManualTokenModal } from '../components/ManualTokenModal';
import './FlashcardsPage.css';

type PlaylistItem = { title: string; id?: string };
type VideoItem = { title: string; embed?: string; id?: string };

type Mode = 'rehearsal' | 'tutorial' | 'screening';
type FirstSide = 'english' | 'asl';

interface ScoreDetail {
  term: string;
  result: 'Correct' | 'Incorrect';
  originalData: VideoItem;
}

const TEACHER_PATTERNS = ['instructor','administrator','faculty','teacher','staff','contentdeveloper','teachingassistant','ta'];

function isTeacher(roles: string): boolean {
  if (!roles || typeof roles !== 'string') return false;
  const lower = roles.toLowerCase();
  return TEACHER_PATTERNS.some((p) => lower.includes(p));
}

function segments(title: string): string[] {
  return title.split('.').map((p) => p.trim()).filter(Boolean);
}

const LAST_SESSION_KEY = (courseId: string) => `flashcards-last-${courseId}`;

interface FlashcardsPageProps {
  context: LtiContext;
}

export default function FlashcardsPage({ context }: FlashcardsPageProps) {
  const { setLastFunction, setSproutVideo, setLastApiResult, setLastApiError, setLastSubmissionDetails } = useDebug();
  const teacherMode = context && isTeacher(context.roles) && context.courseId && context.userId !== 'standalone';
  const ctxAssignmentId = resolveLtiContextValue(context?.assignmentId);
  const hasRealAssignment = !!ctxAssignmentId;
  const isCourseNavigation = !!(context?.courseId && !hasRealAssignment);
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(true);
  const [courseSettings, setCourseSettings] = useState<{ selectedCurriculums: string[]; selectedUnits: string[]; sproutAccountId?: string } | null>(null);
  const [allPlaylistsWithHierarchy, setAllPlaylistsWithHierarchy] = useState<
    Array<{ id: string; title: string; curriculum: string; unit: string; section: string }>
  >([]);
  const [hubSelectedCurricula, setHubSelectedCurricula] = useState<string[]>([]);
  const [hubSelectedUnits, setHubSelectedUnits] = useState<string[]>([]);
  const [hubSelectedSections, setHubSelectedSections] = useState<string[]>([]);
  const [hubFilterMode, setHubFilterMode] = useState<'all' | 'current' | 'additional'>('current');
  const [lastSession, setLastSession] = useState<{ unit: string } | null>(null);
  const [view, setView] = useState<'menu' | 'study' | 'results' | 'playlist'>('menu');
  const [currentPlaylist, setCurrentPlaylist] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [items, setItems] = useState<VideoItem[]>([]);
  const [originalItems, setOriginalItems] = useState<VideoItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [score, setScore] = useState({ correct: 0, total: 0, details: [] as ScoreDetail[] });
  const [showingAnswer, setShowingAnswer] = useState(false);
  const [streak, setStreak] = useState(0);
  const [benchmarkNagDismissed, setBenchmarkNagDismissed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveLog, setSaveLog] = useState<string[]>([]);
  const [deckProgress, setDeckProgress] = useState<Record<string, { completed: number }>>({});
  const [deckItemsLoading, setDeckItemsLoading] = useState(false);
  const [deckLoadError, setDeckLoadError] = useState<string | null>(null);
  const [deckTotalFromCache, setDeckTotalFromCache] = useState<number | null>(null);
  const submittedForSessionRef = useRef(false);

  const [secDisplay, setSecDisplay] = useState(3);
  const [showTimer, setShowTimer] = useState(true);
  const [shuffle, setShuffle] = useState(false);
  const [mode, setMode] = useState<Mode>('rehearsal');
  const [screeningCriteria, setScreeningCriteria] = useState(5);
  const [firstSide, setFirstSide] = useState<FirstSide>('english');
  const [playlistIndex, setPlaylistIndex] = useState(-1);
  const [canAdvance, setCanAdvance] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [replayKey, setReplayKey] = useState(0);
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoCompletedRef = useRef(false);
  const lastVideoKeyRef = useRef('');
  const [screeningOverlay, setScreeningOverlay] = useState<{
    type: 'mastery' | 'frustration';
    title: string;
    message: string;
  } | null>(null);
  const [viewAsPlaylist, setViewAsPlaylist] = useState(false);
  const [viewAsStudent, setViewAsStudent] = useState(false);
  const [singleVersionPerAnswer, setSingleVersionPerAnswer] = useState(false);
  const [tutorialAutoAdvance, setTutorialAutoAdvance] = useState(true);
  const [showManualTokenModal, setShowManualTokenModal] = useState(false);
  const [allDecksCompleteNotice, setAllDecksCompleteNotice] = useState<string | null>(null);

  const loadBatchData = useCallback(async () => {
    if (!context?.courseId) {
      setPlaylistsLoading(false);
      return;
    }
    const courseId = context.courseId;
    setPlaylistsLoading(true);
    try {
      setLastFunction('GET /api/flashcard/student-playlists-batch');
      const url = '/api/flashcard/student-playlists-batch?showHidden=1';
      const res = await fetch(url, { credentials: 'include' });
      setLastApiResult('GET /api/flashcard/student-playlists-batch', res.status, res.ok);
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data?.redirectToOAuth) {
        const returnTo = encodeURIComponent(window.location.href);
        window.location.href = `/api/oauth/canvas?returnTo=${returnTo}`;
        return;
      }
      if (res.status === 401 && data?.needsManualToken) {
        setShowManualTokenModal(true);
        setPlaylistsLoading(false);
        return;
      }
      const csState = data?.selectedCurriculums != null
        ? { selectedCurriculums: data.selectedCurriculums ?? [], selectedUnits: data.selectedUnits ?? [], sproutAccountId: data.sproutAccountId }
        : null;
      setCourseSettings(csState);
      if (data?.error === 'announcement_missing') {
        setDeckLoadError('Course materials are not yet configured. Please notify your teacher.');
      } else {
        setDeckLoadError(null);
      }
      type Pl = { id: string; title: string; curriculum: string; unit: string; section: string };
      const list: Pl[] = (Array.isArray(data?.playlists) ? data.playlists : []).map(
        (p: { id?: string; title: string; curriculum?: string; unit?: string; section?: string }) => ({
          id: String(p.id ?? p.title),
          title: String(p.title),
          curriculum: String(p.curriculum ?? ''),
          unit: String(p.unit ?? ''),
          section: String(p.section ?? ''),
        }),
      );
      setAllPlaylistsWithHierarchy(list);

      const stored = localStorage.getItem(LAST_SESSION_KEY(courseId));
      let preferredUnit = '';
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as { unit?: string };
          if (parsed?.unit) {
            preferredUnit = parsed.unit;
            setLastSession({ unit: parsed.unit });
          }
        } catch {
        }
      }

      const teacherCurricula = csState?.selectedCurriculums ?? [];
      const teacherUnits = csState?.selectedUnits ?? [];
      setHubSelectedCurricula(teacherCurricula.length > 0 ? teacherCurricula : []);
      const units: string[] = [...new Set(list.map((p: Pl) => p.unit).filter(Boolean))].sort();
      const initialUnits =
        teacherUnits.length > 0
          ? teacherUnits
          : units.length > 0
            ? (preferredUnit && units.includes(preferredUnit) ? [preferredUnit] : [units[0]])
            : [];
      setHubSelectedUnits(initialUnits);
      setHubSelectedSections([]);
    } finally {
      setPlaylistsLoading(false);
    }
  }, [context?.courseId]);

  useEffect(() => {
    const shouldLoad = teacherMode
      ? viewAsStudent && isCourseNavigation
      : !!context?.courseId;
    if (shouldLoad) {
      setPlaylistsLoading(true);
      loadBatchData();
    }
  }, [teacherMode, viewAsStudent, isCourseNavigation, context?.courseId, loadBatchData]);

  const { hubCurricula, hubUnits, hubSections, filteredPlaylists } = useMemo(() => {
    const teacherCurricula = courseSettings?.selectedCurriculums ?? [];
    const teacherUnits = courseSettings?.selectedUnits ?? [];
    let list = allPlaylistsWithHierarchy;
    if (hubFilterMode === 'current') {
      list = list.filter((p) => {
        const matchCurr = teacherCurricula.length === 0 || teacherCurricula.includes(p.curriculum);
        const matchUnit = teacherUnits.length === 0 || teacherUnits.includes(p.unit);
        return matchCurr && matchUnit;
      });
    } else if (hubFilterMode === 'additional') {
      list = teacherUnits.length > 0 ? list.filter((p) => !teacherUnits.includes(p.unit)) : [];
    }
    const curricula = [...new Set(list.map((p) => p.curriculum).filter(Boolean))].sort();
    if (hubSelectedCurricula.length > 0) {
      list = list.filter((p) => hubSelectedCurricula.includes(p.curriculum));
    }
    const units = [...new Set(list.map((p) => p.unit).filter(Boolean))].sort();
    const sections =
      hubSelectedUnits.length > 0
        ? [...new Set(list.filter((p) => hubSelectedUnits.includes(p.unit)).map((p) => p.section).filter(Boolean))].sort()
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
  }, [allPlaylistsWithHierarchy, courseSettings?.selectedCurriculums, courseSettings?.selectedUnits, hubSelectedCurricula, hubSelectedUnits, hubSelectedSections, hubFilterMode]);

  /** Decks shown in the menu / used for "Next" — must match selectPlaylist indices (students use hub filters, not `playlists`). */
  const studyDeckList = useMemo(() => {
    const useHub = !teacherMode || (teacherMode && viewAsStudent);
    return useHub ? filteredPlaylists : playlists;
  }, [teacherMode, viewAsStudent, filteredPlaylists, playlists]);

  const toggleHubCurriculum = useCallback((c: string) => {
    setHubSelectedCurricula((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
    );
  }, []);

  const toggleHubUnit = useCallback((u: string) => {
    setHubSelectedUnits((prev) =>
      prev.includes(u) ? prev.filter((x) => x !== u) : [...prev, u]
    );
  }, []);

  const toggleHubSection = useCallback((s: string) => {
    setHubSelectedSections((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  }, []);

  const handleHubFilterModeChange = useCallback((mode: 'all' | 'current' | 'additional') => {
    setHubFilterMode(mode);
    const teacherCurricula = courseSettings?.selectedCurriculums ?? [];
    const teacherUnits = courseSettings?.selectedUnits ?? [];
    if (mode === 'current' && (teacherCurricula.length > 0 || teacherUnits.length > 0)) {
      setHubSelectedCurricula(teacherCurricula);
      setHubSelectedUnits(teacherUnits);
    } else {
      setHubSelectedCurricula([]);
      setHubSelectedUnits([]);
    }
    setHubSelectedSections([]);
  }, [courseSettings?.selectedCurriculums, courseSettings?.selectedUnits]);

  useEffect(() => {
    const useHubData = teacherMode ? viewAsStudent && isCourseNavigation : !!context?.courseId;
    if (useHubData && filteredPlaylists.length > 0) {
      setSproutVideo(true, filteredPlaylists.length);
    }
  }, [teacherMode, viewAsStudent, isCourseNavigation, context?.courseId, filteredPlaylists.length, setSproutVideo]);

  const handleFilteredPlaylists = useCallback((list: Array<{ id: string; title: string }>) => {
    setPlaylistsLoading(false);
    const items = list.map((p) => ({ title: p.title, id: p.id }));
    setPlaylists(items);
    if (items.length > 0) setSproutVideo(true, items.length);
  }, []);

  const selectPlaylist = async (id: string, title: string, idx: number) => {
    setAllDecksCompleteNotice(null);
    submittedForSessionRef.current = false;
    setSaveError(null);
    setSaveLog([]);
    setCurrentPlaylist({ id, title });
    setPlaylistIndex(idx);
    setCurrentIndex(-1);
    setScore({ correct: 0, total: 0, details: [] });
    setStreak(0);
    setBenchmarkNagDismissed(false);
    setShowingAnswer(false);
    setScreeningOverlay(null);
    setDeckLoadError(null);
    const goToPlaylistView = viewAsPlaylist;
    setView(goToPlaylistView ? 'playlist' : 'study');
    setDeckTotalFromCache(null);
    const sproutAccountId = courseSettings?.sproutAccountId;
    const buildEmbed = (videoId: string) =>
      sproutAccountId
        ? `<iframe src="https://videos.sproutvideo.com/embed/${sproutAccountId}/${videoId}" class="sproutvideo-player" width="640" height="360" frameborder="0" allowfullscreen></iframe>`
        : undefined;

    setDeckItemsLoading(true);
    try {
      const res = await fetch(
        `/api/flashcard/items?playlist_id=${encodeURIComponent(id)}`,
        { credentials: 'include' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message =
          typeof data === 'object' && data !== null && 'message' in data
            ? String((data as { message?: string }).message ?? 'Deck is not available yet.')
            : 'Deck is not available yet. Please try again shortly.';
        setDeckLoadError(message);
        setItems([]);
        setOriginalItems([]);
        setDeckProgress({});
        return;
      }
      let list: VideoItem[] = Array.isArray(data) ? data : [];
      if (sproutAccountId) {
        list = list.map((it) => ({
          ...it,
          embed: it.embed || (it.id ? buildEmbed(it.id) : undefined),
        }));
      }
      if (singleVersionPerAnswer) {
        const seen = new Set<string>();
        list = list.filter((item: VideoItem) => {
          const key = (item.title || '').toLowerCase().trim();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      setOriginalItems(list);
      setItems([...list]);
      setDeckLoadError(null);
      try {
        const progRes = await fetch(
          `/api/flashcard/progress?deck_ids=${encodeURIComponent(id)}`,
          { credentials: 'include' },
        );
        const prog = (await progRes.json().catch(() => ({}))) as Record<string, { completed: number }>;
        setDeckProgress(prog);
      } catch {
        setDeckProgress({});
      }
    } catch {
      setDeckLoadError('Unable to load this deck right now. Please try again.');
      setItems([]);
      setOriginalItems([]);
      setDeckProgress({});
    } finally {
      setDeckItemsLoading(false);
    }
  };

  const startSession = () => {
    let deck = [...items];
    if (shuffle) deck.sort(() => Math.random() - 0.5);
    setItems(deck);
    setCurrentIndex(0);
    setScore((s) => ({ ...s, total: deck.length }));
    setShowingAnswer(false);
  };

  const recordScore = useCallback(
    (isCorrect: boolean) => {
      const item = items[currentIndex];
      if (!item) return;
      const newStreak = isCorrect
        ? (streak < 0 ? 1 : streak + 1)
        : streak > 0 ? -1 : streak - 1;
      setStreak(newStreak);
      const creditCorrect = isCorrect && mode !== 'tutorial';
      setScore((s) => ({
        ...s,
        correct: s.correct + (creditCorrect ? 1 : 0),
        details: [
          ...s.details,
          {
            term: item.title,
            result: isCorrect ? 'Correct' : 'Incorrect',
            originalData: item,
          },
        ],
      }));

      if (mode !== 'tutorial') {
        const remaining = items.length - (currentIndex + 1);
        const maxPossibleCorrect = score.correct + (isCorrect ? 1 : 0) + remaining;
        const maxPossiblePercent = (maxPossibleCorrect / items.length) * 100;
        if (!benchmarkNagDismissed && maxPossiblePercent < 85) {
          setScreeningOverlay({
            type: 'frustration',
            title: 'Benchmark Unattainable',
            message:
              'Even with perfect scores on remaining cards, the 85% benchmark is no longer possible for this run. Ready to switch to Tutorial mode?',
          });
          setStreak(0);
          return;
        }
        if (mode === 'screening') {
          if (newStreak >= screeningCriteria) {
            setScreeningOverlay({
              type: 'mastery',
              title: 'Mastery Achieved!',
              message: `You've gotten ${screeningCriteria} in a row. What would you like to do?`,
            });
            setStreak(0);
            return;
          }
          if (newStreak <= -screeningCriteria) {
            setScreeningOverlay({
              type: 'frustration',
              title: 'Frustration Detected',
              message: `You've missed ${screeningCriteria} in a row. Ready to try Tutorial mode?`,
            });
            setStreak(0);
            return;
          }
        }
      }

      if (currentIndex + 1 >= items.length) {
        setView('results');
      } else {
        setCurrentIndex((i) => i + 1);
        setShowingAnswer(false);
      }
    },
    [
      items,
      currentIndex,
      streak,
      mode,
      screeningCriteria,
      benchmarkNagDismissed,
      score.correct,
    ],
  );

  const revealAnswer = useCallback(() => {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    setShowingAnswer(true);
  }, []);

  useEffect(() => {
    return () => {
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    };
  }, []);

  const showRevealTimer = items[currentIndex] && firstSide === 'english' && !showingAnswer && (
    ((mode === 'rehearsal' || mode === 'screening') && showTimer && !isPaused) ||
    (mode === 'tutorial' && tutorialAutoAdvance)
  );

  useEffect(() => {
    if (!showRevealTimer) return;
    const displayMs = secDisplay * 1000;
    autoTimerRef.current = setTimeout(() => {
      revealAnswer();
    }, displayMs);
    return () => {
      if (autoTimerRef.current) {
        clearTimeout(autoTimerRef.current);
        autoTimerRef.current = null;
      }
    };
  }, [showRevealTimer, secDisplay, revealAnswer]);

  useEffect(() => {
    const item = items[currentIndex];
    if (mode !== 'tutorial' || !tutorialAutoAdvance || showingAnswer || !item) return;
    if (firstSide === 'asl' && videoCompletedRef.current) {
      revealAnswer();
    }
  }, [mode, tutorialAutoAdvance, showingAnswer, firstSide, canAdvance, items, currentIndex, revealAnswer]);

  const silentSubmitProgress = useCallback(async () => {
    if (!currentPlaylist || submittedForSessionRef.current) return;
    setSaveError(null);
    setLastSubmissionDetails(null);
    const incorrectItems = score.details
      .filter((d) => d.result === 'Incorrect')
      .map((d) => {
        const idFromEmbed = d.originalData.embed
          ? d.originalData.embed.match(/embed\/[^/]+\/([a-zA-Z0-9]+)/)?.[1] ??
            d.originalData.embed.match(/embed\/([a-zA-Z0-9]+)/)?.[1] ??
            ''
          : '';
        const videoId = String(d.originalData.id ?? idFromEmbed).trim();
        const name = String(d.originalData.title ?? d.term ?? '').trim();
        return { videoId, name };
      })
      .filter((item) => item.videoId.length > 0 && item.name.length > 0);
    const payload = {
      score: score.correct,
      scoreTotal: score.total,
      deckIds: [currentPlaylist.id],
      wordCount: 0,
      mode,
      playlistTitle: currentPlaylist.title,
      incorrectItems,
    };
    setSaveLog([
      'Sending to POST /api/submission:',
      `  deck: ${currentPlaylist.title} (${currentPlaylist.id})`,
      `  score: ${score.correct}/${score.total}, mode: ${mode}`,
    ]);
    if (context?.courseId) {
      const [,, u] = segments(currentPlaylist.title);
      if (u) {
        try {
          localStorage.setItem(LAST_SESSION_KEY(context.courseId), JSON.stringify({ unit: u }));
        } catch {
        }
      }
    }
    const endpoint = 'POST /api/submission';
    setLastFunction(endpoint);
    try {
      const res = await fetch('/api/submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        synced?: boolean;
        error?: string;
        message?: string;
        debug?: {
          progressSaved?: boolean;
          gradeSent?: boolean;
          details: string;
          canvasRequest?: {
            tokenSource: string;
            tokenPreview: string;
            submittingForUserId: string;
            as_user_idInRequest: boolean;
            note?: string;
          };
        };
      };
      const ok = res.ok && data.synced !== false;
      if (data.debug?.details) {
        let details = data.debug.details;
        if (data.debug.canvasRequest) {
          details += `\n[Canvas request debug] tokenSource=${data.debug.canvasRequest.tokenSource} | tokenPreview=${data.debug.canvasRequest.tokenPreview} | submittingForUserId=${data.debug.canvasRequest.submittingForUserId} | as_user_idInRequest=${data.debug.canvasRequest.as_user_idInRequest}${data.debug.canvasRequest.note ? ` | ${data.debug.canvasRequest.note}` : ''}`;
        }
        setLastSubmissionDetails(details);
      }

      const logLines = (prev: string[]) => [
        ...prev,
        `Response: HTTP ${res.status}, synced=${data.synced ?? '?'}`,
        ...(ok
          ? [`SUCCESS: ${data.debug?.details ?? 'Progress saved.'}`]
          : [
              `FAILED: ${data.error || data.message || `Save failed (${res.status})`}`,
              `Details: ${data.debug?.details ?? 'None'}`,
              'Check: Flashcard Progress assignment must exist and be published. Canvas OAuth required (Teacher Settings).',
            ]),
      ];
      setSaveLog(logLines);

      if (!ok) {
        setLastApiError(endpoint, res.status, data.message || data.error || `Save failed (${res.status})`);
        setSaveError(data.message || data.error || `Save failed (${res.status})`);
        submittedForSessionRef.current = false;
      } else {
        submittedForSessionRef.current = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastApiError(endpoint, 0, msg);
      setLastApiResult(endpoint, 0, false);
      setSaveError(msg);
      setSaveLog((prev) => [
        ...prev,
        `Response: network/parse error`,
        `FAILED: ${msg}`,
        'Check: Ensure you are launched from Canvas LTI and the API is reachable.',
      ]);
      submittedForSessionRef.current = false;
    }
  }, [context?.courseId, currentPlaylist, score.correct, score.total, score.details, mode, setLastFunction, setLastApiResult, setLastApiError, setLastSubmissionDetails]);

  useEffect(() => {
    if (view === 'results' && currentPlaylist) {
      silentSubmitProgress();
    }
  }, [view, currentPlaylist, silentSubmitProgress]);

  const returnToMenu = () => {
    setAllDecksCompleteNotice(null);
    setView('menu');
    setCurrentPlaylist(null);
    setItems([]);
    setCurrentIndex(-1);
    setScreeningOverlay(null);
    setDeckTotalFromCache(null);
    setDeckItemsLoading(false);
  };

  const resetCurrentDeck = () => {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    videoCompletedRef.current = false;
    lastVideoKeyRef.current = '';
    setIsPaused(false);
    setReplayKey((k) => k + 1);
    let deck = [...originalItems];
    if (shuffle) deck.sort(() => Math.random() - 0.5);
    setItems(deck);
    setCurrentIndex(-1);
    setScore({ correct: 0, total: originalItems.length, details: [] });
    setStreak(0);
    setBenchmarkNagDismissed(false);
    setShowingAnswer(false);
    setScreeningOverlay(null);
    setCanAdvance(false);
  };

  const repeatAll = () => {
    submittedForSessionRef.current = false;
    let deck = [...originalItems];
    if (shuffle) deck.sort(() => Math.random() - 0.5);
    setItems(deck);
    setCurrentIndex(0);
    setScore({ correct: 0, total: deck.length, details: [] });
    setStreak(0);
    setBenchmarkNagDismissed(false);
    setView('study');
    setShowingAnswer(false);
  };

  const retryMissed = () => {
    submittedForSessionRef.current = false;
    const missed = score.details
      .filter((d) => d.result === 'Incorrect')
      .map((d) => d.originalData);
    if (missed.length === 0) return;
    let deck = shuffle ? [...missed].sort(() => Math.random() - 0.5) : [...missed];
    setItems(deck);
    setCurrentIndex(0);
    const previouslyCorrect = originalItems.length - missed.length;
    setScore({ correct: previouslyCorrect, total: originalItems.length, details: [] });
    setStreak(0);
    setView('study');
    setShowingAnswer(false);
  };

  const loadNextUnit = () => {
    const list = studyDeckList;
    if (playlistIndex < 0 || list.length === 0) return;
    if (playlistIndex < list.length - 1) {
      const next = list[playlistIndex + 1];
      const id = next.id ?? String(playlistIndex + 1);
      selectPlaylist(id, next.title, playlistIndex + 1);
    } else {
      setAllDecksCompleteNotice(
        "You've completed all decks in your current study set. Use Back to Menu to adjust filters or choose another deck.",
      );
    }
  };

  const currentItem = items[currentIndex];
  const percentage =
    score.total > 0 ? Math.round((score.correct / score.total) * 100) : 0;
  const hasMissed = score.details.some((d) => d.result === 'Incorrect');
  const isLastDeckInStudySet =
    playlistIndex >= 0 && studyDeckList.length > 0 && playlistIndex >= studyDeckList.length - 1;

  const embedWithAutoplay = (embed: string) => {
    const srcMatch = embed.match(/src=['"]([^'"]+)['"]/);
    if (!srcMatch) return embed;
    const url = srcMatch[1];
    const sep = url.includes('?') ? '&' : '?';
    const newUrl = `${url}${sep}autoPlay=true&showControls=false`;
    return embed.replace(srcMatch[0], `src="${newUrl}"`);
  };

  const extractVideoId = (embed: string): string | null => {
    const m = embed.match(/embed\/[^/]+\/([a-zA-Z0-9]+)/);
    return m ? m[1] : embed.match(/embed\/([a-zA-Z0-9]+)/)?.[1] ?? null;
  };

  const hasVideoOnScreen = currentItem && (
    (firstSide === 'english' && showingAnswer && currentItem.embed) ||
    (firstSide === 'asl' && !showingAnswer && currentItem.embed)
  );

  const showRehearsalTimer = currentItem && firstSide === 'english' && !showingAnswer && (
    ((mode === 'rehearsal' || mode === 'screening') && showTimer && !isPaused) ||
    (mode === 'tutorial' && tutorialAutoAdvance)
  );

  useEffect(() => {
    if (!hasVideoOnScreen) {
      videoCompletedRef.current = false;
      lastVideoKeyRef.current = '';
      setCanAdvance(true);
      return;
    }
    const videoKey = `${currentIndex}-${showingAnswer}-${firstSide}-${currentItem?.embed ?? ''}`;
    if (videoKey !== lastVideoKeyRef.current) {
      lastVideoKeyRef.current = videoKey;
      videoCompletedRef.current = false;
      setCanAdvance(false);
    } else if (videoCompletedRef.current) {
      setCanAdvance(true);
    }
  }, [currentIndex, showingAnswer, firstSide, currentItem?.title, currentItem?.embed]);

  const handleVideoCompleted = useCallback(() => {
    videoCompletedRef.current = true;
    setCanAdvance(true);
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const d = e?.data;
      if (!d) return;
      const type = typeof d === 'object' && d !== null && 'type' in d ? String(d.type) : null;
      const event = typeof d === 'object' && d !== null && 'event' in d ? String(d.event) : null;
      if (type === 'completed' || type === 'ended' || event === 'completed' || event === 'ended') {
        handleVideoCompleted();
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [handleVideoCompleted]);

  useEffect(() => {
    if (!hasVideoOnScreen || (!currentItem?.embed && !currentItem?.id)) return;
    const vid = currentItem.id ?? (currentItem.embed ? extractVideoId(currentItem.embed) : null);
    if (!vid || typeof (window as unknown as { SV?: unknown }).SV === 'undefined') return;
    const t = setTimeout(() => {
      try {
        const SV = (window as unknown as { SV: { Player: new (opts: { videoId: string }) => { bind: (ev: string, fn: () => void) => void } } }).SV;
        const player = new SV.Player({ videoId: vid });
        player.bind('completed', () => handleVideoCompleted());
      } catch {
      }
    }, 100);
    return () => clearTimeout(t);
  }, [currentIndex, showingAnswer, firstSide, currentItem?.embed, handleVideoCompleted]);

  useEffect(() => {
    const item = items[currentIndex];
    if (mode !== 'tutorial' || !tutorialAutoAdvance || !showingAnswer || !item) return;
    const answerHasVideo = firstSide === 'english' && item.embed;
    if (answerHasVideo) {
      if (videoCompletedRef.current) {
        recordScore(true);
      }
      return;
    }
    const displayMs = secDisplay * 1000;
    autoTimerRef.current = setTimeout(() => recordScore(true), displayMs);
    return () => {
      if (autoTimerRef.current) {
        clearTimeout(autoTimerRef.current);
        autoTimerRef.current = null;
      }
    };
  }, [mode, tutorialAutoAdvance, showingAnswer, firstSide, canAdvance, secDisplay, items, currentIndex, recordScore]);

  return (
    <div className="flashcards-page">
      <div className="flashcards-container">
        {view === 'menu' && (
          <div className="flashcards-menu">
            {teacherMode && !viewAsStudent && (
              <TeacherSettings
                context={context}
                onConfigChange={() => {
                  if (context?.courseId && viewAsStudent) loadBatchData();
                }}
                onFilteredPlaylists={handleFilteredPlaylists}
              />
            )}
            <h1 className="flashcards-title">TWA Vocabulary</h1>
            {teacherMode && isCourseNavigation && (
              <label className="flashcards-view-as-student">
                <input
                  type="checkbox"
                  checked={viewAsStudent}
                  onChange={(e) => setViewAsStudent(e.target.checked)}
                />
                View as Student
              </label>
            )}
            {(viewAsStudent && teacherMode) || !teacherMode ? (
              <>
                {lastSession && (
                  <p className="flashcards-welcome-back">Welcome back! Last session: Unit {lastSession.unit}</p>
                )}
                {playlistsLoading ? (
                  <div className="flashcards-loading">
                    <div className="flashcards-spinner" />
                    <p>Loading units and sections...</p>
                  </div>
                ) : (
                  <>
                    {deckLoadError && (
                      <p className="flashcards-save-error" role="alert" style={{ marginBottom: 16 }}>
                        {deckLoadError}
                      </p>
                    )}
                    <div className="teacher-settings" style={{ marginBottom: 24 }}>
                      <h2>Study materials</h2>
                      <div className="teacher-settings-toggle-wrap" style={{ flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
                        <span className="teacher-settings-toggle-label">Show</span>
                        {[
                          { mode: 'current' as const, label: 'Current' },
                          { mode: 'additional' as const, label: 'Additional materials' },
                          { mode: 'all' as const, label: 'All' },
                        ].map(({ mode, label }) => (
                          <label key={mode} className="flashcards-playlist-view-toggle">
                            <input
                              type="radio"
                              name="hubFilterMode"
                              checked={hubFilterMode === mode}
                              onChange={() => handleHubFilterModeChange(mode)}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                      <hr
                        className="teacher-settings-divider"
                        style={{
                          width: '100%',
                          border: 'none',
                          borderTop: '4px solid #52525b',
                          margin: '20px 0',
                        }}
                      />
                      <div className="teacher-settings-checkbox-group" style={{ width: '100%', marginBottom: 20 }}>
                        <span className="teacher-settings-label">Curriculum</span>
                        <div className="teacher-settings-checkbox-list">
                          {hubCurricula.map((c) => (
                            <label key={c} className="teacher-settings-checkbox-label">
                              <input
                                type="checkbox"
                                checked={hubSelectedCurricula.includes(c)}
                                onChange={() => toggleHubCurriculum(c)}
                              />
                              {c}
                            </label>
                          ))}
                        </div>
                      </div>
                      <div className="teacher-settings-checkbox-group" style={{ width: '100%', marginBottom: 20 }}>
                        <span className="teacher-settings-label">Units</span>
                        <div className="teacher-settings-checkbox-list">
                          {hubUnits.map((u) => (
                            <label key={u} className="teacher-settings-checkbox-label">
                              <input
                                type="checkbox"
                                checked={hubSelectedUnits.includes(u)}
                                onChange={() => toggleHubUnit(u)}
                              />
                              {u}
                            </label>
                          ))}
                        </div>
                      </div>
                      <div className="teacher-settings-checkbox-group" style={{ width: '100%', marginBottom: 20 }}>
                        <span className="teacher-settings-label">Sections</span>
                        <div className="teacher-settings-checkbox-list">
                          {hubSections.map((s) => (
                            <label key={s} className="teacher-settings-checkbox-label">
                              <input
                                type="checkbox"
                                checked={hubSelectedSections.includes(s)}
                                onChange={() => toggleHubSection(s)}
                                disabled={hubSelectedUnits.length === 0}
                              />
                              {s}
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="flashcards-menu-toggles">
                      <label className="flashcards-playlist-view-toggle">
                        <input
                          type="checkbox"
                          checked={viewAsPlaylist}
                          onChange={(e) => setViewAsPlaylist(e.target.checked)}
                        />
                        View as Playlist
                      </label>
                      <label className="flashcards-playlist-view-toggle">
                        <input
                          type="checkbox"
                          checked={singleVersionPerAnswer}
                          onChange={(e) => setSingleVersionPerAnswer(e.target.checked)}
                        />
                        One version per answer
                      </label>
                    </div>
                    <div
                      className={
                        viewAsPlaylist
                          ? 'flashcards-playlist-list flashcards-playlist-list-compact'
                          : 'flashcards-playlist-list'
                      }
                    >
                      {filteredPlaylists.map((pl, idx) => (
                        <button
                          key={pl.id ?? idx}
                          type="button"
                          className={
                            viewAsPlaylist
                              ? 'flashcards-playlist-btn flashcards-playlist-btn-compact'
                              : 'flashcards-playlist-btn'
                          }
                          onClick={() =>
                            selectPlaylist(
                              pl.id ?? String(idx),
                              pl.title,
                              idx,
                            )
                          }
                        >
                          {viewAsPlaylist && (
                            <span className="flashcards-playlist-num">{idx + 1}</span>
                          )}
                          {pl.title}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : playlistsLoading ? (
              <div className="flashcards-loading">
                <div className="flashcards-spinner" />
                <p>Loading playlists...</p>
              </div>
            ) : (
              <>
                <div className="flashcards-menu-toggles">
                  <label className="flashcards-playlist-view-toggle">
                    <input
                      type="checkbox"
                      checked={viewAsPlaylist}
                      onChange={(e) => setViewAsPlaylist(e.target.checked)}
                    />
                    View as Playlist
                  </label>
                  <label className="flashcards-playlist-view-toggle">
                    <input
                      type="checkbox"
                      checked={singleVersionPerAnswer}
                      onChange={(e) => setSingleVersionPerAnswer(e.target.checked)}
                    />
                    One version per answer
                  </label>
                </div>
                <div
                  className={
                    viewAsPlaylist
                      ? 'flashcards-playlist-list flashcards-playlist-list-compact'
                      : 'flashcards-playlist-list'
                  }
                >
                  {playlists.map((pl, idx) => (
                    <button
                      key={(pl as { id?: string }).id ?? idx}
                      type="button"
                      className={
                        viewAsPlaylist
                          ? 'flashcards-playlist-btn flashcards-playlist-btn-compact'
                          : 'flashcards-playlist-btn'
                      }
                      onClick={() =>
                        selectPlaylist(
                          (pl as { id?: string }).id ?? String(idx),
                          pl.title,
                          idx,
                        )
                      }
                    >
                      {viewAsPlaylist && (
                        <span className="flashcards-playlist-num">{idx + 1}</span>
                      )}
                      {pl.title}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {view === 'study' && (
          <div className="flashcards-study">
            {allDecksCompleteNotice && (
              <div className="flashcards-decks-complete-notice" role="status">
                <p>{allDecksCompleteNotice}</p>
                <button
                  type="button"
                  className="flashcards-btn flashcards-btn-secondary flashcards-decks-complete-dismiss"
                  onClick={() => setAllDecksCompleteNotice(null)}
                >
                  Dismiss
                </button>
              </div>
            )}
            {currentPlaylist && (
              <h2 className="flashcards-topic-header">{currentPlaylist.title}</h2>
            )}
            <div className="flashcards-persistent-options">
              <label>
                Sec:{' '}
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={secDisplay}
                  onChange={(e) => setSecDisplay(Number(e.target.value) || 3)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={showTimer}
                  onChange={(e) => setShowTimer(e.target.checked)}
                />
                Timer
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={shuffle}
                  onChange={(e) => setShuffle(e.target.checked)}
                />
                Shuffle
              </label>
              <label>
                Mode:{' '}
                <select
                  value={mode}
                  onChange={(e) => {
                    setMode(e.target.value as Mode);
                    setStreak(0);
                  }}
                >
                  <option value="rehearsal">Rehearsal</option>
                  <option value="tutorial">Tutorial</option>
                  <option value="screening">Screening</option>
                </select>
              </label>
              {mode === 'tutorial' && (
                <label>
                  <input
                    type="checkbox"
                    checked={tutorialAutoAdvance}
                    onChange={(e) => setTutorialAutoAdvance(e.target.checked)}
                  />
                  Auto-advance
                </label>
              )}
              {mode === 'screening' && (
                <label>
                  Crit:{' '}
                  <select
                    value={screeningCriteria}
                    onChange={(e) =>
                      setScreeningCriteria(Number(e.target.value) || 5)
                    }
                  >
                    {[3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                1st:{' '}
                <select
                  value={firstSide}
                  onChange={(e) => setFirstSide(e.target.value as FirstSide)}
                >
                  <option value="english">Eng</option>
                  <option value="asl">ASL</option>
                </select>
              </label>
            </div>

            <div className="flashcards-status-bar">
              <span>
                Progress: {currentIndex < 0
                  ? `${Math.min(deckProgress[currentPlaylist?.id ?? '']?.completed ?? 0, deckTotalFromCache ?? items.length)} of ${deckTotalFromCache ?? items.length} cards`
                  : `${mode === 'tutorial' ? score.details.length : score.correct} / ${score.total || items.length}`}{' '}
                {mode === 'screening' && streak !== 0 && (
                  <span
                    className={
                      streak > 0
                        ? 'flashcards-streak-positive'
                        : 'flashcards-streak-negative'
                    }
                  >
                    Streak: {streak}
                  </span>
                )}
              </span>
              <span>
                {currentIndex < 0 ? '' : `Item ${currentIndex + 1} of ${items.length}`}
              </span>
            </div>

            <div className="flashcards-card">
              {showRehearsalTimer && (
                <div className="flashcards-timer-track">
                  <div className={`flashcards-timer-fill flashcards-timer-fill-d${Math.min(10, Math.max(1, secDisplay))}`} />
                </div>
              )}
              {screeningOverlay && (
                <div className="flashcards-screening-overlay">
                  <h2
                    className={`flashcards-overlay-title ${
                      screeningOverlay.type === 'mastery'
                        ? 'flashcards-overlay-title-mastery'
                        : 'flashcards-overlay-title-frustration'
                    }`}
                  >
                    {screeningOverlay.title}
                  </h2>
                  <p className="flashcards-overlay-msg">{screeningOverlay.message}</p>
                  <div className="flashcards-overlay-controls">
                    {screeningOverlay.type === 'mastery' ? (
                      <>
                        {isLastDeckInStudySet ? (
                          <p className="flashcards-overlay-msg flashcards-overlay-msg-spaced">
                            You&apos;ve completed all decks in your current study set. Use{' '}
                            <strong>Change Deck</strong> for more, or continue this deck below.
                          </p>
                        ) : (
                          <button
                            type="button"
                            className="flashcards-btn flashcards-btn-correct"
                            onClick={() => {
                              setScreeningOverlay(null);
                              loadNextUnit();
                            }}
                          >
                            Next Deck
                          </button>
                        )}
                        <button
                          type="button"
                          className="flashcards-btn flashcards-btn-secondary"
                          onClick={() => {
                            setScreeningOverlay(null);
                            setCurrentIndex((i) => i + 1);
                            setShowingAnswer(false);
                          }}
                        >
                          Continue Current
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="flashcards-btn flashcards-btn-incorrect"
                          onClick={() => {
                            setMode('tutorial');
                            setStreak(0);
                            setScreeningOverlay(null);
                            setCurrentIndex((i) => i + 1);
                            setShowingAnswer(false);
                          }}
                        >
                          Switch to Tutorial
                        </button>
                        <button
                          type="button"
                          className="flashcards-btn flashcards-btn-secondary"
                          onClick={() => {
                            setBenchmarkNagDismissed(true);
                            setScreeningOverlay(null);
                            setCurrentIndex((i) => i + 1);
                            setShowingAnswer(false);
                          }}
                        >
                          Keep Trying
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}

              {currentIndex < 0 ? (
                <div className="flashcards-card-content">
                  {deckItemsLoading ? (
                    <div className="flashcards-loading-spinner">
                      <div className="flashcards-loading-spinner-icon" />
                      <p>Loading deck...</p>
                    </div>
                  ) : (
                    <>
                      {deckLoadError && (
                        <p className="flashcards-save-error" role="alert">
                          {deckLoadError}
                        </p>
                      )}
                      <p className="flashcards-vocab-display">READY?</p>
                      <button
                        type="button"
                        className={`flashcards-btn flashcards-btn-flip${items.length === 0 ? ' flashcards-btn-disabled' : ''}`}
                        onClick={startSession}
                        disabled={items.length === 0}
                      >
                        Start
                      </button>
                    </>
                  )}
                </div>
              ) : currentItem ? (
                <div className="flashcards-controls flashcards-controls-col flashcards-card-content">
                  {!showingAnswer ? (
                    firstSide === 'english' ? (
                      <div className="flashcards-controls flashcards-controls-col flashcards-card-content">
                        <p className="flashcards-vocab-display">
                          {currentItem.title}
                        </p>
                        <div className="flashcards-controls">
                          {!showRehearsalTimer && !(mode === 'tutorial' && tutorialAutoAdvance) && (
                            <button
                              type="button"
                              className="flashcards-btn flashcards-btn-flip"
                              onClick={revealAnswer}
                            >
                              Show Answer
                            </button>
                          )}
                          {(mode === 'rehearsal' || mode === 'screening') && showTimer && firstSide === 'english' && !showingAnswer && (
                            <button
                              type="button"
                              className="flashcards-btn flashcards-btn-secondary"
                              onClick={() => setIsPaused((p) => !p)}
                            >
                              {isPaused ? 'Resume' : 'Pause'}
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="flashcards-controls flashcards-controls-col flashcards-card-content">
                        <div className="flashcards-video-wrap" key={replayKey}>
                          {currentItem.embed && (
                            <div
                              className="flashcards-video-wrap-inner"
                              dangerouslySetInnerHTML={{
                                __html: embedWithAutoplay(currentItem.embed),
                              }}
                            />
                          )}
                        </div>
                        <div className="flashcards-controls">
                          {!(mode === 'tutorial' && tutorialAutoAdvance) && (
                            <button
                              type="button"
                              className={`flashcards-btn flashcards-btn-flip${mode === 'tutorial' && !canAdvance ? ' flashcards-btn-disabled' : ''}`}
                              onClick={revealAnswer}
                              disabled={mode === 'tutorial' && !canAdvance}
                            >
                              Show Answer
                            </button>
                          )}
                          <button
                            type="button"
                            className="flashcards-btn flashcards-btn-secondary"
                            onClick={() => setReplayKey((k) => k + 1)}
                          >
                            Replay
                          </button>
                        </div>
                      </div>
                    )
                  ) : (
                    <div className="flashcards-controls flashcards-controls-col flashcards-card-content">
                      {firstSide === 'asl' ? (
                        <p className="flashcards-vocab-display flashcards-vocab-display-sm">
                          {currentItem.title}
                        </p>
                      ) : (
                        <div className="flashcards-controls flashcards-controls-col flashcards-card-content">
                          <div className="flashcards-video-wrap" key={`answer-${replayKey}`}>
                            {currentItem.embed && (
                              <div
                                className="flashcards-video-wrap-inner"
                                dangerouslySetInnerHTML={{
                                  __html: embedWithAutoplay(currentItem.embed),
                                }}
                              />
                            )}
                          </div>
                          <button
                            type="button"
                            className="flashcards-btn flashcards-btn-secondary"
                            onClick={() => setReplayKey((k) => k + 1)}
                          >
                            Replay
                          </button>
                        </div>
                      )}
                      {mode === 'tutorial' ? (
                        !tutorialAutoAdvance && (
                          <button
                            type="button"
                            className={`flashcards-btn flashcards-btn-correct${!canAdvance ? ' flashcards-btn-disabled' : ''}`}
                            onClick={() => canAdvance && recordScore(true)}
                            disabled={!canAdvance}
                          >
                            Next
                          </button>
                        )
                      ) : (
                        <div className="flashcards-controls">
                          <button
                            type="button"
                            className="flashcards-btn flashcards-btn-correct"
                            onClick={() => recordScore(true)}
                          >
                            Correct
                          </button>
                          <button
                            type="button"
                            className="flashcards-btn flashcards-btn-incorrect"
                            onClick={() => recordScore(false)}
                          >
                            Incorrect
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            <div className="flashcards-secondary-controls">
              <button
                type="button"
                className="flashcards-btn-nav"
                onClick={resetCurrentDeck}
              >
                Reset Deck
              </button>
              <button
                type="button"
                className="flashcards-btn-nav"
                onClick={returnToMenu}
              >
                Change Deck
              </button>
            </div>
          </div>
        )}

        {view === 'playlist' && (
          <div className="flashcards-playlist-view">
            {currentPlaylist && (
              <h2 className="flashcards-topic-header">{currentPlaylist.title}</h2>
            )}
            <div className="flashcards-playlist-view-list">
              {items.map((item, idx) => (
                <div key={idx} className="flashcards-playlist-view-item">
                  <p className="flashcards-playlist-view-title">
                    {idx + 1}. {item.title}
                  </p>
                  {item.embed && (
                    <div
                      className="flashcards-video-wrap"
                      dangerouslySetInnerHTML={{ __html: item.embed }}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="flashcards-secondary-controls">
              <button
                type="button"
                className="flashcards-btn-nav"
                onClick={returnToMenu}
              >
                Back to Menu
              </button>
            </div>
          </div>
        )}

        {view === 'results' && (
          <div className="flashcards-results">
            <h1 className="flashcards-results-title">Results</h1>
            <p className="flashcards-results-score">
              {score.correct}/{score.total} ({percentage}%)
            </p>
            <p className="flashcards-benchmark-note">Suggested minimum score: 85%</p>
            {isLastDeckInStudySet && (
              <p className="flashcards-decks-complete-inline" role="status">
                You&apos;ve finished the last deck in your current study set. Use Back to Menu to adjust
                filters or choose other decks.
              </p>
            )}
            {allDecksCompleteNotice && (
              <p className="flashcards-decks-complete-inline" role="status">
                {allDecksCompleteNotice}
              </p>
            )}
            {saveLog.length > 0 && (
              <div className="flashcards-save-log" role="log" aria-live="polite">
                <div className="flashcards-save-log-title">Progress save status</div>
                <pre className="flashcards-save-log-content">
                  {saveLog.join('\n')}
                </pre>
                {saveError && (
                  <p className="flashcards-save-error" role="alert">
                    Could not save progress: {saveError}
                  </p>
                )}
              </div>
            )}
            <div className="flashcards-results-btns">
              <button
                type="button"
                className="flashcards-btn flashcards-btn-utility"
                onClick={repeatAll}
              >
                Repeat All
              </button>
              {hasMissed && (
                <button
                  type="button"
                  className="flashcards-btn flashcards-btn-utility"
                  onClick={retryMissed}
                >
                  Retry Missed Only
                </button>
              )}
              <button
                type="button"
                className={`flashcards-btn flashcards-btn-utility${isLastDeckInStudySet ? ' flashcards-btn-disabled' : ''}`}
                onClick={loadNextUnit}
                disabled={isLastDeckInStudySet}
                title={
                  isLastDeckInStudySet
                    ? 'All decks in your current study set are complete'
                    : 'Go to the next deck in your list'
                }
              >
                Next
              </button>
              <button
                type="button"
                className="flashcards-btn-nav"
                onClick={returnToMenu}
              >
                Back to Menu
              </button>
            </div>
          </div>
        )}
      </div>
      {showManualTokenModal && (
        <ManualTokenModal
          message="LTI 1.1 does not support OAuth. Enter your Canvas API token to load course materials."
          onSuccess={() => {
            setShowManualTokenModal(false);
            loadBatchData();
          }}
          onDismiss={() => setShowManualTokenModal(false)}
        />
      )}
    </div>
  );
}
