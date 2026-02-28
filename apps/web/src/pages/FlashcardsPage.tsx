import { useCallback, useEffect, useRef, useState } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { TeacherSettings } from '../components/TeacherSettings';
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
const HUB_CACHE_KEY = (courseId: string) => `flashcards-hub-${courseId}`;
const HUB_CACHE_TTL_MS = 5 * 60 * 1000;

type CachedPlaylist = { id: string; title: string; items?: Array<{ id?: string; title: string; embed?: string }> };

interface FlashcardsPageProps {
  context: LtiContext;
}

export default function FlashcardsPage({ context }: FlashcardsPageProps) {
  const { setLastFunction, setSproutVideo, setLastApiResult } = useDebug();
  const teacherMode = context && isTeacher(context.roles) && context.courseId && context.userId !== 'standalone';
  const hasRealAssignment = context?.assignmentId && 
    context.assignmentId !== '' && 
    !context.assignmentId.toLowerCase().includes('$canvas.assignment');
  const isCourseNavigation = !!(context?.courseId && !hasRealAssignment);
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(true);
  const [courseSettings, setCourseSettings] = useState<{ selectedCurriculums: string[]; selectedUnits: string[]; sproutAccountId?: string } | null>(null);
  const [allPlaylistsHub, setAllPlaylistsHub] = useState<Array<{ id: string; title: string }>>([]);
  const [filteredPlaylistsWithItems, setFilteredPlaylistsWithItems] = useState<CachedPlaylist[]>([]);
  const [hubSelectedUnit, setHubSelectedUnit] = useState('');
  const [hubSelectedSection, setHubSelectedSection] = useState('');
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
  const [deckProgress, setDeckProgress] = useState<Record<string, { completed: number }>>({});
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

  const loadPlaylists = useCallback(async () => {
    setPlaylistsLoading(true);
    try {
      setLastFunction('GET /api/flashcard/playlists');
      const res = await fetch('/api/flashcard/playlists', { credentials: 'include' });
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      setPlaylists(list);
      if (list.length > 0) setSproutVideo(true, list.length);
    } catch {
      setPlaylists([]);
    } finally {
      setPlaylistsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!teacherMode && !isCourseNavigation) loadPlaylists();
  }, [teacherMode, isCourseNavigation, loadPlaylists]);

  const loadHubData = useCallback(async () => {
    if (!context?.courseId || !isCourseNavigation) {
      setPlaylistsLoading(false);
      return;
    }
    const courseId = context.courseId;
    const cacheKey = HUB_CACHE_KEY(courseId);
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { cs: unknown; pl: CachedPlaylist[]; ts: number };
        if (Date.now() - (parsed.ts ?? 0) < HUB_CACHE_TTL_MS && Array.isArray(parsed.pl)) {
          const cs = parsed.cs as { selectedCurriculums?: string[]; selectedUnits?: string[]; sproutAccountId?: string } | null;
          setCourseSettings(
            cs && typeof cs === 'object'
              ? { selectedCurriculums: cs.selectedCurriculums ?? [], selectedUnits: cs.selectedUnits ?? [], sproutAccountId: cs.sproutAccountId }
              : null,
          );
          const hub = parsed.pl.map((p) => ({ id: p.id, title: p.title }));
          setAllPlaylistsHub(hub);
          setFilteredPlaylistsWithItems(parsed.pl);
          if (parsed.pl.length > 0) setSproutVideo(true, parsed.pl.length);
          setPlaylistsLoading(false);
          return;
        }
      }
    } catch {
    }
    setPlaylistsLoading(true);
    try {
      setLastFunction('GET /api/course-settings');
      const csRes = await fetch('/api/course-settings', { credentials: 'include' });
      setLastApiResult('GET /api/course-settings', csRes.status, csRes.ok);
      const cs = await csRes.json().catch(() => null);
      console.log('[Student loadHubData] courseId:', courseId, 'courseSettings from API:', cs);
      const csState = cs ? { selectedCurriculums: cs.selectedCurriculums ?? [], selectedUnits: cs.selectedUnits ?? [], sproutAccountId: cs.sproutAccountId } : null;
      let pl: CachedPlaylist[] = Array.isArray(cs?.filteredPlaylists) ? cs.filteredPlaylists : [];
      if (pl.length === 0 && csState) {
        const plRes = await fetch('/api/flashcard/all-playlists', { credentials: 'include' });
        const allPl = await plRes.json().catch(() => []);
        pl = (Array.isArray(allPl) ? allPl : []).map((p: { id?: string; title: string }) => ({
          id: p.id ?? p.title,
          title: p.title,
        }));
      }
      const hub = pl.map((p) => ({ id: p.id, title: p.title }));
      setCourseSettings(csState);
      setAllPlaylistsHub(hub);
      setFilteredPlaylistsWithItems(pl);
      if (pl.length > 0) setSproutVideo(true, pl.length);
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify({ cs: csState, pl, ts: Date.now() }));
      } catch {
      }
      const stored = localStorage.getItem(LAST_SESSION_KEY(courseId));
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as { unit?: string };
          if (parsed?.unit) setLastSession({ unit: parsed.unit });
        } catch {
        }
      }
    } finally {
      setPlaylistsLoading(false);
    }
  }, [context?.courseId, isCourseNavigation]);

  useEffect(() => {
    const shouldLoadHub = (teacherMode && viewAsStudent && isCourseNavigation) || (!teacherMode && isCourseNavigation);
    if (shouldLoadHub) {
      setPlaylistsLoading(true);
      loadHubData();
    }
  }, [teacherMode, viewAsStudent, isCourseNavigation, loadHubData]);

  const hubFilteredPlaylists = useCallback(() => {
    if (allPlaylistsHub.length === 0) return [];
    const cs = courseSettings ?? { selectedCurriculums: [], selectedUnits: [] };
    return allPlaylistsHub.filter((p) => {
      const [c, u, s] = segments(p.title);
      if (cs.selectedUnits.length > 0 && (!u || !cs.selectedUnits.includes(u))) return false;
      if (cs.selectedCurriculums.length > 0 && (!c || !cs.selectedCurriculums.includes(c))) return false;
      if (hubSelectedUnit && u !== hubSelectedUnit) return false;
      if (hubSelectedSection && s !== hubSelectedSection) return false;
      return true;
    });
  }, [courseSettings, allPlaylistsHub, hubSelectedUnit, hubSelectedSection]);

  const hubUnits = [...new Set(
    allPlaylistsHub
      .filter((p) => {
        const [c, u] = segments(p.title);
        if (!u) return false;
        const cs = courseSettings ?? { selectedCurriculums: [] as string[], selectedUnits: [] as string[] };
        if (cs.selectedCurriculums.length > 0 && (!c || !cs.selectedCurriculums.includes(c))) return false;
        if (cs.selectedUnits.length > 0 && !cs.selectedUnits.includes(u)) return false;
        return true;
      })
      .map((p) => segments(p.title)[1])
      .filter(Boolean)
  )].sort();
  if (!teacherMode && isCourseNavigation) {
    console.log('[Student hubUnits] courseSettings:', courseSettings, 'hubUnits:', hubUnits);
  }

  const hubSections = [...new Set(
    allPlaylistsHub
      .filter((p) => {
        const [c, u, s] = segments(p.title);
        if (!s || !hubSelectedUnit || u !== hubSelectedUnit) return false;
        const cs = courseSettings ?? { selectedCurriculums: [] as string[] };
        if (cs.selectedCurriculums.length > 0 && (!c || !cs.selectedCurriculums.includes(c))) return false;
        return true;
      })
      .map((p) => segments(p.title)[2])
      .filter(Boolean)
  )].sort();

  useEffect(() => {
    const useHubData = (teacherMode && viewAsStudent && isCourseNavigation) || (!teacherMode && isCourseNavigation);
    if (useHubData) {
      const filtered = hubFilteredPlaylists();
      const items = filtered.map((p) => ({ title: p.title, id: p.id }));
      setPlaylists(items);
    }
  }, [teacherMode, viewAsStudent, isCourseNavigation, hubFilteredPlaylists]);

  const handleFilteredPlaylists = useCallback((list: Array<{ id: string; title: string }>) => {
    setPlaylistsLoading(false);
    const items = list.map((p) => ({ title: p.title, id: p.id }));
    setPlaylists(items);
    if (items.length > 0) setSproutVideo(true, items.length);
  }, []);

  const selectPlaylist = async (id: string, title: string, idx: number) => {
    submittedForSessionRef.current = false;
    setSaveError(null);
    setCurrentPlaylist({ id, title });
    setPlaylistIndex(idx);
    setCurrentIndex(-1);
    setScore({ correct: 0, total: 0, details: [] });
    setStreak(0);
    setBenchmarkNagDismissed(false);
    setShowingAnswer(false);
    setScreeningOverlay(null);
    const goToPlaylistView = viewAsPlaylist;
    setView(goToPlaylistView ? 'playlist' : 'study');

    const cached = filteredPlaylistsWithItems.find((p) => String(p.id) === String(id));
    const sproutAccountId = courseSettings?.sproutAccountId;
    const buildEmbed = (videoId: string) =>
      sproutAccountId
        ? `<iframe src="https://videos.sproutvideo.com/embed/${sproutAccountId}/${videoId}" class="sproutvideo-player" width="640" height="360" frameborder="0" allowfullscreen></iframe>`
        : undefined;
    const cachedHasEmbeds = cached?.items?.some((it) => it.embed);
    if (cached?.items && cached.items.length > 0 && cachedHasEmbeds) {
      let list = cached.items.map((it) => ({ title: it.title, embed: it.embed }));
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
      return;
    }

    try {
      const res = await fetch(
        `/api/flashcard/items?playlist_id=${encodeURIComponent(id)}`,
        { credentials: 'include' },
      );
      const data = await res.json();
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
      setItems([]);
      setDeckProgress({});
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
    if (context?.courseId) {
      const [,, u] = segments(currentPlaylist.title);
      if (u) {
        try {
          localStorage.setItem(LAST_SESSION_KEY(context.courseId), JSON.stringify({ unit: u }));
        } catch {
        }
      }
    }
    try {
      const res = await fetch('/api/submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          score: score.correct,
          scoreTotal: score.total,
          deckIds: [currentPlaylist.id],
          wordCount: 0,
          mode,
          playlistTitle: currentPlaylist.title,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { synced?: boolean; error?: string };
      if (!res.ok || data.synced === false) {
        const msg = data.error || `Save failed (${res.status})`;
        setSaveError(msg);
        submittedForSessionRef.current = false;
      } else {
        submittedForSessionRef.current = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
      submittedForSessionRef.current = false;
    }
  }, [context?.courseId, currentPlaylist, score.correct, score.total, mode]);

  useEffect(() => {
    if (view === 'results' && currentPlaylist) {
      silentSubmitProgress();
    }
  }, [view, currentPlaylist, silentSubmitProgress]);

  const returnToMenu = () => {
    setView('menu');
    setCurrentPlaylist(null);
    setItems([]);
    setCurrentIndex(-1);
    setScreeningOverlay(null);
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
    if (playlistIndex >= 0 && playlistIndex < playlists.length - 1) {
      const next = playlists[playlistIndex + 1];
      const id = (next as { id?: string }).id ?? String(playlistIndex + 1);
      selectPlaylist(id, next.title, playlistIndex + 1);
    }
  };

  const currentItem = items[currentIndex];
  const percentage =
    score.total > 0 ? Math.round((score.correct / score.total) * 100) : 0;
  const hasMissed = score.details.some((d) => d.result === 'Incorrect');

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
                  if (context?.courseId) {
                    try {
                      sessionStorage.removeItem(HUB_CACHE_KEY(context.courseId));
                    } catch {}
                    if (viewAsStudent) loadHubData();
                  }
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
            {!teacherMode && !isCourseNavigation ? (
              <p className="flashcards-teacher-msg">Your teacher will configure the deck for this course.</p>
            ) : (viewAsStudent && teacherMode) || (!teacherMode && isCourseNavigation) ? (
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
                    <div className="flashcards-hub-filters">
                      <label className="flashcards-hub-field">
                        <span className="flashcards-hub-label">Unit</span>
                        <select
                          value={hubSelectedUnit}
                          onChange={(e) => { setHubSelectedUnit(e.target.value); setHubSelectedSection(''); }}
                          className="flashcards-hub-select"
                        >
                          <option value="">— All —</option>
                          {hubUnits.map((u) => (
                            <option key={u} value={u}>{u}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flashcards-hub-field">
                        <span className="flashcards-hub-label">Section</span>
                        <select
                          value={hubSelectedSection}
                          onChange={(e) => setHubSelectedSection(e.target.value)}
                          className="flashcards-hub-select"
                          disabled={!hubSelectedUnit}
                        >
                          <option value="">— All —</option>
                          {hubSections.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </label>
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
                  ? `${Math.min(deckProgress[currentPlaylist?.id ?? '']?.completed ?? 0, items.length)} of ${items.length} cards`
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
                  <p className="flashcards-vocab-display">READY?</p>
                  <button
                    type="button"
                    className="flashcards-btn flashcards-btn-flip"
                    onClick={startSession}
                  >
                    Start
                  </button>
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
            {saveError && (
              <p className="flashcards-save-error" role="alert">
                Could not save progress: {saveError}
              </p>
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
                className="flashcards-btn flashcards-btn-utility"
                onClick={loadNextUnit}
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
    </div>
  );
}
