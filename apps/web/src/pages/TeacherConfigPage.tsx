import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { resolveLtiContextValue } from '../utils/lti-context';
import * as promptApi from '../api/prompt.api';
import * as flashcardTeacherApi from '../api/flashcard-teacher.api';
import type { PlaylistHierarchyRow } from '../api/flashcard-teacher.api';
import { ManualTokenModal } from '../components/ManualTokenModal';
import { computeDeckHubFilters } from '../utils/deckHierarchyFilters';
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
  const assignmentId = createMode ? null : (ctxAssignmentId || assignmentIdFromUrl.trim()) || null;

  const [config, setConfig] = useState<promptApi.PromptConfig | null>(null);
  const [configuredAssignments, setConfiguredAssignments] = useState<promptApi.ConfiguredAssignment[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(false);
  const [, setGradeDropdownValue] = useState('');
  const [assignmentActionMode, setAssignmentActionMode] = useState<'edit' | 'grade' | 'create'>(
    createMode || !assignmentId ? 'create' : 'edit'
  );
  const [configAssignValue, setConfigAssignValue] = useState('');
  const [creatingAssignment, setCreatingAssignment] = useState(false);
  const [deletingAssignment, setDeletingAssignment] = useState(false);
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
  const [showSettings, setShowSettings] = useState(true);
  const [showManualTokenModal, setShowManualTokenModal] = useState(false);
  
  // Deck mode state
  const [promptMode, setPromptMode] = useState<'text' | 'decks'>('text');
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

  const teacher = context && isTeacher(context.roles);
  const hasLti = context?.courseId && context.userId !== 'standalone';
  const needsAssignmentSelector = hasLti && !ctxAssignmentId;

  const loadAssignments = useCallback(async () => {
    if (!teacher || !hasLti) {
      console.log('[TeacherConfig] loadAssignments SKIPPED', { teacher: !!teacher, hasLti: !!hasLti, courseId: context?.courseId, userId: context?.userId });
      return;
    }
    console.log('[TeacherConfig] loadAssignments CALLING /api/prompt/configured-assignments');
    setLoadingAssignments(true);
    try {
      setLastFunction('GET /api/prompt/configured-assignments');
      const list = await promptApi.getConfiguredAssignments();
      setLastApiResult('GET /api/prompt/configured-assignments', 200, true);
      console.log('[TeacherConfig] getConfiguredAssignments response:', list);
      setConfiguredAssignments(list ?? []);
    } catch (e) {
      if (e instanceof promptApi.NeedsManualTokenError) setShowManualTokenModal(true);
      setConfiguredAssignments([]);
    } finally {
      setLoadingAssignments(false);
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
      setConfig(data ?? null);
      if (data) {
        setMinutes(data.minutes ?? 5);
        setPrompts(Array.isArray(data.prompts) ? data.prompts : []);
        setAccessCode(data.accessCode ?? '');
        setModuleId(data.moduleId ?? '');
        setAssignmentGroupId(data.assignmentGroupId ?? '');
        setRubricId(data.rubricId ?? '');
        setAssignmentName(data.assignmentName ?? '');
        setPointsPossible(Math.max(0, Math.round(Number(data.pointsPossible ?? 10) || 10)));
        setDueAt(data.dueAt ?? '');
        setUnlockAt(data.unlockAt ?? '');
        setLockAt(data.lockAt ?? '');
        setAllowedAttempts(Math.max(1, Number(data.allowedAttempts ?? 1) || 1));
        setInstructions(data.instructions ?? '');
        setPromptMode(data.promptMode ?? 'text');
        if (data.videoPromptConfig) {
          const loadedDecks = data.videoPromptConfig.selectedDecks ?? [];
          setSelectedDecks(loadedDecks);
          setTotalCards(data.videoPromptConfig.totalCards ?? 10);
          const deckIds = loadedDecks.map((d) => d.id).filter(Boolean);
          setPendingDeckFilterSeedIds(deckIds.length ? deckIds : null);
        } else {
          setSelectedDecks([]);
          setTotalCards(10);
          setDeckFilterCurricula([]);
          setDeckFilterUnits([]);
          setDeckFilterSections([]);
          setPendingDeckFilterSeedIds(null);
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
        setDeckFilterCurricula([]);
        setDeckFilterUnits([]);
        setDeckFilterSections([]);
        setPendingDeckFilterSeedIds(null);
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
    if (teacher && hasLti) loadAssignments();
  }, [teacher, hasLti, loadAssignments]);

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
      loadModules();
      loadAssignmentGroups();
      loadRubrics();
      if (assignmentId) load();
      else setLoading(false);
    } else {
      setLoading(false);
    }
  }, [teacher, hasLti, assignmentId, load, loadModules, loadAssignmentGroups, loadRubrics]);

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

  const handleSave = async () => {
    if (!teacher || !hasLti) return;
    if (promptMode === 'decks' && selectedDecks.length === 0) {
      setError('Select at least one flashcard deck when using Deck Prompts.');
      return;
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
          moduleId: moduleId || undefined,
          assignmentGroupId: assignmentGroupId || undefined,
          newGroupName: assignmentGroupId === '__new__' ? createGroupName.trim() || undefined : undefined,
          rubricId: rubricId || undefined,
          pointsPossible,
          instructions: instructions.trim() || undefined,
          dueAt: dueAt.trim() || undefined,
          unlockAt: unlockAt.trim() || undefined,
          lockAt: lockAt.trim() || undefined,
          allowedAttempts,
          promptMode,
          videoPromptConfig: promptMode === 'decks' ? { selectedDecks, totalCards } : undefined,
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
    setPromptMode('text');
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
    const name = createAssignName.trim() || 'ASL Express Assignment';
    setCreatingAssignment(true);
    setError(null);
    try {
      setLastFunction('POST /api/prompt/create-assignment');
      const { assignmentId: newId } = await promptApi.createAssignment(name, {
        assignmentGroupId: assignmentGroupId || undefined,
        newGroupName: assignmentGroupId === '__new__' ? createGroupName.trim() || undefined : undefined,
      });
      setLastApiResult('POST /api/prompt/create-assignment', 200, true);
      setCreateAssignName('');
      await loadAssignments();
      setSearchParams({ assignmentId: newId });
      setAssignmentActionMode('edit');
      setShowSettings(true);
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

  const handleDeleteConfiguredAssignment = async () => {
    if (!teacher || !hasLti || deletingAssignment || !configAssignValue || configAssignValue === '__new__') return;
    const target = configuredAssignments.find((a) => a.id === configAssignValue);
    const label = target?.name ?? `Assignment ${configAssignValue}`;
    const ok = window.confirm(
      `Delete "${label}" from Canvas?\n\nThis also removes its Prompt Manager settings entry. This cannot be undone.`
    );
    if (!ok) return;
    setDeletingAssignment(true);
    setError(null);
    try {
      setLastFunction('DELETE /api/prompt/configured-assignments/:assignmentId');
      await promptApi.deleteConfiguredAssignment(configAssignValue);
      setLastApiResult('DELETE /api/prompt/configured-assignments/:assignmentId', 204, true);
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
    } catch (e: unknown) {
      if (e instanceof promptApi.NeedsManualTokenError) {
        setShowManualTokenModal(true);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setLastApiError('DELETE /api/prompt/configured-assignments/:assignmentId', 0, msg);
      }
    } finally {
      setDeletingAssignment(false);
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
        { minutes: 5, prompts: [], accessCode: '', assignmentName: '', moduleId: '', pointsPossible: 10, instructions: '', dueAt: '', unlockAt: '', lockAt: '', allowedAttempts: 1, promptMode: 'text' },
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

  if (!teacher || !context) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Teacher access required.</p>
        </div>
      </div>
    );
  }

  const showForm = hasLti;
  const effectiveAssignmentId = assignmentId;
  const canEditAssignmentSettings = assignmentActionMode === 'edit' && !!assignmentId;

  if (assignmentId && loading) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Loading configuration...</p>
        </div>
      </div>
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

  const rubricSelector = (
    <div className="prompter-settings-section">
      <label className="prompter-settings-label"><strong>Rubric (optional):</strong></label>
      <select
        className="prompter-settings-input"
        value={rubricId}
        onChange={(e) => setRubricId(e.target.value)}
      >
        <option value="">— No Rubric —</option>
        {rubrics.map((r) => (
          <option key={r.id} value={String(r.id)}>
            {r.title} ({r.pointsPossible} pts)
          </option>
        ))}
      </select>
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
        <option value="">— None —</option>
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
    <div className="prompter-page">
      <div className="prompter-page-inner">
        <h1 className="prompter-settings-page-title">Prompt Manager Settings</h1>
        {error && <div className="prompter-alert-error">{error}</div>}
        {saved && <div className="prompter-alert-success">Saved.</div>}

        {showForm && (
          <>
            <div className="prompter-settings-actions-row prompter-settings-top-actions">
              <button type="button" className="prompter-btn-toggle-settings" onClick={() => setShowSettings((s) => !s)}>
                {showSettings ? 'Hide Settings' : 'Show Settings'}
              </button>
              {effectiveAssignmentId && (
                <Link
                  to={`/viewer?assignmentId=${encodeURIComponent(effectiveAssignmentId)}&grading=1`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="prompter-btn-start prompter-btn-grading"
                >
                  Open for Grading
                </Link>
              )}
            </div>
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
                        Create
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
                      <div className="prompter-settings-actions-row prompter-settings-actions-row-mt-sm">
                        <button
                          type="button"
                          onClick={handleDeleteConfiguredAssignment}
                          disabled={deletingAssignment}
                          className="prompter-btn-secondary"
                        >
                          {deletingAssignment ? <><span className="prompter-inline-spinner" /> Deleting...</> : 'Delete Assignment'}
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
            ) : showSettings && (
              <div className="prompter-settings-config-form">
                <div className="prompter-settings-two-col">
                  <div className="prompter-settings-col-assignment">
                    <div className="prompter-settings-section">
                      <label className="prompter-settings-label"><strong>Warm Up Minutes:</strong></label>
                      <input type="number" min={1} max={60} step={0.1} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 5)} className="prompter-settings-input prompter-settings-input-narrow" />
                    </div>
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
                          min={1}
                          value={allowedAttempts}
                          onChange={(e) => {
                            const raw = e.target.value.trim();
                            if (raw === '') {
                              setAllowedAttempts(1);
                              return;
                            }
                            const n = Number(raw);
                            setAllowedAttempts(Number.isFinite(n) ? Math.max(1, Math.round(n)) : 1);
                          }}
                          className="prompter-settings-input prompter-settings-input-narrow"
                          title="Minimum 1 attempt"
                        />
                        <span className="prompter-hint">(Minimum 1)</span>
                      </div>
                      <div className="prompter-settings-field">
                        <label className="prompter-settings-label">Instructions (optional):</label>
                        <p className="prompter-hint">Displayed in the assignment description and on the first screen students see.</p>
                        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4} placeholder="Instructions for students..." className="prompter-settings-input" />
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
                    </div>
                    
                    {promptMode === 'text' ? (
                      <>
                        <div className="prompter-settings-header-row">
                          <label className="prompter-settings-label"><strong>Text Prompts</strong></label>
                          <button type="button" onClick={addPrompt} className="prompter-btn-add-pool">
                            + Add to Pool
                          </button>
                        </div>
                        {prompts.map((p, i) => (
                          <div key={i} className="prompter-prompt-item-row">
                            <textarea
                              value={p}
                              onChange={(e) => updatePrompt(i, e.target.value)}
                              rows={2}
                              className="prompter-settings-input"
                              placeholder="Prompt text..."
                            />
                            <button type="button" onClick={() => removePrompt(i)} className="prompter-btn-remove">
                              Remove
                            </button>
                          </div>
                        ))}
                      </>
                    ) : (
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
            loadAssignments();
            loadModules();
            loadAssignmentGroups();
            loadRubrics();
            if (assignmentId) load(assignmentId);
          }}
          onDismiss={() => setShowManualTokenModal(false)}
        />
      )}
    </div>
  );
}
