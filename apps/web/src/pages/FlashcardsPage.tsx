import { useCallback, useEffect, useState } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { TeacherSettings } from '../components/TeacherSettings';

type PlaylistItem = { title: string; id?: string };
type VideoItem = { title: string; embed?: string };

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

interface FlashcardsPageProps {
  context: LtiContext;
}

export default function FlashcardsPage({ context }: FlashcardsPageProps) {
  const { setLastFunction, setSproutVideo } = useDebug();
  const teacherMode = context && isTeacher(context.roles) && context.courseId && context.userId !== 'standalone';
  const [teacherSelection, setTeacherSelection] = useState({ curriculum: '', unit: '', section: '' });
  const handleSelectionChange = useCallback((c: string, u: string, s: string) => {
    setTeacherSelection({ curriculum: c, unit: u, section: s });
  }, []);
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(true);
  const [view, setView] = useState<'menu' | 'study' | 'results'>('menu');
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
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [secDisplay, setSecDisplay] = useState(3);
  const [showTimer, setShowTimer] = useState(true);
  const [shuffle, setShuffle] = useState(false);
  const [mode, setMode] = useState<Mode>('rehearsal');
  const [screeningCriteria, setScreeningCriteria] = useState(5);
  const [firstSide, setFirstSide] = useState<FirstSide>('english');
  const [playlistIndex, setPlaylistIndex] = useState(-1);
  const [screeningOverlay, setScreeningOverlay] = useState<{
    type: 'mastery' | 'frustration';
    title: string;
    message: string;
  } | null>(null);

  const loadPlaylists = useCallback(async (curriculum?: string, unit?: string, section?: string) => {
    setPlaylistsLoading(true);
    try {
      const params = new URLSearchParams();
      if (curriculum) params.set('curriculum', curriculum);
      if (unit) params.set('unit', unit);
      if (section) params.set('section', section);
      const url = params.toString() ? `/api/flashcard/playlists?${params}` : '/api/flashcard/playlists';
      setLastFunction(`GET ${url}`);
      const res = await fetch(url, { credentials: 'include' });
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
    if (teacherMode && teacherSelection.curriculum) {
      loadPlaylists(teacherSelection.curriculum, teacherSelection.unit, teacherSelection.section);
    } else if (!teacherMode) {
      loadPlaylists();
    }
  }, [teacherMode, teacherSelection.curriculum, teacherSelection.unit, teacherSelection.section, loadPlaylists]);

  const selectPlaylist = async (id: string, title: string, idx: number) => {
    setCurrentPlaylist({ id, title });
    setPlaylistIndex(idx);
    setCurrentIndex(-1);
    setScore({ correct: 0, total: 0, details: [] });
    setStreak(0);
    setBenchmarkNagDismissed(false);
    setShowingAnswer(false);
    setView('study');
    setScreeningOverlay(null);
    try {
      const res = await fetch(
        `/api/flashcard/items?playlist_id=${encodeURIComponent(id)}`,
        { credentials: 'include' },
      );
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      setOriginalItems(list);
      setItems([...list]);
    } catch {
      setItems([]);
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
      setScore((s) => ({
        ...s,
        correct: s.correct + (isCorrect ? 1 : 0),
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

  const revealAnswer = () => setShowingAnswer(true);

  const submitGrade = async () => {
    if (!currentPlaylist) return;
    setSubmitting(true);
    setSubmitError(null);
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
      const data = await res.json();
      if (data.synced) {
        setView('menu');
        loadPlaylists();
      } else {
        setSubmitError(data.error ?? 'Failed to submit grade');
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  const returnToMenu = () => {
    setView('menu');
    setCurrentPlaylist(null);
    setItems([]);
    setCurrentIndex(-1);
    setScreeningOverlay(null);
  };

  const repeatAll = () => {
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

  return (
    <div className="min-h-screen bg-zinc-900 text-white flex flex-col items-center p-6">
      <div className="w-full max-w-2xl">
        {view === 'menu' && (
          <div className="space-y-6">
            <TeacherSettings
              context={context}
              onConfigChange={() => loadPlaylists(teacherSelection.curriculum, teacherSelection.unit, teacherSelection.section)}
              onSelectionChange={handleSelectionChange}
            />
            <h1 className="text-2xl font-bold text-emerald-400">TWA Vocabulary</h1>
            {!teacherMode ? (
              <p className="text-zinc-400 py-8">Your teacher will configure the deck for this course.</p>
            ) : playlistsLoading ? (
              <div className="flex flex-col items-center gap-4 py-12">
                <div className="w-12 h-12 border-4 border-zinc-600 border-t-emerald-400 rounded-full animate-spin" />
                <p>Loading playlists...</p>
              </div>
            ) : (
              <div className="space-y-3">
                {playlists.map((pl, idx) => (
                  <button
                    key={(pl as { id?: string }).id ?? idx}
                    onClick={() =>
                      selectPlaylist(
                        (pl as { id?: string }).id ?? String(idx),
                        pl.title,
                        idx,
                      )
                    }
                    className="w-full py-4 px-6 bg-zinc-800 border border-zinc-600 rounded-lg text-left hover:bg-zinc-700 hover:border-emerald-500 transition-colors"
                  >
                    {pl.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {view === 'study' && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-4 p-3 bg-zinc-800 rounded-lg text-sm">
              <label className="flex items-center gap-2">
                Sec:{' '}
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={secDisplay}
                  onChange={(e) => setSecDisplay(Number(e.target.value) || 3)}
                  className="w-12 bg-zinc-900 border border-zinc-600 rounded px-2 py-1"
                />
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showTimer}
                  onChange={(e) => setShowTimer(e.target.checked)}
                />
                Timer
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={shuffle}
                  onChange={(e) => setShuffle(e.target.checked)}
                />
                Shuffle
              </label>
              <label className="flex items-center gap-2">
                Mode:{' '}
                <select
                  value={mode}
                  onChange={(e) => {
                    setMode(e.target.value as Mode);
                    setStreak(0);
                  }}
                  className="bg-zinc-900 border border-zinc-600 rounded px-2 py-1"
                >
                  <option value="rehearsal">Rehearsal</option>
                  <option value="tutorial">Tutorial</option>
                  <option value="screening">Screening</option>
                </select>
              </label>
              {mode === 'screening' && (
                <label className="flex items-center gap-2">
                  Crit:{' '}
                  <select
                    value={screeningCriteria}
                    onChange={(e) =>
                      setScreeningCriteria(Number(e.target.value) || 5)
                    }
                    className="bg-zinc-900 border border-zinc-600 rounded px-2 py-1"
                  >
                    {[3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex items-center gap-2">
                1st:{' '}
                <select
                  value={firstSide}
                  onChange={(e) => setFirstSide(e.target.value as FirstSide)}
                  className="bg-zinc-900 border border-zinc-600 rounded px-2 py-1"
                >
                  <option value="english">Eng</option>
                  <option value="asl">ASL</option>
                </select>
              </label>
            </div>

            <div className="flex justify-between text-zinc-400 text-sm">
              <span>
                Progress: {score.correct} / {score.total}{' '}
                {mode === 'screening' && streak !== 0 && (
                  <span
                    className={
                      streak > 0 ? 'text-emerald-400' : 'text-red-500'
                    }
                  >
                    Streak: {streak}
                  </span>
                )}
              </span>
              <span>
                Item {currentIndex + 1} of {items.length}
              </span>
            </div>

            <div className="relative bg-zinc-800 rounded-xl p-8 min-h-[320px] flex flex-col justify-center items-center">
              {screeningOverlay && (
                <div className="absolute inset-0 bg-black/95 flex flex-col justify-center items-center p-6 z-10 rounded-xl">
                  <h2
                    className={`text-xl font-bold mb-4 ${
                      screeningOverlay.type === 'mastery'
                        ? 'text-emerald-400'
                        : 'text-red-500'
                    }`}
                  >
                    {screeningOverlay.title}
                  </h2>
                  <p className="text-center mb-6">{screeningOverlay.message}</p>
                  <div className="flex gap-4">
                    {screeningOverlay.type === 'mastery' ? (
                      <>
                        <button
                          onClick={() => {
                            setScreeningOverlay(null);
                            loadNextUnit();
                          }}
                          className="px-6 py-2 bg-emerald-600 rounded font-semibold hover:bg-emerald-500"
                        >
                          Next Deck
                        </button>
                        <button
                          onClick={() => {
                            setScreeningOverlay(null);
                            setCurrentIndex((i) => i + 1);
                            setShowingAnswer(false);
                          }}
                          className="px-6 py-2 bg-zinc-600 rounded font-semibold hover:bg-zinc-500"
                        >
                          Continue Current
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => {
                            setMode('tutorial');
                            setStreak(0);
                            setScreeningOverlay(null);
                            setCurrentIndex((i) => i + 1);
                            setShowingAnswer(false);
                          }}
                          className="px-6 py-2 bg-red-600 rounded font-semibold hover:bg-red-500"
                        >
                          Switch to Tutorial
                        </button>
                        <button
                          onClick={() => {
                            setBenchmarkNagDismissed(true);
                            setScreeningOverlay(null);
                            setCurrentIndex((i) => i + 1);
                            setShowingAnswer(false);
                          }}
                          className="px-6 py-2 bg-zinc-600 rounded font-semibold hover:bg-zinc-500"
                        >
                          Keep Trying
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}

              {currentIndex < 0 ? (
                <div className="text-center">
                  <p className="text-3xl text-emerald-400 mb-6">READY?</p>
                  <button
                    onClick={startSession}
                    className="px-8 py-3 bg-blue-600 rounded-lg font-bold hover:bg-blue-500"
                  >
                    Start
                  </button>
                </div>
              ) : currentItem ? (
                <div className="w-full">
                  {!showingAnswer ? (
                    firstSide === 'english' ? (
                      <div>
                        <p className="text-4xl text-emerald-400 mb-6">
                          {currentItem.title}
                        </p>
                        <button
                          onClick={revealAnswer}
                          className="px-6 py-2 bg-blue-600 rounded font-semibold hover:bg-blue-500"
                        >
                          Show Answer
                        </button>
                      </div>
                    ) : (
                      <div className="w-full aspect-video bg-black rounded overflow-hidden">
                        {currentItem.embed && (
                          <div
                            className="w-full h-full"
                            dangerouslySetInnerHTML={{
                              __html: embedWithAutoplay(currentItem.embed),
                            }}
                          />
                        )}
                        <button
                          onClick={revealAnswer}
                          className="mt-4 px-6 py-2 bg-blue-600 rounded font-semibold hover:bg-blue-500"
                        >
                          Show Answer
                        </button>
                      </div>
                    )
                  ) : (
                    <div>
                      {firstSide === 'asl' ? (
                        <p className="text-3xl text-emerald-400 mb-6">
                          {currentItem.title}
                        </p>
                      ) : (
                        <div className="w-full aspect-video bg-black rounded overflow-hidden mb-6">
                          {currentItem.embed && (
                            <div
                              className="w-full h-full [&>iframe]:w-full [&>iframe]:h-full"
                              dangerouslySetInnerHTML={{
                                __html: embedWithAutoplay(currentItem.embed),
                              }}
                            />
                          )}
                        </div>
                      )}
                      {mode === 'tutorial' ? (
                        <button
                          onClick={() => recordScore(true)}
                          className="px-6 py-2 bg-emerald-600 rounded font-semibold hover:bg-emerald-500"
                        >
                          Next
                        </button>
                      ) : (
                        <div className="flex gap-4">
                          <button
                            onClick={() => recordScore(true)}
                            className="px-6 py-2 bg-emerald-600 rounded font-semibold hover:bg-emerald-500"
                          >
                            Correct
                          </button>
                          <button
                            onClick={() => recordScore(false)}
                            className="px-6 py-2 bg-red-600 rounded font-semibold hover:bg-red-500"
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

            <div className="flex gap-4 justify-center">
              <button
                onClick={returnToMenu}
                className="px-4 py-2 bg-zinc-700 border border-zinc-600 rounded font-semibold hover:bg-zinc-600"
              >
                Change Deck
              </button>
            </div>
          </div>
        )}

        {view === 'results' && (
          <div className="space-y-6">
            <h1 className="text-2xl font-bold text-emerald-400">Results</h1>
            <p className="text-3xl">
              {score.correct}/{score.total} ({percentage}%)
            </p>
            <p className="text-zinc-400 italic">Suggested minimum score: 85%</p>
            <div className="flex flex-wrap gap-3 justify-center">
              <button
                onClick={repeatAll}
                className="px-6 py-2 bg-blue-600 rounded font-semibold hover:bg-blue-500"
              >
                Repeat All
              </button>
              {hasMissed && (
                <button
                  onClick={retryMissed}
                  className="px-6 py-2 bg-blue-600 rounded font-semibold hover:bg-blue-500"
                >
                  Retry Missed Only
                </button>
              )}
              <button
                onClick={loadNextUnit}
                className="px-6 py-2 bg-blue-600 rounded font-semibold hover:bg-blue-500"
              >
                Next
              </button>
              <button
                onClick={submitGrade}
                disabled={submitting}
                className="px-6 py-2 bg-emerald-600 rounded font-semibold hover:bg-emerald-500 disabled:opacity-50"
              >
                {submitting ? 'Submitting...' : 'Submit Grade'}
              </button>
              <button
                onClick={returnToMenu}
                className="px-6 py-2 bg-zinc-700 border border-zinc-600 rounded font-semibold hover:bg-zinc-600"
              >
                Back to Menu
              </button>
            </div>
            {submitError && (
              <p className="text-red-500 text-sm">Error: {submitError}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
