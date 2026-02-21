import { useCallback, useEffect, useState } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { TeacherSettings } from '../components/TeacherSettings';
import './FlashcardsPage.css';

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
    if (!teacherMode) loadPlaylists();
  }, [teacherMode, loadPlaylists]);

  const handleFilteredPlaylists = useCallback((list: Array<{ id: string; title: string }>) => {
    setPlaylistsLoading(false);
    const items = list.map((p) => ({ title: p.title, id: p.id }));
    setPlaylists(items);
    if (items.length > 0) setSproutVideo(true, items.length);
  }, []);

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
    <div className="flashcards-page">
      <div className="flashcards-container">
        {view === 'menu' && (
          <div className="flashcards-menu">
            <TeacherSettings
              context={context}
              onConfigChange={() => {}}
              onFilteredPlaylists={handleFilteredPlaylists}
            />
            <h1 className="flashcards-title">TWA Vocabulary</h1>
            {!teacherMode ? (
              <p className="flashcards-teacher-msg">Your teacher will configure the deck for this course.</p>
            ) : playlistsLoading ? (
              <div className="flashcards-loading">
                <div className="flashcards-spinner" />
                <p>Loading playlists...</p>
              </div>
            ) : (
              <div className="flashcards-playlist-list">
                {playlists.map((pl, idx) => (
                  <button
                    key={(pl as { id?: string }).id ?? idx}
                    type="button"
                    className="flashcards-playlist-btn"
                    onClick={() =>
                      selectPlaylist(
                        (pl as { id?: string }).id ?? String(idx),
                        pl.title,
                        idx,
                      )
                    }
                  >
                    {pl.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {view === 'study' && (
          <div className="flashcards-study">
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
                Progress: {score.correct} / {score.total}{' '}
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
                Item {currentIndex + 1} of {items.length}
              </span>
            </div>

            <div className="flashcards-card">
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
                <div>
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
                <div className="flashcards-controls flashcards-controls-col">
                  {!showingAnswer ? (
                    firstSide === 'english' ? (
                      <div className="flashcards-controls flashcards-controls-col">
                        <p className="flashcards-vocab-display">
                          {currentItem.title}
                        </p>
                        <button
                          type="button"
                          className="flashcards-btn flashcards-btn-flip"
                          onClick={revealAnswer}
                        >
                          Show Answer
                        </button>
                      </div>
                    ) : (
                      <div className="flashcards-controls flashcards-controls-col">
                        <div className="flashcards-video-wrap">
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
                          className="flashcards-btn flashcards-btn-flip"
                          onClick={revealAnswer}
                        >
                          Show Answer
                        </button>
                      </div>
                    )
                  ) : (
                    <div className="flashcards-controls flashcards-controls-col">
                      {firstSide === 'asl' ? (
                        <p className="flashcards-vocab-display flashcards-vocab-display-sm">
                          {currentItem.title}
                        </p>
                      ) : (
                        <div className="flashcards-video-wrap">
                          {currentItem.embed && (
                            <div
                              className="flashcards-video-wrap-inner"
                              dangerouslySetInnerHTML={{
                                __html: embedWithAutoplay(currentItem.embed),
                              }}
                            />
                          )}
                        </div>
                      )}
                      {mode === 'tutorial' ? (
                        <button
                          type="button"
                          className="flashcards-btn flashcards-btn-correct"
                          onClick={() => recordScore(true)}
                        >
                          Next
                        </button>
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
                onClick={returnToMenu}
              >
                Change Deck
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
                className="flashcards-btn flashcards-btn-utility"
                onClick={submitGrade}
                disabled={submitting}
              >
                {submitting ? 'Submitting...' : 'Submit Grade'}
              </button>
              <button
                type="button"
                className="flashcards-btn-nav"
                onClick={returnToMenu}
              >
                Back to Menu
              </button>
            </div>
            {submitError && (
              <p className="flashcards-error">Error: {submitError}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
