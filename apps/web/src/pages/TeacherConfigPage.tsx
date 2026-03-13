import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { resolveLtiContextValue } from '../utils/lti-context';
import * as promptApi from '../api/prompt.api';
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
  const assignmentId = (ctxAssignmentId || assignmentIdFromUrl.trim()) || null;

  const [config, setConfig] = useState<promptApi.PromptConfig | null>(null);
  const [configuredAssignments, setConfiguredAssignments] = useState<promptApi.ConfiguredAssignment[]>([]);
  const [modules, setModules] = useState<promptApi.CanvasModule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingAssignments, setLoadingAssignments] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);
  const [minutes, setMinutes] = useState(5);
  const [prompts, setPrompts] = useState<string[]>([]);
  const [accessCode, setAccessCode] = useState('');
  const [moduleId, setModuleId] = useState<string>('');
  const [gradeDropdownValue, setGradeDropdownValue] = useState('');
  const [gradeConfirmModal, setGradeConfirmModal] = useState<{ name: string; id: string } | null>(null);
  const [createModuleName, setCreateModuleName] = useState('');
  const [createModulePosition, setCreateModulePosition] = useState<number | ''>('');
  const [creatingModule, setCreatingModule] = useState(false);
  const [showCreateModule, setShowCreateModule] = useState(false);

  const teacher = context && isTeacher(context.roles);
  const hasLti = context?.courseId && context.userId !== 'standalone';
  const needsAssignmentSelector = hasLti && !ctxAssignmentId;

  const loadAssignments = useCallback(async () => {
    if (!teacher || !hasLti) return;
    setLoadingAssignments(true);
    try {
      setLastFunction('GET /api/prompt/configured-assignments');
      const list = await promptApi.getConfiguredAssignments();
      setLastApiResult('GET /api/prompt/configured-assignments', 200, true);
      setConfiguredAssignments(list ?? []);
    } catch {
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
    } catch {
      setModules([]);
    }
  }, [teacher, hasLti, setLastFunction, setLastApiResult]);

  const load = useCallback(async () => {
    if (!hasLti || !assignmentId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setLastFunction('GET /api/prompt/config');
      const data = await promptApi.getPromptConfig(assignmentId);
      setLastApiResult('GET /api/prompt/config', 200, true);
      setConfig(data ?? null);
      if (data) {
        setMinutes(data.minutes ?? 5);
        setPrompts(Array.isArray(data.prompts) ? data.prompts : []);
        setAccessCode(data.accessCode ?? '');
        setModuleId(data.moduleId ?? '');
      } else {
        setMinutes(5);
        setPrompts([]);
        setAccessCode('');
        setModuleId('');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setLastApiError('GET /api/prompt/config', 0, msg);
    } finally {
      setLoading(false);
    }
  }, [hasLti, assignmentId, setLastFunction, setLastApiResult, setLastApiError]);

  useEffect(() => {
    if (teacher && hasLti && needsAssignmentSelector) loadAssignments();
  }, [teacher, hasLti, needsAssignmentSelector, loadAssignments]);

  useEffect(() => {
    if (teacher && hasLti && assignmentId) {
      load();
      loadModules();
    } else {
      setLoading(false);
    }
  }, [teacher, hasLti, assignmentId, load, loadModules]);

  const handleSave = async () => {
    if (!teacher || !hasLti || !assignmentId) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      setLastFunction('PUT /api/prompt/config');
      await promptApi.putPromptConfig(
        { minutes, prompts, accessCode, moduleId: moduleId || undefined },
        assignmentId
      );
      setLastApiResult('PUT /api/prompt/config', 200, true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setLastApiError('PUT /api/prompt/config', 0, msg);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateAssignment = async () => {
    if (!teacher || !hasLti || creating) return;
    setCreating(true);
    setError(null);
    try {
      setLastFunction('POST /api/prompt/create-assignment');
      const { assignmentId: newId } = await promptApi.createAssignment(createName.trim() || 'ASL Express Assignment');
      setLastApiResult('POST /api/prompt/create-assignment', 200, true);
      setCreateName('');
      await loadAssignments();
      setSearchParams({ assignmentId: newId });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setLastApiError('POST /api/prompt/create-assignment', 0, msg);
    } finally {
      setCreating(false);
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
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setLastApiError('POST /api/prompt/modules', 0, msg);
    } finally {
      setCreatingModule(false);
    }
  };

  const addPrompt = () => setPrompts((p) => [...p, '']);
  const updatePrompt = (i: number, v: string) =>
    setPrompts((p) => {
      const next = [...p];
      next[i] = v;
      return next;
    });
  const removePrompt = (i: number) => setPrompts((p) => p.filter((_, j) => j !== i));

  const handleReset = async () => {
    if (!teacher || !hasLti || !assignmentId) return;
    setMinutes(5);
    setPrompts([]);
    setAccessCode('');
    setModuleId('');
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      setLastFunction('PUT /api/prompt/config');
      await promptApi.putPromptConfig(
        { minutes: 5, prompts: [], accessCode: '', assignmentName: '', moduleId: '' },
        assignmentId
      );
      setLastApiResult('PUT /api/prompt/config', 200, true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setLastApiError('PUT /api/prompt/config', 0, msg);
    } finally {
      setSaving(false);
    }
  };

  const handleGradeSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (!v) {
      setGradeDropdownValue('');
      return;
    }
    const a = configuredAssignments.find((x) => x.id === v);
    if (a) {
      setGradeDropdownValue(v);
      setGradeConfirmModal({ name: a.name, id: a.id });
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

  if (!teacher || !context) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Teacher access required.</p>
        </div>
      </div>
    );
  }

  // Assignment dropdown select (shared between both cards) - ALWAYS render when hasLti
  const assignmentSelectOptions = (
    <select
      className="prompter-settings-input"
      value={gradeDropdownValue}
      onChange={handleGradeSelect}
      disabled={loadingAssignments}
    >
      <option value="">
        {loadingAssignments ? 'Loading assignments...' : '— Select Assignment to Grade —'}
      </option>
      {configuredAssignments.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} ({a.submissionCount} submissions, {a.ungradedCount} ungraded)
        </option>
      ))}
    </select>
  );

  const configAssignSelectOptions = (
    <select
      className="prompter-settings-input"
      value={assignmentId ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        if (v) setSearchParams({ assignmentId: v });
        else setSearchParams({});
      }}
      disabled={loadingAssignments}
    >
      <option value="">
        {loadingAssignments ? 'Loading...' : '— Select to configure —'}
      </option>
      {configuredAssignments.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );

  if (hasLti && needsAssignmentSelector && !assignmentId) {
    return (
      <div className="prompter-page">
        <div className="prompter-page-inner">
          <h1 className="prompter-settings-page-title">Prompt Manager Settings</h1>
          {error && <div className="prompter-alert-error">{error}</div>}

          <div className="prompter-settings-card">
            <h2 className="prompter-settings-card-title">Grade Submissions</h2>
            <div className="prompter-settings-section">
              <label className="prompter-settings-label">Assignment</label>
              {assignmentSelectOptions}
            </div>
          </div>

          <div className="prompter-settings-card">
            <h2 className="prompter-settings-card-title">Configure Assignment</h2>
            <div className="prompter-settings-section">
              <label className="prompter-settings-label">Select existing assignment</label>
              {configAssignSelectOptions}
            </div>
            <div className="prompter-settings-section" style={{ marginTop: 16 }}>
              <label className="prompter-settings-label">Create new assignment</label>
              <div className="prompter-settings-create-row">
                <input
                  type="text"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="Assignment name"
                  className="prompter-settings-input"
                />
                <button
                  type="button"
                  onClick={handleCreateAssignment}
                  disabled={creating}
                  className="prompter-btn-ready"
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </div>
          </div>
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
      </div>
    );
  }

  if (assignmentId && loading) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Loading configuration...</p>
        </div>
      </div>
    );
  }

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
      <button
        type="button"
        className="prompter-btn-start-sm prompter-btn-secondary"
        style={{ marginTop: 8 }}
        onClick={() => setShowCreateModule((s) => !s)}
      >
        + Create new module
      </button>
      {showCreateModule && (
        <div className="prompter-create-module-form" style={{ marginTop: 12, padding: 12, background: '#f8f9fa', borderRadius: 8 }}>
          <input
            type="text"
            value={createModuleName}
            onChange={(e) => setCreateModuleName(e.target.value)}
            placeholder="Module name"
            className="prompter-settings-input"
            style={{ marginBottom: 8 }}
          />
          <label className="prompter-settings-label" style={{ display: 'block', marginBottom: 4 }}>Placement in course</label>
          <select
            className="prompter-settings-input"
            value={createModulePosition}
            onChange={(e) => {
              const v = e.target.value;
              setCreateModulePosition(v === '' ? '' : Number(v));
            }}
            style={{ marginBottom: 8 }}
          >
            <option value="">At end (default)</option>
            {Array.from({ length: Math.max(modules.length + 1, 1) }, (_, i) => i + 1).map((pos) => (
              <option key={pos} value={pos}>
                Position {pos} {pos === 1 ? '(first)' : pos === modules.length + 1 ? '(last)' : `(after module ${pos - 1})`}
              </option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={handleCreateModule}
              disabled={creatingModule || !createModuleName.trim()}
              className="prompter-btn-ready"
            >
              {creatingModule ? 'Creating...' : 'Create Module'}
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

        {needsAssignmentSelector && (
          <>
            <div className="prompter-settings-card">
              <h2 className="prompter-settings-card-title">Grade Submissions</h2>
              <div className="prompter-settings-section">
                <label className="prompter-settings-label">Assignment</label>
                {assignmentSelectOptions}
              </div>
            </div>

            <div className="prompter-settings-card">
              <h2 className="prompter-settings-card-title">Configure Assignment</h2>
              <div className="prompter-settings-section">
                <label className="prompter-settings-label">Select assignment</label>
                {configAssignSelectOptions}
              </div>
              <div className="prompter-settings-section">
                <label className="prompter-settings-label">Create new assignment</label>
                <div className="prompter-settings-create-row">
                  <input
                    type="text"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder="Assignment name"
                    className="prompter-settings-input"
                  />
                  <button
                    type="button"
                    onClick={handleCreateAssignment}
                    disabled={creating}
                    className="prompter-btn-ready"
                  >
                    {creating ? 'Creating...' : 'Create'}
                  </button>
                </div>
              </div>

              {assignmentId && (
                <div className="prompter-settings-config-form">
                  <div className="prompter-settings-section prompter-settings-assignment">
                    <label className="prompter-settings-label"><strong>Warm Up Minutes:</strong></label>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={minutes}
                      onChange={(e) => setMinutes(Number(e.target.value) || 5)}
                      className="prompter-settings-input prompter-settings-input-narrow"
                    />
                  </div>
                  <div className="prompter-settings-section prompter-settings-access">
                    <label className="prompter-settings-label"><strong>Access Code:</strong></label>
                    <input
                      type="text"
                      value={accessCode}
                      onChange={(e) => setAccessCode(e.target.value)}
                      placeholder="Optional"
                      className="prompter-settings-input"
                    />
                  </div>
                  {moduleSelector}
                  <div className="prompter-settings-section prompter-settings-prompts">
                    <div className="prompter-settings-header-row">
                      <label className="prompter-settings-label"><strong>Prompts (warm-up text)</strong></label>
                      <button type="button" onClick={addPrompt} className="prompter-btn-start" style={{ padding: '6px 14px', fontSize: 14 }}>
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
                  </div>
                  <div className="prompter-settings-save-row prompter-settings-actions-row">
                    <button type="button" onClick={handleSave} disabled={saving} className="prompter-btn-ready">
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button type="button" onClick={handleReset} disabled={saving} className="prompter-btn-secondary">
                      Reset
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {!needsAssignmentSelector && (
          <div className="prompter-settings-card">
            <h2 className="prompter-settings-card-title">Configure Assignment</h2>
            <div className="prompter-settings-section prompter-settings-assignment">
              <label className="prompter-settings-label"><strong>Warm Up Minutes:</strong></label>
              <input
                type="number"
                min={1}
                max={60}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value) || 5)}
                className="prompter-settings-input prompter-settings-input-narrow"
              />
            </div>
            <div className="prompter-settings-section prompter-settings-access">
              <label className="prompter-settings-label"><strong>Access Code:</strong></label>
              <input
                type="text"
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
                placeholder="Optional"
                className="prompter-settings-input"
              />
            </div>
            {modules.length > 0 && moduleSelector}
            {modules.length === 0 && (
              <div className="prompter-settings-section">
                <label className="prompter-settings-label"><strong>Module:</strong></label>
                <button
                  type="button"
                  className="prompter-btn-start-sm prompter-btn-secondary"
                  onClick={() => setShowCreateModule((s) => !s)}
                >
                  + Create new module
                </button>
                {showCreateModule && (
                  <div className="prompter-create-module-form" style={{ marginTop: 12, padding: 12, background: '#f8f9fa', borderRadius: 8 }}>
                    <input
                      type="text"
                      value={createModuleName}
                      onChange={(e) => setCreateModuleName(e.target.value)}
                      placeholder="Module name"
                      className="prompter-settings-input"
                      style={{ marginBottom: 8 }}
                    />
                    <label className="prompter-settings-label">Placement: At end (first module)</label>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button type="button" onClick={handleCreateModule} disabled={creatingModule || !createModuleName.trim()} className="prompter-btn-ready">
                        {creatingModule ? 'Creating...' : 'Create Module'}
                      </button>
                      <button type="button" onClick={() => { setShowCreateModule(false); setCreateModuleName(''); }} className="prompter-btn-secondary">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="prompter-settings-section prompter-settings-prompts">
              <div className="prompter-settings-header-row">
                <label className="prompter-settings-label"><strong>Prompts (warm-up text)</strong></label>
                <button type="button" onClick={addPrompt} className="prompter-btn-start" style={{ padding: '6px 14px', fontSize: 14 }}>+ Add to Pool</button>
              </div>
              {prompts.map((p, i) => (
                <div key={i} className="prompter-prompt-item-row">
                  <textarea value={p} onChange={(e) => updatePrompt(i, e.target.value)} rows={2} className="prompter-settings-input" placeholder="Prompt text..." />
                  <button type="button" onClick={() => removePrompt(i)} className="prompter-btn-remove">Remove</button>
                </div>
              ))}
            </div>
            <div className="prompter-settings-save-row prompter-settings-actions-row">
              <button type="button" onClick={handleSave} disabled={saving} className="prompter-btn-ready">{saving ? 'Saving...' : 'Save'}</button>
              <button type="button" onClick={handleReset} disabled={saving} className="prompter-btn-secondary">Reset</button>
            </div>
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
    </div>
  );
}
