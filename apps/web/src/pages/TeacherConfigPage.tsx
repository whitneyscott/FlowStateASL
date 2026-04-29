import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { resolveLtiContextValue } from '../utils/lti-context';
import { appendBridgeLog } from '../utils/bridge-log';
import * as promptApi from '../api/prompt.api';
import * as flashcardTeacherApi from '../api/flashcard-teacher.api';
import type { PlaylistHierarchyRow } from '../api/flashcard-teacher.api';
import { AppBlockingLoader } from '../components/AppBlockingLoader';
import { ManualTokenModal } from '../components/ManualTokenModal';
import { computeDeckHubFilters } from '../utils/deckHierarchyFilters';
import { normalizeYoutubeInputToVideoIdClient } from '../utils/youtube-video-id';
import { YoutubeStimulusShell } from '../components/YoutubeStimulusShell';
import { YoutubeIframePlayer, type YoutubeIframePlayerHandle } from '../components/YoutubeIframePlayer';
import { YoutubeClipRangeEditor } from '../components/YoutubeClipRangeEditor';
import { TeacherPromptRte } from '../components/TeacherPromptRte';
import '../components/TeacherSettings.css';
import './PrompterPage.css';

const TEACHER_PATTERNS = [
  'instructor',
  'administrator',
  'faculty',
  'teacher',
  'staff',
  'contentdeveloper',
  'teachingassistant',
  'ta',
];

function isTeacher(roles: string): boolean {
  if (!roles || typeof roles !== 'string') return false;
  return TEACHER_PATTERNS.some((p) => roles.toLowerCase().includes(p));
}

function normalizePromptHtmlItem(input: unknown): string {
  if (typeof input === 'string') {
    const t = input.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      try {
        return normalizePromptHtmlItem(JSON.parse(t));
      } catch {
        return input;
      }
    }
    return input;
  }
  if (input && typeof input === 'object') {
    const obj = input as {
      html?: unknown;
      promptHtml?: unknown;
      value?: unknown;
      content?: unknown;
      text?: unknown;
      prompt?: unknown;
      body?: unknown;
    };
    if (typeof obj.html === 'string') return obj.html;
    if (typeof obj.promptHtml === 'string') return obj.promptHtml;
    if (typeof obj.value === 'string') return obj.value;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.prompt === 'string') return obj.prompt;
    if (typeof obj.body === 'string') return obj.body;
  }
  if (input == null) return '';
  return String(input);
}

function stripAslEmbedBlocks(html: string): string {
  return html.replace(
    /<div\b[^>]*\bdata-asl-express-v=["']1["'][^>]*>[\s\S]*?<\/div>/gi,
    '',
  );
}

function unwrapStandaloneQuillEditorRoot(html: string): string {
  const trimmed = html.trim();
  const m = trimmed.match(
    /^<div\b[^>]*\bclass=["'][^"']*\bql-editor\b[^"']*["'][^>]*>([\s\S]*)<\/div>\s*$/i,
  );
  return m ? m[1] : html;
}

function sanitizePromptHtmlForQuill(input: string): string {
  const noEmbeds = stripAslEmbedBlocks(input);
  const unwrapped = unwrapStandaloneQuillEditorRoot(noEmbeds);
  return unwrapped.trim();
}

function extractNormalizedPrompts(
  data: promptApi.PromptConfig & Record<string, unknown>,
): { prompts: string[]; sourceField: string; rawPrompts: string[] } {
  const candidates: Array<{ field: string; value: unknown }> = [
    { field: 'prompts', value: data.prompts },
    { field: 'textPrompts', value: data.textPrompts },
    { field: 'promptPool', value: data.promptPool },
    { field: 'textPromptPool', value: data.textPromptPool },
  ];
  let fallback: { prompts: string[]; sourceField: string; rawPrompts: string[] } | null = null;
  for (const c of candidates) {
    if (!Array.isArray(c.value)) continue;
    const rawPrompts = c.value.map((item) => normalizePromptHtmlItem(item));
    const sanitized = rawPrompts.map((p) => sanitizePromptHtmlForQuill(p));
    if (!fallback) fallback = { prompts: sanitized, sourceField: c.field, rawPrompts };
    if (sanitized.some((p) => p.trim().length > 0)) {
      return { prompts: sanitized, sourceField: c.field, rawPrompts };
    }
  }
  return fallback ?? { prompts: [], sourceField: 'none', rawPrompts: [] };
}

interface TeacherConfigPageProps {
  context: LtiContext | null;
}

export default function TeacherConfigPage({ context }: TeacherConfigPageProps) {
  const { setLastFunction, setLastApiResult, setLastApiError } = useDebug();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const assignmentIdFromUrl = searchParams.get('assignmentId') ?? '';
  const ctxAssignmentId = resolveLtiContextValue(context?.assignmentId);
  const createMode = searchParams.get('create') === '1';
  /** URL wins over LTI context: course_navigation / stale `assignment` claims may point at storage or the wrong item; `?assignmentId=` is the explicit target. */
  const assignmentId = createMode
    ? null
    : (assignmentIdFromUrl.trim() || ctxAssignmentId) || null;

  const [config, setConfig] = useState<promptApi.PromptConfig | null>(null);
  const [configuredAssignments, setConfiguredAssignments] = useState<promptApi.ConfiguredAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(false);
  /** Supersedes in-flight fetches so only the latest response applies to `configuredAssignments`. */
  const assignmentsLoadGenRef = useRef(0);
  /** Count of overlapping `loadAssignments` calls; spinner clears when the last one finishes. */
  const assignmentsPendingRef = useRef(0);
  const [, setGradeDropdownValue] = useState('');
  const [assignmentActionMode, setAssignmentActionMode] = useState<'edit' | 'grade' | 'create'>(
    createMode || !assignmentId ? 'create' : 'edit'
  );
  const [configAssignValue, setConfigAssignValue] = useState('');
  const [creatingAssignment, setCreatingAssignment] = useState(false);
  /** Unlink from Prompt Manager only, or full Canvas delete — mutually exclusive while in flight. */
  const [assignmentRemoval, setAssignmentRemoval] = useState<null | 'prompts' | 'canvas'>(null);
  const [createAssignName, setCreateAssignName] = useState('');
  const [gradeConfirmModal, setGradeConfirmModal] = useState<{ name: string; id: string } | null>(null);
  const [modules, setModules] = useState<promptApi.CanvasModule[]>([]);
  const [assignmentGroups, setAssignmentGroups] = useState<promptApi.CanvasAssignmentGroup[]>([]);
  const [rubrics, setRubrics] = useState<promptApi.CanvasRubric[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(5);
  const [prompts, setPrompts] = useState<string[]>([]);
  /** Bumped when GET /config data is applied so react-quill remounts and shows async-loaded HTML. */
  const [promptRteRemountKey, setPromptRteRemountKey] = useState(0);
  const [accessCode, setAccessCode] = useState('');
  const [moduleId, setModuleId] = useState<string>('');
  const [createModuleName, setCreateModuleName] = useState('');
  const [createModulePosition, setCreateModulePosition] = useState<number | ''>('');
  const [creatingModule, setCreatingModule] = useState(false);
  const [showCreateModule, setShowCreateModule] = useState(false);
  const [assignmentGroupId, setAssignmentGroupId] = useState<string>('');
  const [rubricId, setRubricId] = useState<string>('');
  const [createGroupName, setCreateGroupName] = useState('');
  const [assignmentName, setAssignmentName] = useState('');
  const [pointsPossible, setPointsPossible] = useState(10);
  const [dueAt, setDueAt] = useState('');
  const [unlockAt, setUnlockAt] = useState('');
  const [lockAt, setLockAt] = useState('');
  const [allowedAttempts, setAllowedAttempts] = useState(1);
  const [instructions, setInstructions] = useState('');
  const [signToVoiceRequired, setSignToVoiceRequired] = useState(false);
  const [showManualTokenModal, setShowManualTokenModal] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importInfo, setImportInfo] = useState<string | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importCanvasBrief, setImportCanvasBrief] = useState<{
    allAssignments: promptApi.CanvasAssignmentBriefForImport[];
    settingsTitleCandidates: promptApi.CanvasAssignmentBriefForImport[];
  } | null>(null);
  const importCanvasBriefRef = useRef(importCanvasBrief);
  importCanvasBriefRef.current = importCanvasBrief;
  const [importSourceAssignmentId, setImportSourceAssignmentId] = useState('');
  const [importModalBusy, setImportModalBusy] = useState(false);
  const [importModalMessage, setImportModalMessage] = useState<string | null>(null);
  const [trueWayApplyMessage, setTrueWayApplyMessage] = useState<string | null>(null);
  const [importModuleId, setImportModuleId] = useState('');
  /** Import modal: Auto uses merged source embed + server infer; explicit values force `promptMode`. */
  const [importPromptModeChoice, setImportPromptModeChoice] = useState<'auto' | 'text' | 'decks' | 'youtube'>('auto');

  // Deck mode state
  const [promptMode, setPromptMode] = useState<'text' | 'decks' | 'youtube'>('text');
  const [selectedDecks, setSelectedDecks] = useState<promptApi.DeckConfig[]>([]);
  const [totalCards, setTotalCards] = useState(10);
  const [deckPromptWarning, setDeckPromptWarning] = useState<string | null>(null);
  const [estimatedSessionLength, setEstimatedSessionLength] = useState<string>('');
  const [deckHierarchyPlaylists, setDeckHierarchyPlaylists] = useState<PlaylistHierarchyRow[]>([]);
  const [deckFilterCurricula, setDeckFilterCurricula] = useState<string[]>([]);
  const [deckFilterUnits, setDeckFilterUnits] = useState<string[]>([]);
  const [deckFilterSections, setDeckFilterSections] = useState<string[]>([]);
  const [deckPickerLoading, setDeckPickerLoading] = useState(false);
  const [deckPickerError, setDeckPickerError] = useState<string | null>(null);
  const [deckPickerRefreshKey, setDeckPickerRefreshKey] = useState(0);
  const [pendingDeckFilterSeedIds, setPendingDeckFilterSeedIds] = useState<string[] | null>(null);

  const [youtubeUrlOrId, setYoutubeUrlOrId] = useState('');
  const [youtubeLabel, setYoutubeLabel] = useState('');
  const [youtubeClipStartSec, setYoutubeClipStartSec] = useState(0);
  const [youtubeClipEndSec, setYoutubeClipEndSec] = useState(60);
  const [youtubePreviewVideoId, setYoutubePreviewVideoId] = useState<string | null>(null);
  const [youtubeFieldError, setYoutubeFieldError] = useState<string | null>(null);
  const [youtubePreviewDuration, setYoutubePreviewDuration] = useState(0);
  const [youtubeApiFailed, setYoutubeApiFailed] = useState(false);
  const [youtubeAllowStudentCaptions, setYoutubeAllowStudentCaptions] = useState(false);
  const [youtubeSubtitleMaskEnabled, setYoutubeSubtitleMaskEnabled] = useState(false);
  const [youtubeSubtitleMaskHeight, setYoutubeSubtitleMaskHeight] = useState(15);

  const [youtubePreviewRetryNonce, setYoutubePreviewRetryNonce] = useState(0);
  const youtubePreviewPlayerRef = useRef<YoutubeIframePlayerHandle>(null);

  /** Preview player remounts only when video id or retry changes — clip edits use seek, not remount. */
  const youtubePreviewPlayerKey = useMemo(() => {
    if (!youtubePreviewVideoId) return '';
    return `yt-preview-${youtubePreviewVideoId}-r${youtubePreviewRetryNonce}`;
  }, [youtubePreviewVideoId, youtubePreviewRetryNonce]);

  const seekYoutubePreview = useCallback(
    (sec: number) => {
      if (youtubeApiFailed) return;
      const p = youtubePreviewPlayerRef.current;
      if (!p) return;
      const d = youtubePreviewDuration;
      const raw = Math.floor(Number(sec) || 0);
      const t = d > 0 ? Math.min(Math.max(0, raw), d) : Math.max(0, raw);
      try {
        p.seekToSeconds(t);
      } catch {
        /* ignore */
      }
    },
    [youtubeApiFailed, youtubePreviewDuration],
  );

  const teacher = context && isTeacher(context.roles);
  const hasLti = context?.courseId && context.userId !== 'standalone';
  const needsAssignmentSelector = hasLti && !ctxAssignmentId;

  const loadAssignments = useCallback(async (): Promise<promptApi.ConfiguredAssignmentsResponse | null> => {
    if (!teacher || !hasLti) {
      assignmentsLoadGenRef.current += 1;
      setLoadingAssignments(false);
      return null;
    }
    const gen = ++assignmentsLoadGenRef.current;
    assignmentsPendingRef.current++;
    setLoadingAssignments(true);
    try {
      setLastFunction('GET /api/prompt/configured-assignments');
      const res = await promptApi.getConfiguredAssignments();
      if (gen === assignmentsLoadGenRef.current) {
        setLastApiResult('GET /api/prompt/configured-assignments', 200, true);
        const list = res.configured ?? [];
        setConfiguredAssignments((prev) => {
          if (list.length === 0 && prev.length > 0) {
            console.warn('[TeacherConfig] preserving prior configuredAssignments due transient empty response', {
              previousCount: prev.length,
            });
            return prev;
          }
          return list;
        });
        setImportCanvasBrief(res.canvasImport ?? null);
        return res;
      }
      return null;
    } catch (e) {
      if (gen === assignmentsLoadGenRef.current) {
        if (e instanceof promptApi.NeedsManualTokenError) setShowManualTokenModal(true);
        console.warn('[TeacherConfig] loadAssignments error, preserving prior configuredAssignments', e);
      }
      return null;
    } finally {
      assignmentsPendingRef.current = Math.max(0, assignmentsPendingRef.current - 1);
      if (assignmentsPendingRef.current === 0) {
        setLoadingAssignments(false);
      }
    }
  }, [teacher, hasLti, setLastFunction, setLastApiResult]);

  const loadModules = useCallback(async () => {
    if (!teacher || !hasLti) return;
    try {
      setLastFunction('GET /api/prompt/modules');
      const list = await promptApi.getModules();
      setLastApiResult('GET /api/prompt/modules', 200, true);
      setModules(list ?? []);
    } catch (e) {
      if (e instanceof promptApi.NeedsManualTokenError) setShowManualTokenModal(true);
      setModules([]);
    }
  }, [teacher, hasLti, setLastFunction, setLastApiResult]);

  const loadAssignmentGroups = useCallback(async () => {
    if (!teacher || !hasLti) return;
    try {
      setLastFunction('GET /api/prompt/assignment-groups');
      const list = await promptApi.getAssignmentGroups();
      setLastApiResult('GET /api/prompt/assignment-groups', 200, true);
      setAssignmentGroups(list ?? []);
    } catch (e) {
      if (e instanceof promptApi.NeedsManualTokenError) setShowManualTokenModal(true);
      setAssignmentGroups([]);
    }
  }, [teacher, hasLti, setLastFunction, setLastApiResult]);

  const loadRubrics = useCallback(async () => {
    if (!teacher || !hasLti) return;
    try {
      setLastFunction('GET /api/prompt/rubrics');
      const list = await promptApi.getRubrics();
      setLastApiResult('GET /api/prompt/rubrics', 200, true);
      setRubrics(list ?? []);
    } catch (e) {
      if (e instanceof promptApi.NeedsManualTokenError) setShowManualTokenModal(true);
      setRubrics([]);
    }
  }, [teacher, hasLti, setLastFunction, setLastApiResult]);

  const load = useCallback(async (overrideId?: string) => {
    const id = overrideId ?? assignmentId;
    if (!hasLti || !id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setLastFunction('GET /api/prompt/config');
      const data = await promptApi.getPromptConfig(id);
      setLastApiResult('GET /api/prompt/config', 200, true);
      void appendBridgeLog('prompt-manager-config', 'TeacherConfigPage: GET /config client', {
        requestAssignmentId: id,
        hasBody: data != null,
        textPromptsCount: data?.prompts?.length ?? 0,
        promptMode: data?.promptMode,
        resolvedAssignmentId: data?.resolvedAssignmentId,
      });
      setConfig(data ?? null);
      if (data) {
        const promptExtraction = extractNormalizedPrompts(data as promptApi.PromptConfig & Record<string, unknown>);
        const normalizedPrompts = promptExtraction.prompts;
        setMinutes(data.minutes ?? 5);
        setPrompts(normalizedPrompts);
        setAccessCode(data.accessCode ?? '');
        setModuleId(data.moduleId ?? '');
        setAssignmentGroupId(data.assignmentGroupId ?? '');
        setRubricId((data.rubricId ?? '').trim());
        setAssignmentName(data.assignmentName ?? '');
        setPointsPossible(Math.max(0, Math.round(Number(data.pointsPossible ?? 10) || 10)));
        setDueAt(data.dueAt ?? '');
        setUnlockAt(data.unlockAt ?? '');
        setLockAt(data.lockAt ?? '');
        const aa = Number(data.allowedAttempts ?? 1);
        setAllowedAttempts(Number.isFinite(aa) && aa === -1 ? -1 : Math.max(1, aa || 1));
        setInstructions(data.instructions ?? '');
        setSignToVoiceRequired(data.signToVoiceRequired === true);
        setPromptMode(data.promptMode ?? 'text');
        setPromptRteRemountKey((k) => k + 1);
        void appendBridgeLog('prompt-manager-config', 'TeacherConfigPage: normalized prompt payload for editor', {
          assignmentId: id,
          promptMode: data.promptMode ?? null,
          sourceField: promptExtraction.sourceField,
          containsAslEmbedBlocks: promptExtraction.rawPrompts.some((p) => /data-asl-express-v=["']1["']/i.test(p)),
          containsStandaloneQlEditorRoot: promptExtraction.rawPrompts.some((p) =>
            /<div\b[^>]*class=["'][^"']*\bql-editor\b/i.test(p.trim()),
          ),
          normalizedPromptCount: normalizedPrompts.length,
          rawSampleLengths: promptExtraction.rawPrompts.slice(0, 5).map((p) => p.length),
          sampleLengths: normalizedPrompts.slice(0, 5).map((p) => p.length),
          samplePreview: normalizedPrompts
            .slice(0, 2)
            .map((p) => p.replace(/\s+/g, ' ').slice(0, 140)),
          itemTypeSample: Array.isArray(data.prompts)
            ? data.prompts.slice(0, 5).map((x) => (x == null ? 'nullish' : typeof x))
            : [],
        });
        if (data.promptMode === 'youtube' && data.youtubePromptConfig?.videoId) {
          const vid = data.youtubePromptConfig.videoId;
          const yc = data.youtubePromptConfig;
          setYoutubeUrlOrId(`https://www.youtube.com/watch?v=${encodeURIComponent(vid)}`);
          setYoutubeLabel(yc.label ?? '');
          const hasClip =
            Number.isFinite(Number(yc.clipStartSec)) &&
            Number.isFinite(Number(yc.clipEndSec)) &&
            Math.floor(Number(yc.clipEndSec)) > Math.max(0, Math.floor(Number(yc.clipStartSec)));
          if (hasClip) {
            setYoutubeClipStartSec(Math.max(0, Math.floor(Number(yc.clipStartSec))));
            setYoutubeClipEndSec(Math.floor(Number(yc.clipEndSec)));
          } else {
            const legacyDur = Math.floor(Number((yc as { durationSec?: number }).durationSec));
            setYoutubeClipStartSec(0);
            setYoutubeClipEndSec(Number.isFinite(legacyDur) && legacyDur >= 1 ? legacyDur : 60);
          }
          setYoutubePreviewVideoId(vid);
          setYoutubeFieldError(null);
          setYoutubePreviewDuration(0);
          setYoutubeApiFailed(false);
          setYoutubePreviewRetryNonce(0);
          setYoutubeAllowStudentCaptions(yc.allowStudentCaptions === true);
          const sm = yc.subtitleMask;
          setYoutubeSubtitleMaskEnabled(sm?.enabled === true);
          const hp = Number(sm?.heightPercent);
          setYoutubeSubtitleMaskHeight(
            Number.isFinite(hp) ? Math.min(30, Math.max(5, Math.round(hp))) : 15,
          );
          setSelectedDecks([]);
          setTotalCards(10);
          setDeckFilterCurricula([]);
          setDeckFilterUnits([]);
          setDeckFilterSections([]);
          setPendingDeckFilterSeedIds(null);
        } else if (data.videoPromptConfig) {
          const loadedDecks = data.videoPromptConfig.selectedDecks ?? [];
          setSelectedDecks(loadedDecks);
          setTotalCards(data.videoPromptConfig.totalCards ?? 10);
          const deckIds = loadedDecks.map((d) => d.id).filter(Boolean);
          setPendingDeckFilterSeedIds(deckIds.length ? deckIds : null);
          setYoutubeUrlOrId('');
          setYoutubeLabel('');
          setYoutubeClipStartSec(0);
          setYoutubeClipEndSec(60);
          setYoutubePreviewVideoId(null);
          setYoutubeFieldError(null);
          setYoutubePreviewDuration(0);
          setYoutubeApiFailed(false);
          setYoutubePreviewRetryNonce(0);
          setYoutubeAllowStudentCaptions(false);
          setYoutubeSubtitleMaskEnabled(false);
          setYoutubeSubtitleMaskHeight(15);
        } else {
          setSelectedDecks([]);
          setTotalCards(10);
          setDeckFilterCurricula([]);
          setDeckFilterUnits([]);
          setDeckFilterSections([]);
          setPendingDeckFilterSeedIds(null);
          setYoutubeUrlOrId('');
          setYoutubeLabel('');
          setYoutubeClipStartSec(0);
          setYoutubeClipEndSec(60);
          setYoutubePreviewVideoId(null);
          setYoutubeFieldError(null);
          setYoutubePreviewDuration(0);
          setYoutubeApiFailed(false);
          setYoutubePreviewRetryNonce(0);
          setYoutubeAllowStudentCaptions(false);
          setYoutubeSubtitleMaskEnabled(false);
          setYoutubeSubtitleMaskHeight(15);
        }
      } else {
        setMinutes(5);
        setPrompts([]);
        setAccessCode('');
        setModuleId('');
        setAssignmentGroupId('');
        setRubricId('');
        setAssignmentName('');
        setPointsPossible(10);
        setDueAt('');
        setUnlockAt('');
        setLockAt('');
        setAllowedAttempts(1);
        setInstructions('');
        setSignToVoiceRequired(false);
        setPromptMode('text');
        setSelectedDecks([]);
        setTotalCards(10);
        setDeckFilterCurricula([]);
        setDeckFilterUnits([]);
        setDeckFilterSections([]);
        setPendingDeckFilterSeedIds(null);
        setYoutubeUrlOrId('');
        setYoutubeLabel('');
        setYoutubeClipStartSec(0);
        setYoutubeClipEndSec(60);
        setYoutubePreviewVideoId(null);
        setYoutubeFieldError(null);
        setYoutubePreviewDuration(0);
        setYoutubeApiFailed(false);
        setYoutubePreviewRetryNonce(0);
        setYoutubeAllowStudentCaptions(false);
        setYoutubeSubtitleMaskEnabled(false);
        setYoutubeSubtitleMaskHeight(15);
      }
    } catch (e: unknown) {
      if (e instanceof promptApi.NeedsManualTokenError) {
        setShowManualTokenModal(true);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setLastApiError('GET /api/prompt/config', 0, msg);
      }
    } finally {
      setLoading(false);
    }
  }, [hasLti, assignmentId, setLastFunction, setLastApiResult, setLastApiError]);

  useEffect(() => {
    if (teacher && hasLti) {
      void loadAssignments();
    } else {
      assignmentsLoadGenRef.current += 1;
      setLoadingAssignments(false);
    }
  }, [teacher, hasLti, loadAssignments]);

  useEffect(() => {
    const onCanvasTokenCleared = () => {
      setShowManualTokenModal(true);
      setError(null);
      setLastApiError('manual-token', 401, 'Canvas token cleared. Enter a new token to continue.');
    };
    window.addEventListener('aslexpress:canvas-token-cleared', onCanvasTokenCleared as EventListener);
    return () => {
      window.removeEventListener('aslexpress:canvas-token-cleared', onCanvasTokenCleared as EventListener);
    };
  }, [setLastApiError]);

  useEffect(() => {
    if (assignmentId) setConfigAssignValue(assignmentId);
    else setConfigAssignValue(assignmentActionMode === 'create' ? '__new__' : '');
  }, [assignmentId, assignmentActionMode]);

  useEffect(() => {
    if (assignmentActionMode === 'grade' && configAssignValue === '__new__') {
      setConfigAssignValue('');
    }
    if (assignmentActionMode === 'create' && configAssignValue !== '__new__') {
      setConfigAssignValue('__new__');
    }
    if (assignmentActionMode === 'edit' && (!configAssignValue || configAssignValue === '__new__')) {
      setConfigAssignValue(assignmentId || '');
    }
  }, [assignmentActionMode, configAssignValue, assignmentId]);

  useEffect(() => {
    if (teacher && hasLti) {
      void loadModules();
      void loadAssignmentGroups();
      void loadRubrics();
      if (assignmentId) void load();
      else setLoading(false);
    } else {
      setLoading(false);
    }
    // Intentionally omit load/loadModules/… from deps: their identities can change every render (e.g. debug context),
    // which would re-fire Canvas + config fetches without assignment/course changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run when teacher, LTI course context, or assignment id changes only
  }, [teacher, hasLti, assignmentId]);

  /** Normalize rubric id string if the course list uses the same id with different formatting. */
  useEffect(() => {
    const rid = rubricId.trim();
    if (!rid || rubrics.length === 0) return;
    const hit = rubrics.find((r) => r.id === rid);
    if (hit && hit.id !== rubricId) {
      setRubricId(hit.id);
    }
  }, [rubrics, rubricId]);

  const { hubCurricula: deckPickerCurricula, hubUnits: deckPickerUnits, hubSections: deckPickerSections, filteredPlaylists: deckPickerPlaylists } =
    useMemo(
      () => computeDeckHubFilters(deckHierarchyPlaylists, deckFilterCurricula, deckFilterUnits, deckFilterSections),
      [deckHierarchyPlaylists, deckFilterCurricula, deckFilterUnits, deckFilterSections],
    );

  useEffect(() => {
    if (promptMode !== 'decks' || !teacher || !hasLti) {
      return;
    }
    let cancelled = false;
    (async () => {
      setDeckPickerLoading(true);
      setDeckPickerError(null);
      try {
        setLastFunction('GET /api/flashcard/student-playlists-batch');
        const { playlists, error } = await flashcardTeacherApi.getStudentPlaylistsBatchForDeckPicker(true);
        if (cancelled) return;
        setDeckHierarchyPlaylists(playlists);
        if (playlists.length > 0) {
          setDeckPickerError(null);
        } else if (error === 'announcement_missing') {
          setDeckPickerError('Course materials are not yet configured. Configure flashcard course settings first.');
        }
        setLastApiResult('GET /api/flashcard/student-playlists-batch', 200, true);
      } catch (e: unknown) {
        if (e instanceof promptApi.NeedsManualTokenError) {
          if (!cancelled) setShowManualTokenModal(true);
        } else if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          setDeckPickerError(msg);
          setDeckHierarchyPlaylists([]);
          setLastApiError('GET /api/flashcard/student-playlists-batch', 0, msg);
        }
      } finally {
        if (!cancelled) setDeckPickerLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [promptMode, teacher, hasLti, deckPickerRefreshKey, setLastFunction, setLastApiResult, setLastApiError]);

  const toggleDeckFilterCurriculum = (c: string) => {
    setDeckFilterCurricula((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );
  };

  const toggleDeckFilterUnit = (u: string) => {
    setDeckFilterUnits((prev) => (prev.includes(u) ? prev.filter((x) => x !== u) : [...prev, u]));
  };

  const toggleDeckFilterSection = (s: string) => {
    setDeckFilterSections((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  const addDeckToSelection = (deck: { id: string; title: string }) => {
    if (!deck.id) return;
    setSelectedDecks((d) =>
      d.some((x) => x.id === deck.id) ? d : [...d, { id: deck.id, title: deck.title }],
    );
  };

  const applyDeckFiltersFromSelectedDeckIds = (deckIds: string[], sourceRows: PlaylistHierarchyRow[]) => {
    if (!deckIds.length || !sourceRows.length) return false;
    const selected = sourceRows.filter((row) => deckIds.includes(row.id));
    if (!selected.length) return false;
    setDeckFilterCurricula([...new Set(selected.map((row) => row.curriculum).filter(Boolean))]);
    setDeckFilterUnits([...new Set(selected.map((row) => row.unit).filter(Boolean))]);
    setDeckFilterSections([...new Set(selected.map((row) => row.section).filter(Boolean))]);
    return true;
  };

  useEffect(() => {
    if (!pendingDeckFilterSeedIds || pendingDeckFilterSeedIds.length === 0) return;
    if (applyDeckFiltersFromSelectedDeckIds(pendingDeckFilterSeedIds, deckHierarchyPlaylists)) {
      setPendingDeckFilterSeedIds(null);
    }
  }, [pendingDeckFilterSeedIds, deckHierarchyPlaylists]);

  const handleYoutubeUrlBlur = () => {
    setYoutubeFieldError(null);
    const t = youtubeUrlOrId.trim();
    if (!t) {
      setYoutubePreviewVideoId(null);
      setYoutubePreviewDuration(0);
      setYoutubeApiFailed(false);
      setYoutubePreviewRetryNonce(0);
      return;
    }
    try {
      setYoutubePreviewVideoId(normalizeYoutubeInputToVideoIdClient(t));
      setYoutubePreviewDuration(0);
      setYoutubeApiFailed(false);
      setYoutubePreviewRetryNonce(0);
    } catch (e) {
      setYoutubePreviewVideoId(null);
      setYoutubePreviewDuration(0);
      setYoutubeApiFailed(false);
      setYoutubePreviewRetryNonce(0);
      setYoutubeFieldError(e instanceof Error ? e.message : 'Invalid YouTube URL or video ID.');
    }
  };

  const handleSave = async () => {
    if (!teacher || !hasLti) return;
    if (!moduleId.trim()) {
      setError('Select a Canvas module. All assignments must be placed in a module.');
      return;
    }
    if (promptMode === 'decks' && selectedDecks.length === 0) {
      setError('Select at least one flashcard deck when using Deck Prompts.');
      return;
    }
    if (promptMode === 'youtube') {
      const raw = youtubeUrlOrId.trim();
      if (!raw) {
        setError('Enter a YouTube URL or video ID.');
        return;
      }
      try {
        normalizeYoutubeInputToVideoIdClient(raw);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Invalid YouTube URL or video ID.');
        return;
      }
      const clipStart = Math.max(0, Math.floor(Number(youtubeClipStartSec)));
      const clipEnd = Math.floor(Number(youtubeClipEndSec));
      if (!Number.isFinite(clipEnd) || clipEnd <= clipStart) {
        setError('Clip end (seconds) must be greater than clip start by at least 1 second.');
        return;
      }
      if (clipEnd - clipStart > 86400) {
        setError('YouTube clip cannot span more than 24 hours.');
        return;
      }
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      let targetId = assignmentId;
      if (!targetId) {
        // Course nav: create assignment first, then save config
        setLastFunction('POST /api/prompt/create-assignment');
        const { assignmentId: newId } = await promptApi.createAssignment(
          assignmentName.trim() || 'ASL Express Assignment',
          {
            moduleId: moduleId.trim(),
            assignmentGroupId: assignmentGroupId || undefined,
            newGroupName: assignmentGroupId === '__new__' ? createGroupName.trim() || undefined : undefined,
          }
        );
        setLastApiResult('POST /api/prompt/create-assignment', 200, true);
        targetId = newId;
        if (assignmentGroupId === '__new__' && createGroupName.trim()) {
          setAssignmentGroupId('');
          setCreateGroupName('');
          await loadAssignmentGroups();
        }
        setSearchParams({ assignmentId: newId });
      }
      setLastFunction('PUT /api/prompt/config');
      await promptApi.putPromptConfig(
        {
          minutes,
          prompts,
          accessCode,
          assignmentName: assignmentName.trim() || undefined,
          moduleId: moduleId.trim(),
          assignmentGroupId: assignmentGroupId || undefined,
          newGroupName: assignmentGroupId === '__new__' ? createGroupName.trim() || undefined : undefined,
          rubricId: rubricId || undefined,
          pointsPossible,
          instructions: instructions.trim() || undefined,
          dueAt: dueAt.trim() || undefined,
          unlockAt: unlockAt.trim() || undefined,
          lockAt: lockAt.trim() || undefined,
          allowedAttempts,
          signToVoiceRequired: promptMode === 'youtube' ? signToVoiceRequired : false,
          promptMode,
          videoPromptConfig: promptMode === 'decks' ? { selectedDecks, totalCards } : undefined,
          youtubePromptConfig:
            promptMode === 'youtube'
              ? {
                  urlOrId: youtubeUrlOrId.trim(),
                  label: youtubeLabel.trim() || undefined,
                  clipStartSec: Math.max(0, Math.floor(Number(youtubeClipStartSec))),
                  clipEndSec: Math.floor(Number(youtubeClipEndSec)),
                  allowStudentCaptions: youtubeAllowStudentCaptions,
                  subtitleMask: {
                    enabled: youtubeSubtitleMaskEnabled,
                    heightPercent: Math.min(
                      30,
                      Math.max(5, Math.round(Number(youtubeSubtitleMaskHeight) || 15)),
                    ),
                  },
                }
              : undefined,
        },
        targetId!
      );
      setLastApiResult('PUT /api/prompt/config', 200, true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      if (assignmentGroupId === '__new__' && createGroupName.trim()) {
        setAssignmentGroupId('');
        setCreateGroupName('');
        loadAssignmentGroups();
      }
      if (targetId) load(targetId ?? undefined);
    } catch (e: unknown) {
      if (e instanceof promptApi.NeedsManualTokenError) {
        setShowManualTokenModal(true);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setLastApiError('PUT /api/prompt/config', 0, msg);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCreateModule = async () => {
    if (!teacher || !hasLti || creatingModule) return;
    const name = createModuleName.trim();
    if (!name) return;
    setCreatingModule(true);
    setError(null);
    try {
      setLastFunction('POST /api/prompt/modules');
      const pos = createModulePosition === '' ? undefined : Number(createModulePosition);
      const created = await promptApi.createModule(name, pos);
      setLastApiResult('POST /api/prompt/modules', 201, true);
      setCreateModuleName('');
      setCreateModulePosition('');
      setShowCreateModule(false);
      await loadModules();
      setModuleId(String(created.id));
    } catch (e: unknown) {
      if (e instanceof promptApi.NeedsManualTokenError) {
        setShowManualTokenModal(true);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setLastApiError('POST /api/prompt/modules', 0, msg);
      }
    } finally {
      setCreatingModule(false);
    }
  };

  const ASL_CODES = ['HELLO', 'THANK-YOU', 'PLEASE', 'SORRY', 'FRIEND', 'FAMILY', 'LOVE', 'HELP', 'LEARN', 'DEAF', 'SIGN', 'UNDERSTAND', 'COMMUNITY', 'CULTURE', 'PROUD', 'BEAUTIFUL', 'STRONG', 'TOGETHER', 'RESPECT', 'EQUAL', 'DEAF-PRIDE', 'SIGN-LANGUAGE', 'HANDS-UP', 'DEAF-GAIN', 'VISUAL-LANGUAGE', 'DEAF-HEART', 'SIGN-ON', 'HANDS-SPEAK'];
  const generateAccessCode = () =>
    setAccessCode(ASL_CODES[Math.floor(Math.random() * ASL_CODES.length)]);

  const addPrompt = () => setPrompts((p) => [...p, '']);
  const updatePrompt = (i: number, v: string) =>
    setPrompts((p) => {
      const next = [...p];
      next[i] = v;
      return next;
    });
  const removePrompt = (i: number) => setPrompts((p) => p.filter((_, j) => j !== i));

  const enterCreateMode = () => {
    setAssignmentActionMode('create');
    setSearchParams({ create: '1' });
    setConfigAssignValue('__new__');
    setAssignmentName('ASL Express Assignment');
    setMinutes(5);
    setPrompts([]);
    setAccessCode('');
    setModuleId('');
    setAssignmentGroupId('');
    setRubricId('');
    setPointsPossible(10);
    setDueAt('');
    setUnlockAt('');
    setLockAt('');
    setAllowedAttempts(1);
    setInstructions('');
    setSignToVoiceRequired(false);
    setPromptMode('text');
    setYoutubeUrlOrId('');
    setYoutubeLabel('');
    setYoutubeClipStartSec(0);
    setYoutubeClipEndSec(60);
    setYoutubePreviewVideoId(null);
    setYoutubeFieldError(null);
    setYoutubePreviewDuration(0);
    setYoutubeApiFailed(false);
    setYoutubePreviewRetryNonce(0);
    setYoutubeAllowStudentCaptions(false);
    setYoutubeSubtitleMaskEnabled(false);
    setYoutubeSubtitleMaskHeight(15);
  };

  const handleConfigAssignSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    setConfigAssignValue(v);
    if (assignmentActionMode === 'grade') {
      if (!v) {
        setGradeDropdownValue('');
        return;
      }
      const a = configuredAssignments.find((x) => x.id === v);
      if (a) {
        setGradeDropdownValue(v);
        setGradeConfirmModal({ name: a.name, id: a.id });
      }
      return;
    }
    if (v) {
      setSearchParams({ assignmentId: v });
    }
  };

  const handleCreateNewAssignment = async () => {
    if (!teacher || !hasLti || creatingAssignment) return;
    if (!moduleId.trim()) {
      setError('Select a Canvas module. All assignments must be placed in a module.');
      return;
    }
    const name = createAssignName.trim() || 'ASL Express Assignment';
    setCreatingAssignment(true);
    setError(null);
    try {
      setLastFunction('POST /api/prompt/create-assignment');
      const { assignmentId: newId } = await promptApi.createAssignment(name, {
        moduleId: moduleId.trim(),
        assignmentGroupId: assignmentGroupId || undefined,
        newGroupName: assignmentGroupId === '__new__' ? createGroupName.trim() || undefined : undefined,
      });
      setLastApiResult('POST /api/prompt/create-assignment', 200, true);
      setCreateAssignName('');
      await loadAssignments();
      setSearchParams({ assignmentId: newId });
      setAssignmentActionMode('edit');
      setConfigAssignValue(newId);
    } catch (e: unknown) {
      if (e instanceof promptApi.NeedsManualTokenError) {
        setShowManualTokenModal(true);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setLastApiError('POST /api/prompt/create-assignment', 0, msg);
      }
    } finally {
      setCreatingAssignment(false);
    }
  };

  const afterConfiguredAssignmentRemoved = async () => {
    setSearchParams({ create: '1' });
    setAssignmentActionMode('create');
    setConfigAssignValue('__new__');
    setGradeDropdownValue('');
    setAssignmentName('ASL Express Assignment');
    setMinutes(5);
    setPrompts([]);
    setAccessCode('');
    setModuleId('');
    setAssignmentGroupId('');
    setRubricId('');
    setPointsPossible(10);
    setDueAt('');
    setUnlockAt('');
    setLockAt('');
    setAllowedAttempts(1);
    setInstructions('');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    await loadAssignments();
  };

  const handleRemoveFromPrompts = async () => {
    if (!teacher || !hasLti || assignmentRemoval || !configAssignValue || configAssignValue === '__new__') return;
    const target = configuredAssignments.find((a) => a.id === configAssignValue);
    const label = target?.name ?? `Assignment ${configAssignValue}`;
    const ok = window.confirm(
      `Remove "${label}" from Prompts?\n\nThe Canvas assignment stays in the course; only Prompt Manager settings are cleared for it.`
    );
    if (!ok) return;
    setAssignmentRemoval('prompts');
    setError(null);
    try {
      setLastFunction('POST /api/prompt/configured-assignments/:id/remove-from-prompts');
      await promptApi.removeConfiguredAssignmentFromPrompts(configAssignValue);
      setLastApiResult('POST /api/prompt/configured-assignments/:id/remove-from-prompts', 204, true);
      await afterConfiguredAssignmentRemoved();
    } catch (e: unknown) {
      if (e instanceof promptApi.NeedsManualTokenError) {
        setShowManualTokenModal(true);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setLastApiError('POST /api/prompt/configured-assignments/:id/remove-from-prompts', 0, msg);
      }
    } finally {
      setAssignmentRemoval(null);
    }
  };

  const handleDeleteFromCanvas = async () => {
    if (!teacher || !hasLti || assignmentRemoval || !configAssignValue || configAssignValue === '__new__') return;
    const target = configuredAssignments.find((a) => a.id === configAssignValue);
    const label = target?.name ?? `Assignment ${configAssignValue}`;
    const ok = window.confirm(
      `Delete "${label}" from Canvas?\n\nThis removes the assignment from the course and from Prompts. This cannot be undone.`
    );
    if (!ok) return;
    setAssignmentRemoval('canvas');
    setError(null);
    try {
      setLastFunction('DELETE /api/prompt/configured-assignments/:assignmentId');
      await promptApi.deleteConfiguredAssignment(configAssignValue);
      setLastApiResult('DELETE /api/prompt/configured-assignments/:assignmentId', 204, true);
      await afterConfiguredAssignmentRemoved();
    } catch (e: unknown) {
      if (e instanceof promptApi.NeedsManualTokenError) {
        setShowManualTokenModal(true);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setLastApiError('DELETE /api/prompt/configured-assignments/:assignmentId', 0, msg);
      }
    } finally {
      setAssignmentRemoval(null);
    }
  };

  const confirmGradeOpen = () => {
    if (gradeConfirmModal) {
      navigate(`/viewer?assignmentId=${encodeURIComponent(gradeConfirmModal.id)}`);
      setGradeConfirmModal(null);
      setGradeDropdownValue('');
    }
  };

  const cancelGradeOpen = () => {
    setGradeConfirmModal(null);
    setGradeDropdownValue('');
  };

  const handleReset = async () => {
    if (!teacher || !hasLti) return;
    setMinutes(5);
    setPrompts([]);
    setAccessCode('');
    setModuleId('');
    setAssignmentName('');
    setPointsPossible(10);
    setDueAt('');
    setUnlockAt('');
    setLockAt('');
    setAllowedAttempts(1);
    setInstructions('');
    setSignToVoiceRequired(false);
    setPromptMode('text');
    setSelectedDecks([]);
    setTotalCards(10);
    setDeckPromptWarning(null);
    setEstimatedSessionLength('');
    setDeckFilterCurricula([]);
    setDeckFilterUnits([]);
    setDeckFilterSections([]);
    setPendingDeckFilterSeedIds(null);
    setDeckPickerError(null);
    setYoutubeUrlOrId('');
    setYoutubeLabel('');
    setYoutubeClipStartSec(0);
    setYoutubeClipEndSec(60);
    setYoutubePreviewVideoId(null);
    setYoutubeFieldError(null);
    setYoutubePreviewDuration(0);
    setYoutubeApiFailed(false);
    setYoutubePreviewRetryNonce(0);
    setYoutubeAllowStudentCaptions(false);
    setYoutubeSubtitleMaskEnabled(false);
    setYoutubeSubtitleMaskHeight(15);
    if (!assignmentId) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return;
    }
    setSaving(true);
    setResetting(true);
    setError(null);
    setSaved(false);
    try {
      setLastFunction('PUT /api/prompt/config');
      await promptApi.putPromptConfig(
        { minutes: 5, prompts: [], accessCode: '', assignmentName: '', moduleId: '', pointsPossible: 10, instructions: '', dueAt: '', unlockAt: '', lockAt: '', allowedAttempts: 1, signToVoiceRequired: false, promptMode: 'text' },
        assignmentId
      );
      setLastApiResult('PUT /api/prompt/config', 200, true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: unknown) {
      if (e instanceof promptApi.NeedsManualTokenError) {
        setShowManualTokenModal(true);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setLastApiError('PUT /api/prompt/config', 0, msg);
      }
    } finally {
      setSaving(false);
      setResetting(false);
    }
  };

  const configBlockingLoader = useMemo(() => {
    if (creatingModule) return { active: true as const, message: 'Creating module…', subMessage: undefined as string | undefined };
    if (assignmentRemoval === 'prompts')
      return { active: true as const, message: 'Removing from Prompts…', subMessage: undefined as string | undefined };
    if (assignmentRemoval === 'canvas')
      return { active: true as const, message: 'Deleting from Canvas…', subMessage: undefined as string | undefined };
    if (creatingAssignment) return { active: true as const, message: 'Creating assignment…', subMessage: undefined as string | undefined };
    if (saving) return { active: true as const, message: 'Saving…', subMessage: undefined as string | undefined };
    if (resetting) return { active: true as const, message: 'Resetting…', subMessage: undefined as string | undefined };
    if (assignmentId && loading) return { active: true as const, message: 'Loading configuration…', subMessage: undefined as string | undefined };
    if (loadingAssignments) return { active: true as const, message: 'Loading assignments…', subMessage: undefined as string | undefined };
    return { active: false as const, message: '', subMessage: undefined as string | undefined };
  }, [
    creatingModule,
    assignmentRemoval,
    creatingAssignment,
    saving,
    resetting,
    assignmentId,
    loading,
    loadingAssignments,
  ]);

  const configBlockingOverlay = (
    <AppBlockingLoader
      active={configBlockingLoader.active}
      message={configBlockingLoader.message}
      subMessage={configBlockingLoader.subMessage}
    />
  );

  const handleApplyTrueWay = useCallback(async () => {
    if (!teacher || !hasLti) return;
    setImportBusy(true);
    setTrueWayApplyMessage(null);
    try {
      const res = await promptApi.applyTrueWayTemplates();
      const n = typeof res.updated === 'number' ? res.updated : 0;
      setTrueWayApplyMessage(n > 0 ? `Updated ${n} assignment(s) from titles.` : 'No matching assignments found.');
      await loadAssignments();
    } catch (e) {
      setTrueWayApplyMessage(e instanceof Error ? e.message : String(e));
      if (e instanceof promptApi.NeedsManualTokenError) setShowManualTokenModal(true);
    } finally {
      setImportBusy(false);
    }
  }, [teacher, hasLti, loadAssignments]);

  /** Canvas module containing the assignment (for defaulting the import modal module picker). */
  const resolveImportModuleIdForAssignment = useCallback(async (assignmentCanvasId: string): Promise<string> => {
    const id = assignmentCanvasId.trim();
    if (!id) return '';
    try {
      const opts = await promptApi.getAssignmentImportOptions(id, id);
      const mid = opts.targetCanvasModuleId;
      if (mid != null && String(mid).trim()) return String(mid);
    } catch {
      /* teacher can pick module manually */
    }
    return '';
  }, []);

  const openImportModal = useCallback(async () => {
    if (!teacher || !hasLti) return;
    setImportModalOpen(true);
    setImportModalMessage(null);
    setTrueWayApplyMessage(null);
    setImportPromptModeChoice('auto');
    setImportModalBusy(true);
    setImportModuleId('');
    try {
      if (!modules.length) {
        void loadModules();
      }
      let brief = importCanvasBriefRef.current;
      if (!brief?.allAssignments?.length) {
        const res = await loadAssignments();
        brief = res?.canvasImport ?? null;
      }
      if (!brief?.allAssignments?.length) {
        setImportCanvasBrief(null);
        setImportSourceAssignmentId('');
        setImportModalMessage('Could not load course assignments. Try again after the list finishes loading.');
        return;
      }
      setImportCanvasBrief(brief);
      const preferred = assignmentId && brief.allAssignments.some((a) => a.id === assignmentId)
        ? assignmentId
        : '';
      const first = preferred || brief.allAssignments[0]?.id || '';
      setImportSourceAssignmentId(first);
      if (first) {
        setImportModuleId(await resolveImportModuleIdForAssignment(first));
      }
    } catch (e) {
      setImportCanvasBrief(null);
      setImportSourceAssignmentId('');
      setImportModalMessage(e instanceof Error ? e.message : String(e));
      if (e instanceof promptApi.NeedsManualTokenError) setShowManualTokenModal(true);
    } finally {
      setImportModalBusy(false);
    }
  }, [teacher, hasLti, modules.length, loadModules, assignmentId, loadAssignments, resolveImportModuleIdForAssignment]);

  const handleImportSourceAssignmentChange = useCallback(
    async (e: ChangeEvent<HTMLSelectElement>) => {
      const v = e.target.value;
      setImportSourceAssignmentId(v);
      setImportModalMessage(null);
      if (!v.trim()) {
        setImportModuleId('');
        return;
      }
      setImportModuleId(await resolveImportModuleIdForAssignment(v));
    },
    [resolveImportModuleIdForAssignment],
  );

  const closeImportModal = useCallback(() => {
    setImportModalOpen(false);
    setImportModalMessage(null);
    setTrueWayApplyMessage(null);
    setImportModuleId('');
    setImportPromptModeChoice('auto');
  }, []);

  const handleImportModalSingleMerge = useCallback(async () => {
    if (!teacher || !hasLti) return;
    const sid = importSourceAssignmentId.trim();
    const mid = importModuleId.trim();
    if (!sid) {
      setImportModalMessage('Select a source assignment to import.');
      return;
    }
    if (!mid) {
      setImportModalMessage('Select a Canvas module. The Prompter tool is added above the assignment in that module (same as saving a new assignment).');
      return;
    }
    setImportModalBusy(true);
    setImportModalMessage(null);
    try {
      await promptApi.importSinglePromptAssignment({
        sourceAssignmentId: sid,
        targetAssignmentId: sid,
        moduleId: mid,
        ...(importPromptModeChoice !== 'auto' ? { promptMode: importPromptModeChoice } : {}),
      });
      await loadAssignments();
      await load(sid);
      setImportInfo(
        'Assignment settings were imported. For older student work, open Grading and confirm prompts still display (legacy data may live in submission comments until you clean it up there). Nothing was auto-deleted or remuxed.',
      );
      setImportModalOpen(false);
      setAssignmentActionMode('edit');
      setConfigAssignValue(sid);
      setSearchParams((prev) => {
        const p = new URLSearchParams(prev);
        p.delete('create');
        p.set('assignmentId', sid);
        return p;
      });
    } catch (e) {
      setImportModalMessage(e instanceof Error ? e.message : String(e));
      if (e instanceof promptApi.NeedsManualTokenError) setShowManualTokenModal(true);
    } finally {
      setImportModalBusy(false);
    }
  }, [
    teacher,
    hasLti,
    importSourceAssignmentId,
    importModuleId,
    importPromptModeChoice,
    loadAssignments,
    load,
    setSearchParams,
  ]);

  if (!teacher || !context) {
    return (
      <>
        {configBlockingOverlay}
        <div className="prompter-page">
          <div className="prompter-card">
            <p className="prompter-info-message">Teacher access required.</p>
          </div>
        </div>
      </>
    );
  }

  const showForm = hasLti;
  const canEditAssignmentSettings = assignmentActionMode === 'edit' && !!assignmentId;

  if (assignmentId && loading) {
    return (
      <>
        {configBlockingOverlay}
        <div className="prompter-page" aria-hidden="true">
          <div className="prompter-card" />
        </div>
      </>
    );
  }

  const assignmentGroupSelector = (
    <div className="prompter-settings-section">
      <label className="prompter-settings-label"><strong>Assignment Group:</strong></label>
      <select
        className="prompter-settings-input"
        value={assignmentGroupId}
        onChange={(e) => setAssignmentGroupId(e.target.value)}
      >
        <option value="">— Select Group —</option>
        {assignmentGroups.map((g) => (
          <option key={g.id} value={String(g.id)}>
            {g.name}
          </option>
        ))}
        <option value="__new__">+ Create New Group...</option>
      </select>
      {assignmentGroupId === '__new__' && (
        <div className="prompter-new-group-input">
          <input type="text" value={createGroupName} onChange={(e) => setCreateGroupName(e.target.value)} placeholder="New group name" className="prompter-settings-input" />
          <p className="prompter-hint">Group will be created when you save.</p>
        </div>
      )}
    </div>
  );

  const rubricIdTrim = rubricId.trim();
  const rubricInCourseList = !!rubricIdTrim && rubrics.some((r) => r.id === rubricIdTrim);
  /** Config/assignment rubric id does not match any loaded course rubric option (yet or at all). */
  const rubricOrphanFromAssignment = !!rubricIdTrim && !rubricInCourseList;

  const rubricSelector = (
    <div className="prompter-settings-section">
      <label className="prompter-settings-label"><strong>Rubric (optional):</strong></label>
      <p className="prompter-hint">
        Matches the rubric attached to this assignment in Canvas when one is set (including after import).
        Labels come from the course rubrics list.
      </p>
      <select
        className="prompter-settings-input"
        value={rubricInCourseList ? rubricId : ''}
        onChange={(e) => setRubricId(e.target.value)}
      >
        <option value="">— No Rubric —</option>
        {rubrics.map((r) => (
          <option key={r.id} value={r.id}>
            {r.title} ({r.pointsPossible} pts)
          </option>
        ))}
      </select>
      {rubricOrphanFromAssignment ? (
        <p className="prompter-hint" style={{ marginTop: 6 }}>
          Canvas linked rubric id {rubricIdTrim} is not in the loaded course rubrics list. Choose a rubric below to
          replace it, or refresh after fixing Canvas data. Save still uses the linked id until you select a match.
        </p>
      ) : null}
    </div>
  );

  const moduleSelector = (
    <div className="prompter-settings-section">
      <label className="prompter-settings-label"><strong>Module:</strong></label>
      <select
        className="prompter-settings-input"
        value={moduleId}
        onChange={(e) => setModuleId(e.target.value)}
      >
        <option value="">— Select a module (required) —</option>
        {modules.map((m) => (
          <option key={m.id} value={String(m.id)}>
            {m.name}
          </option>
        ))}
      </select>
      <button type="button" className="prompter-btn-start-sm prompter-btn-secondary prompter-btn-mt" onClick={() => setShowCreateModule((s) => !s)}>
        + Create new module
      </button>
      {showCreateModule && (
        <div className="prompter-create-module-form">
          <input
            type="text"
            value={createModuleName}
            onChange={(e) => setCreateModuleName(e.target.value)}
            placeholder="Module name"
            className="prompter-settings-input"
          />
          <label className="prompter-settings-label prompter-settings-label-block">Placement in course</label>
          <select
            className="prompter-settings-input"
            value={createModulePosition}
            onChange={(e) => {
              const v = e.target.value;
              setCreateModulePosition(v === '' ? '' : Number(v));
            }}
          >
            <option value="">At end (default)</option>
            {Array.from({ length: Math.max(modules.length + 1, 1) }, (_, i) => i + 1).map((pos) => (
              <option key={pos} value={pos}>
                Position {pos} {pos === 1 ? '(first)' : pos === modules.length + 1 ? '(last)' : `(after module ${pos - 1})`}
              </option>
            ))}
          </select>
          <div className="prompter-settings-actions-row">
            <button
              type="button"
              onClick={handleCreateModule}
              disabled={creatingModule || !createModuleName.trim()}
              className="prompter-btn-ready"
            >
              {creatingModule ? <><span className="prompter-inline-spinner" /> Creating...</> : 'Create Module'}
            </button>
            <button type="button" onClick={() => { setShowCreateModule(false); setCreateModuleName(''); setCreateModulePosition(''); }} className="prompter-btn-secondary">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );


  return (
    <>
      {configBlockingOverlay}
    <div className="prompter-page">
      <div className="prompter-page-inner">
        <h1 className="prompter-settings-page-title">Prompt Manager Settings</h1>
        {error && <div className="prompter-alert-error">{error}</div>}
        {saved && <div className="prompter-alert-success">Saved.</div>}
        {teacher && hasLti && importInfo && (
          <p className="prompter-hint" style={{ marginTop: '0.75rem' }}>{importInfo}</p>
        )}

        {showForm && (
          <>
            {hasLti && (
              <div className="prompter-settings-card prompter-settings-card-compact">
                <h2 className="prompter-settings-card-title">Assignments</h2>
                  <div className="prompter-settings-section">
                    <label className="prompter-settings-label">Action</label>
                    <div className="prompter-settings-actions-row prompter-settings-actions-row-mb-sm">
                      <button
                        type="button"
                        className={assignmentActionMode === 'edit' ? 'prompter-btn-ready' : 'prompter-btn-secondary'}
                        onClick={() => setAssignmentActionMode('edit')}
                        disabled={loadingAssignments || saving}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={assignmentActionMode === 'grade' ? 'prompter-btn-ready' : 'prompter-btn-secondary'}
                        onClick={() => setAssignmentActionMode('grade')}
                        disabled={loadingAssignments || saving}
                      >
                        Grade
                      </button>
                      <button
                        type="button"
                        className={assignmentActionMode === 'create' ? 'prompter-btn-ready' : 'prompter-btn-secondary'}
                        onClick={enterCreateMode}
                        disabled={loadingAssignments || saving}
                      >
                        New Assignment
                      </button>
                      <button
                        type="button"
                        className="prompter-btn-secondary"
                        onClick={() => void openImportModal()}
                        disabled={loadingAssignments || saving || importModalBusy}
                      >
                        Import
                      </button>
                    </div>
                    {assignmentActionMode !== 'create' && (
                      <>
                        <label className="prompter-settings-label">
                          {assignmentActionMode === 'grade' ? 'Select assignment for grading' : 'Select an assignment to edit'}
                        </label>
                        <select
                          className="prompter-settings-input prompter-settings-input-max-480"
                          value={assignmentActionMode === 'grade' && configAssignValue === '__new__' ? '' : configAssignValue}
                          onChange={handleConfigAssignSelect}
                          disabled={loadingAssignments}
                        >
                          <option value="">
                            {loadingAssignments
                              ? 'Loading assignments...'
                              : assignmentActionMode === 'grade'
                                ? '— Select Assignment to Grade —'
                                : '— Select Assignment to Edit —'}
                          </option>
                          {configuredAssignments.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} ({a.submissionCount} submissions{assignmentActionMode === 'grade' ? `, ${a.ungradedCount} ungraded` : ''})
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                    {assignmentActionMode === 'edit' && configAssignValue !== '__new__' && !!configAssignValue && (
                      <div
                        className="prompter-settings-actions-row prompter-settings-actions-row-mt-sm"
                        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}
                      >
                        <button
                          type="button"
                          onClick={() => void handleRemoveFromPrompts()}
                          disabled={!!assignmentRemoval}
                          className="prompter-btn-secondary"
                        >
                          {assignmentRemoval === 'prompts' ? (
                            <>
                              <span className="prompter-inline-spinner" /> Removing…
                            </>
                          ) : (
                            'Remove from Prompts'
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteFromCanvas()}
                          disabled={!!assignmentRemoval}
                          className="prompter-btn-remove"
                        >
                          {assignmentRemoval === 'canvas' ? (
                            <>
                              <span className="prompter-inline-spinner" /> Deleting…
                            </>
                          ) : (
                            'Delete from Canvas'
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                  {assignmentActionMode === 'create' && (
                    <div className="prompter-create-module-form">
                      <label className="prompter-settings-label">New assignment name</label>
                      <input
                        type="text"
                        value={createAssignName}
                        onChange={(e) => setCreateAssignName(e.target.value)}
                        placeholder="e.g. ASL Warm-Up Submission"
                        className="prompter-settings-input"
                      />
                      <div className="prompter-settings-field prompter-settings-field-mt-sm">
                        {assignmentGroupSelector}
                      </div>
                      <div className="prompter-settings-field prompter-settings-field-mt-sm">{moduleSelector}</div>
                      <div className="prompter-settings-actions-row prompter-settings-actions-row-mt-md">
                        <button
                          type="button"
                          onClick={handleCreateNewAssignment}
                          disabled={creatingAssignment}
                          className="prompter-btn-ready"
                        >
                          {creatingAssignment ? <><span className="prompter-inline-spinner" /> Creating...</> : 'Create Assignment'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
            )}
          </>
        )}

        {showForm && (
          <div className="prompter-settings-card">
            <h2 className="prompter-settings-card-title">Configure Assignment</h2>
            {!canEditAssignmentSettings ? (
              <p className="prompter-hint">
                Create an assignment first, then switch to Edit mode to configure prompt settings.
              </p>
            ) : (
              <div className="prompter-settings-config-form">
                <div className="prompter-settings-two-col">
                    <div className="prompter-settings-col-assignment">
                    {promptMode === 'text' ? (
                      <div className="prompter-settings-section">
                        <label className="prompter-settings-label"><strong>Warm Up Minutes:</strong></label>
                        <input type="number" min={1} max={60} step={0.1} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 5)} className="prompter-settings-input prompter-settings-input-narrow" />
                        <p className="prompter-hint">Shown to students before recording (text prompt mode only).</p>
                      </div>
                    ) : promptMode === 'decks' ? (
                      <div className="prompter-settings-section">
                        <p className="prompter-hint">
                          <strong>Deck mode:</strong> students skip the long warm-up. After camera setup they see a short &quot;Get Ready!&quot; 3-2-1 countdown, then recording starts with the first prompt. Timing per card comes from each Sprout video.
                        </p>
                      </div>
                    ) : (
                      <div className="prompter-settings-section" aria-hidden />
                    )}
                    <div className="prompter-settings-section prompter-settings-assignment-block">
                      <label className="prompter-settings-label"><strong>Assignment Settings:</strong></label>
                      <div className="prompter-settings-field">
                        <label className="prompter-settings-label">Assignment Name: <span className="prompter-required">*</span></label>
                        <input type="text" value={assignmentName} onChange={(e) => setAssignmentName(e.target.value)} placeholder="e.g. ASL Warm-Up Submission" className="prompter-settings-input" required />
                      </div>
                      {assignmentGroupSelector}
                      <div className="prompter-settings-field">
                        <label className="prompter-settings-label">Points Possible:</label>
                        <input
                          type="number"
                          step={1}
                          min={0}
                          value={pointsPossible}
                          onChange={(e) => {
                            const raw = e.target.value.trim();
                            const n = Number(raw);
                            setPointsPossible(Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
                          }}
                          className="prompter-settings-input prompter-settings-input-narrow"
                        />
                      </div>
                      <div className="prompter-settings-field">
                        <label className="prompter-settings-label">Due Date (optional):</label>
                        <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className="prompter-settings-input" />
                      </div>
                      <div className="prompter-settings-field">
                        <label className="prompter-settings-label">Available From (optional):</label>
                        <input type="datetime-local" value={unlockAt} onChange={(e) => setUnlockAt(e.target.value)} className="prompter-settings-input" />
                      </div>
                      <div className="prompter-settings-field">
                        <label className="prompter-settings-label">Available Until (optional):</label>
                        <input type="datetime-local" value={lockAt} onChange={(e) => setLockAt(e.target.value)} className="prompter-settings-input" />
                      </div>
                      <div className="prompter-settings-field">
                        <label className="prompter-settings-label">Allowed Attempts:</label>
                        <input
                          type="number"
                          min={-1}
                          value={allowedAttempts}
                          onChange={(e) => {
                            const raw = e.target.value.trim();
                            if (raw === '') {
                              setAllowedAttempts(1);
                              return;
                            }
                            const n = Number(raw);
                            if (!Number.isFinite(n)) {
                              setAllowedAttempts(1);
                              return;
                            }
                            if (n === -1) setAllowedAttempts(-1);
                            else setAllowedAttempts(Math.max(1, Math.round(n)));
                          }}
                          className="prompter-settings-input prompter-settings-input-narrow"
                          title="Use -1 for unlimited attempts (Canvas)"
                        />
                        <span className="prompter-hint">(1 or more, or -1 for unlimited)</span>
                      </div>
                      <div className="prompter-settings-field">
                        <label className="prompter-settings-label">Instructions (optional):</label>
                        <p className="prompter-hint">
                          Rich text, stored as HTML. Displayed in the Canvas assignment description and on the first
                          screen students see.
                        </p>
                        <TeacherPromptRte
                          className="prompter-instructions-rte"
                          value={instructions}
                          onChange={setInstructions}
                          placeholder="Instructions for students…"
                          remountKey={`ins-${(assignmentId ?? 'n')}-${promptRteRemountKey}`}
                        />
                      </div>
                      {rubricSelector}
                    </div>
                    <div className="prompter-settings-section prompter-settings-access">
                      <label className="prompter-settings-label"><strong>Access Code:</strong> (Required for students to start)</label>
                      <input type="text" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="Enter or generate" className="prompter-settings-input prompter-access-code-input" required />
                      <button type="button" className="prompter-btn-generate" onClick={generateAccessCode}>Generate ASL Code</button>
                    </div>
                    {moduleSelector}
                  </div>
                  <div className="prompter-settings-resize-handle" title="Column divider" />
                  <div className="prompter-settings-col-prompts">
                    <div className="prompter-settings-header-row">
                      <label className="prompter-settings-label"><strong>Prompt Source</strong></label>
                    </div>
                    <div className="prompter-settings-section">
                      <label className="prompter-settings-label prompter-settings-label-block">
                        <input
                          type="radio"
                          name="promptMode"
                          value="text"
                          checked={promptMode === 'text'}
                          onChange={() => setPromptMode('text')}
                        />
                        {' '}Text Prompts (manual)
                      </label>
                      <label className="prompter-settings-label prompter-settings-label-block">
                        <input
                          type="radio"
                          name="promptMode"
                          value="decks"
                          checked={promptMode === 'decks'}
                          onChange={() => setPromptMode('decks')}
                        />
                        {' '}Deck Prompts (from flashcard decks)
                      </label>
                      <label className="prompter-settings-label prompter-settings-label-block">
                        <input
                          type="radio"
                          name="promptMode"
                          value="youtube"
                          checked={promptMode === 'youtube'}
                          onChange={() => setPromptMode('youtube')}
                        />
                        {' '}YouTube video prompt
                      </label>
                    </div>
                    
                    {promptMode === 'text' ? (
                      <>
                        <div className="prompter-settings-header-row">
                          <label className="prompter-settings-label"><strong>Text Prompts</strong></label>
                          <button type="button" onClick={addPrompt} className="prompter-btn-add-pool">
                            + Add to Pool
                          </button>
                        </div>
                        <p className="prompter-hint">
                          Each prompt is rich text (saved as HTML). Students see it formatted during warm-up and
                          recording.
                        </p>
                        {prompts.map((p, i) => (
                          <div key={`${(assignmentId ?? 'a')}-${i}-${promptRteRemountKey}`} className="prompter-prompt-item-row">
                            <TeacherPromptRte
                              value={p}
                              onChange={(html) => updatePrompt(i, html)}
                              placeholder="Prompt text…"
                              remountKey={`p-${(assignmentId ?? 'a')}-${i}-${promptRteRemountKey}`}
                            />
                            <button type="button" onClick={() => removePrompt(i)} className="prompter-btn-remove">
                              Remove
                            </button>
                          </div>
                        ))}
                      </>
                    ) : promptMode === 'decks' ? (
                      <div className="prompter-settings-section prompter-deck-config-section">
                        <label className="prompter-settings-label"><strong>Deck Configuration</strong></label>
                        <p className="prompter-hint">
                          Filter by curriculum, unit, and section (same as the flashcard deck browser), then add decks below.
                          Prompts use round-robin across all selected decks.
                        </p>

                        <div className="prompter-settings-field">
                          <label className="prompter-settings-label">Total Cards:</label>
                          <input
                            type="number"
                            min={1}
                            max={100}
                            value={totalCards}
                            onChange={(e) => setTotalCards(Number(e.target.value) || 10)}
                            className="prompter-settings-input prompter-settings-input-narrow"
                          />
                        </div>

                        {deckPickerLoading && (
                          <p className="prompter-hint">Loading deck catalog…</p>
                        )}
                        {deckPickerError && !deckPickerLoading && (
                          <p className="prompter-error-message">{deckPickerError}</p>
                        )}

                        <div className="prompter-deck-picker-filters teacher-settings-multiselect-row">
                          <div className="teacher-settings-checkbox-group prompter-deck-picker-filter-col">
                            <span className="teacher-settings-label">Curriculum</span>
                            <div className="teacher-settings-checkbox-list prompter-deck-picker-scroll">
                              {deckPickerCurricula.length === 0 && !deckPickerLoading ? (
                                <span className="prompter-hint">No curricula loaded.</span>
                              ) : (
                                deckPickerCurricula.map((c) => (
                                  <label key={c} className="teacher-settings-checkbox-label">
                                    <input
                                      type="checkbox"
                                      checked={deckFilterCurricula.includes(c)}
                                      onChange={() => toggleDeckFilterCurriculum(c)}
                                    />
                                    {c}
                                  </label>
                                ))
                              )}
                            </div>
                          </div>
                          <div className="teacher-settings-checkbox-group prompter-deck-picker-filter-col">
                            <span className="teacher-settings-label">Units</span>
                            <div className="teacher-settings-checkbox-list prompter-deck-picker-scroll">
                              {deckPickerUnits.length === 0 && !deckPickerLoading ? (
                                <span className="prompter-hint">No units yet (narrow by curriculum or wait for load).</span>
                              ) : (
                                deckPickerUnits.map((u) => (
                                  <label key={u} className="teacher-settings-checkbox-label">
                                    <input
                                      type="checkbox"
                                      checked={deckFilterUnits.includes(u)}
                                      onChange={() => toggleDeckFilterUnit(u)}
                                    />
                                    {u}
                                  </label>
                                ))
                              )}
                            </div>
                          </div>
                          <div className="teacher-settings-checkbox-group prompter-deck-picker-filter-col">
                            <span className="teacher-settings-label">Sections</span>
                            <div className="teacher-settings-checkbox-list prompter-deck-picker-scroll">
                              {deckPickerSections.length === 0 && !deckPickerLoading ? (
                                <span className="prompter-hint">No sections (optional — narrow by unit first).</span>
                              ) : (
                                deckPickerSections.map((s) => (
                                  <label key={s} className="teacher-settings-checkbox-label">
                                    <input
                                      type="checkbox"
                                      checked={deckFilterSections.includes(s)}
                                      onChange={() => toggleDeckFilterSection(s)}
                                    />
                                    {s}
                                  </label>
                                ))
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="prompter-settings-field">
                          <label className="prompter-settings-label">Available decks ({deckPickerPlaylists.length})</label>
                          <div className="prompter-deck-picker-available prompter-deck-picker-scroll">
                            {deckPickerPlaylists.length === 0 && !deckPickerLoading ? (
                              <p className="prompter-hint">No decks match the current filters.</p>
                            ) : (
                              deckPickerPlaylists.map((deck) => {
                                const already = selectedDecks.some((d) => d.id === deck.id);
                                return (
                                  <div key={deck.id} className="prompter-deck-picker-row">
                                    <span className="prompter-deck-picker-title">{deck.title}</span>
                                    <button
                                      type="button"
                                      className="prompter-btn-add-pool"
                                      disabled={already || !deck.id}
                                      onClick={() => addDeckToSelection(deck)}
                                    >
                                      {already ? 'Added' : 'Add'}
                                    </button>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>

                        <div className="prompter-settings-field">
                          <label className="prompter-settings-label">Selected decks ({selectedDecks.length})</label>
                          <div className="prompter-deck-list">
                            {selectedDecks.length === 0 ? (
                              <p className="prompter-hint">No decks selected yet — add from the list above.</p>
                            ) : (
                              selectedDecks.map((deck) => (
                                <div key={deck.id} className="prompter-deck-item">
                                  <span>{deck.title}</span>
                                  <button
                                    type="button"
                                    onClick={() => setSelectedDecks((d) => d.filter((x) => x.id !== deck.id))}
                                    className="prompter-btn-remove-sm"
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))
                            )}
                          </div>
                        </div>

                        {deckPromptWarning && (
                          <p className="prompter-error-message">{deckPromptWarning}</p>
                        )}

                        {estimatedSessionLength && (
                          <p className="prompter-hint">Estimated session length: {estimatedSessionLength}</p>
                        )}
                      </div>
                    ) : (
                      <div className="prompter-settings-section prompter-youtube-config-section">
                        <aside className="prompter-youtube-length-callout" role="note">
                          <strong>Maximum video length: 35 minutes.</strong> Shorter, quick targeted assessments are
                          highly recommended. 2 to 3 minutes or even shorter can provide an excellent measure without
                          overwhelming the teacher.
                        </aside>
                        <label className="prompter-settings-label" htmlFor="youtube-url-or-id">
                          YouTube URL or Video ID
                        </label>
                        <input
                          id="youtube-url-or-id"
                          type="text"
                          className="prompter-settings-input"
                          value={youtubeUrlOrId}
                          onChange={(e) => setYoutubeUrlOrId(e.target.value)}
                          onBlur={handleYoutubeUrlBlur}
                          placeholder="https://www.youtube.com/watch?v=… or paste embed code"
                        />
                        {youtubeFieldError && <p className="prompter-error-message">{youtubeFieldError}</p>}
                        <div className="prompter-settings-field">
                          <label className="prompter-settings-label" htmlFor="youtube-label">
                            Label (optional)
                          </label>
                          <input
                            id="youtube-label"
                            type="text"
                            className="prompter-settings-input"
                            value={youtubeLabel}
                            onChange={(e) => setYoutubeLabel(e.target.value)}
                            placeholder="e.g. Warm-up dialogue"
                          />
                        </div>
                        {youtubePreviewVideoId && (
                          <div className="prompter-youtube-preview-wrap">
                            <p className="prompter-hint">Preview (YouTube IFrame API, nocookie host — use controls to scrub)</p>
                            {youtubeApiFailed ? (
                              <div className="prompter-youtube-preview-fallback">
                                <p className="prompter-youtube-clip-range-warning" role="status">
                                  YouTube preview did not load. Use the clip start/end fields below to configure the
                                  assignment — saving still works.
                                </p>
                                <button
                                  type="button"
                                  className="prompter-btn-secondary"
                                  onClick={() => {
                                    setYoutubeApiFailed(false);
                                    setYoutubePreviewRetryNonce((n) => n + 1);
                                  }}
                                >
                                  Retry preview
                                </button>
                              </div>
                            ) : (
                              <div className="prompter-youtube-preview-frame">
                                <YoutubeStimulusShell
                                  subtitleMask={{
                                    enabled: youtubeSubtitleMaskEnabled,
                                    heightPercent: youtubeSubtitleMaskHeight,
                                  }}
                                >
                                  <YoutubeIframePlayer
                                    ref={youtubePreviewPlayerRef}
                                    key={youtubePreviewPlayerKey}
                                    videoId={youtubePreviewVideoId}
                                    clipStartSec={youtubeClipStartSec}
                                    clipEndSec={youtubeClipEndSec}
                                    isStudent={false}
                                    teacherCaptionsEnabled={false}
                                    showControls
                                    fullTimelinePreview
                                    onReady={({ duration }) => {
                                      const d =
                                        Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : 0;
                                      setYoutubePreviewDuration(d);
                                      setYoutubeApiFailed(false);
                                      queueMicrotask(() => {
                                        const p = youtubePreviewPlayerRef.current;
                                        if (!p || !d) return;
                                        const s = Math.max(0, Math.floor(Number(youtubeClipStartSec)));
                                        try {
                                          p.seekToSeconds(Math.min(s, d));
                                        } catch {
                                          /* ignore */
                                        }
                                      });
                                    }}
                                    onApiError={(msg) => {
                                      setYoutubeApiFailed(true);
                                      setYoutubePreviewDuration(0);
                                      console.warn('[TeacherConfig] YouTube preview:', msg);
                                    }}
                                  />
                                </YoutubeStimulusShell>
                              </div>
                            )}
                          </div>
                        )}
                        <div className="prompter-youtube-config-range-wrap">
                          <YoutubeClipRangeEditor
                            durationSec={youtubePreviewDuration}
                            startSec={youtubeClipStartSec}
                            endSec={youtubeClipEndSec}
                            onStartSecChange={setYoutubeClipStartSec}
                            onEndSecChange={setYoutubeClipEndSec}
                            apiFailed={youtubeApiFailed}
                            onPreviewSeek={seekYoutubePreview}
                          />
                        </div>
                        <div className="prompter-settings-field prompter-youtube-clip-fields">
                          <label className="prompter-settings-label" htmlFor="youtube-clip-start">
                            Clip start (seconds from video start)
                          </label>
                          <input
                            id="youtube-clip-start"
                            type="number"
                            min={0}
                            max={86400}
                            step={1}
                            value={youtubeClipStartSec}
                            onChange={(e) => {
                              const raw = Math.floor(Number(e.target.value) || 0);
                              const d = youtubePreviewDuration;
                              let v = Math.max(0, raw);
                              if (d > 0) v = Math.min(v, d);
                              setYoutubeClipStartSec(v);
                              let endVal = youtubeClipEndSec;
                              if (v >= endVal) {
                                endVal = Math.min(d > 0 ? d : v + 86400, v + 1);
                                setYoutubeClipEndSec(endVal);
                              }
                              seekYoutubePreview(v);
                            }}
                            className="prompter-settings-input prompter-settings-input-narrow"
                          />
                          <label className="prompter-settings-label prompter-settings-label-mt" htmlFor="youtube-clip-end">
                            Clip end (seconds; must be greater than start)
                          </label>
                          <input
                            id="youtube-clip-end"
                            type="number"
                            min={1}
                            max={86400}
                            step={1}
                            value={youtubeClipEndSec}
                            onChange={(e) => {
                              const raw = Math.floor(Number(e.target.value) || 1);
                              const d = youtubePreviewDuration;
                              let v = Math.max(youtubeClipStartSec + 1, raw);
                              if (d > 0) v = Math.min(v, d);
                              setYoutubeClipEndSec(v);
                              seekYoutubePreview(v);
                            }}
                            className="prompter-settings-input prompter-settings-input-narrow"
                          />
                          <p className="prompter-hint">
                            Only this segment plays for students. Move the handles or type times to preview that moment in the
                            video above. Values clamp to the video length once the preview loads.
                          </p>
                        </div>
                        <div className="prompter-settings-field">
                          <label className="prompter-settings-label" htmlFor="youtube-allow-student-cc">
                            <input
                              id="youtube-allow-student-cc"
                              type="checkbox"
                              checked={youtubeAllowStudentCaptions}
                              onChange={(e) => setYoutubeAllowStudentCaptions(e.target.checked)}
                            />{' '}
                            Allow students to turn captions on (single in-app control; off by default)
                          </label>
                        </div>
                        <div className="prompter-settings-field">
                          <label className="prompter-settings-label" htmlFor="youtube-mask-enable">
                            <input
                              id="youtube-mask-enable"
                              type="checkbox"
                              checked={youtubeSubtitleMaskEnabled}
                              onChange={(e) => setYoutubeSubtitleMaskEnabled(e.target.checked)}
                            />{' '}
                            Cover bottom of stimulus with an opaque bar (hide burned-in subtitles)
                          </label>
                          <label className="prompter-settings-label prompter-settings-label-mt" htmlFor="youtube-mask-height">
                            Bar height (% of player height, 5–30)
                          </label>
                          <input
                            id="youtube-mask-height"
                            type="number"
                            min={5}
                            max={30}
                            step={1}
                            value={youtubeSubtitleMaskHeight}
                            onChange={(e) =>
                              setYoutubeSubtitleMaskHeight(
                                Math.min(30, Math.max(5, Math.round(Number(e.target.value) || 15))),
                              )
                            }
                            className="prompter-settings-input prompter-settings-input-narrow"
                            disabled={!youtubeSubtitleMaskEnabled}
                          />
                        </div>
                        <div className="prompter-settings-field prompter-settings-field-mt-sm">
                          <p className="prompter-settings-label">
                            <strong>Student recording (WebM)</strong>
                          </p>
                          <label className="prompter-settings-label prompter-settings-label-block" htmlFor="youtube-sign-to-voice">
                            <input
                              id="youtube-sign-to-voice"
                              type="checkbox"
                              checked={signToVoiceRequired}
                              onChange={(e) => setSignToVoiceRequired(e.target.checked)}
                            />{' '}
                            Sign-to-voice: transcribe student camera audio (Deepgram), mux captions into the submission, for
                            grading CC
                          </label>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="prompter-settings-save-row prompter-settings-actions-row">
                  <button type="button" onClick={handleSave} disabled={saving} className="prompter-btn-ready">
                    {saving ? <><span className="prompter-inline-spinner" /> Saving...</> : 'Save'}
                  </button>
                  <button type="button" onClick={handleReset} disabled={saving} className="prompter-btn-secondary">
                    {resetting ? <><span className="prompter-inline-spinner" /> Resetting...</> : 'Reset'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {importModalOpen && (
        <div className="prompter-modal-overlay" onClick={closeImportModal}>
          <div className="prompter-modal prompter-modal-wide" onClick={(e) => e.stopPropagation()}>
            <h3 className="prompter-settings-card-title" style={{ marginTop: 0 }}>
              Import Prompt Manager settings
            </h3>
            <p className="prompter-hint">
              For assignments whose titles match TRUE+WAY naming patterns, merge default Prompt Manager fields from the template.
            </p>
            <div className="prompter-settings-actions-row prompter-settings-actions-row-mb-sm">
              <button
                type="button"
                className="prompter-btn-secondary"
                disabled={importBusy || importModalBusy}
                onClick={() => void handleApplyTrueWay()}
              >
                {importBusy ? '…' : 'Apply TRUE+WAY title templates'}
              </button>
            </div>
            {trueWayApplyMessage && (
              <p className="prompter-hint" style={{ marginTop: 8 }} role="status" aria-live="polite">
                {trueWayApplyMessage}
              </p>
            )}
            <hr style={{ border: 'none', borderTop: '1px solid rgba(0, 0, 0, 0.12)', margin: '1rem 0' }} />
            <p className="prompter-hint">
              Copy settings from another assignment in this course: choose a <strong>source assignment</strong> and{' '}
              <strong>module</strong>, then <strong>Import selected source assignment</strong>.
            </p>
            {importModalBusy && (
              <p className="prompter-hint" role="status" aria-live="polite">
                <span className="prompter-inline-spinner" />
                {' Import in progress…'}
              </p>
            )}
            <label className="prompter-settings-label">Source assignment</label>
            <select
              className="prompter-settings-input"
              value={importSourceAssignmentId}
              onChange={(e) => void handleImportSourceAssignmentChange(e)}
              disabled={importModalBusy || !(importCanvasBrief?.allAssignments.length ?? 0)}
            >
              <option value="">
                {importCanvasBrief?.allAssignments.length
                  ? '— Select source assignment —'
                  : '— No assignments found in this course —'}
              </option>
              {(importCanvasBrief?.allAssignments ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <label className="prompter-settings-label">Module (required)</label>
            <select
              className="prompter-settings-input"
              value={importModuleId}
              onChange={(e) => setImportModuleId(e.target.value)}
              disabled={importModalBusy}
            >
              <option value="">— Select module —</option>
              {modules.map((m) => (
                <option key={m.id} value={String(m.id)}>
                  {m.name}
                </option>
              ))}
            </select>
            {!modules.length && (
              <p className="prompter-hint">Loading modules…</p>
            )}
            <label className="prompter-settings-label">Prompt type</label>
            <p className="prompter-hint" style={{ marginTop: 4 }}>
              Auto reads the source assignment’s hidden config (when present) and infers mode; pick a type only if you need to override.
            </p>
            <select
              className="prompter-settings-input"
              value={importPromptModeChoice}
              onChange={(e) =>
                setImportPromptModeChoice(e.target.value as 'auto' | 'text' | 'decks' | 'youtube')
              }
              disabled={importModalBusy}
            >
              <option value="auto">Auto (recommended)</option>
              <option value="text">Text prompts</option>
              <option value="decks">Deck prompts</option>
              <option value="youtube">YouTube stimulus</option>
            </select>
            <div className="prompter-settings-actions-row">
              <button
                type="button"
                className="prompter-btn-ready"
                disabled={importModalBusy || !importSourceAssignmentId.trim() || !importModuleId.trim()}
                onClick={() => void handleImportModalSingleMerge()}
              >
                {importModalBusy ? (
                  <>
                    <span className="prompter-inline-spinner" />
                    Importing assignment…
                  </>
                ) : (
                  'Import selected source assignment'
                )}
              </button>
            </div>
            {importModalMessage && (
              <pre
                className="prompter-settings-label"
                style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 8, maxHeight: 220, overflow: 'auto' }}
              >
                {importModalMessage}
              </pre>
            )}
            <div className="prompter-modal-actions" style={{ marginTop: 12 }}>
              <button type="button" className="prompter-btn-secondary" onClick={closeImportModal} disabled={importModalBusy}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {gradeConfirmModal && (
        <div className="prompter-modal-overlay" onClick={cancelGradeOpen}>
          <div className="prompter-modal" onClick={(e) => e.stopPropagation()}>
            <p>Opening <strong>{gradeConfirmModal.name}</strong> for Grading</p>
            <div className="prompter-modal-actions">
              <button type="button" onClick={confirmGradeOpen} className="prompter-btn-ready">OK</button>
              <button type="button" onClick={cancelGradeOpen} className="prompter-btn-secondary">Cancel</button>
            </div>
          </div>
        </div>
      )}
      {showManualTokenModal && (
        <ManualTokenModal
          message="LTI 1.1 does not support OAuth. Enter your Canvas API token to configure assignments."
          variant="prompter"
          onSuccess={() => {
            setShowManualTokenModal(false);
            setDeckPickerRefreshKey((k) => k + 1);
            void loadAssignments();
            void loadModules();
            void loadAssignmentGroups();
            void loadRubrics();
            if (assignmentId) void load(assignmentId);
          }}
          onDismiss={() => setShowManualTokenModal(false)}
        />
      )}
    </div>
    </>
  );
}
