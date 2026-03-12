import { useCallback, useEffect, useState } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
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
  const [config, setConfig] = useState<promptApi.PromptConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(5);
  const [prompts, setPrompts] = useState<string[]>([]);
  const [accessCode, setAccessCode] = useState('');

  const teacher = context && isTeacher(context.roles);
  const hasLti = context?.courseId && context.userId !== 'standalone';

  const load = useCallback(async () => {
    if (!hasLti) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setLastFunction('GET /api/prompt/config');
      const data = await promptApi.getPromptConfig();
      setLastApiResult('GET /api/prompt/config', 200, true);
      setConfig(data ?? null);
      if (data) {
        setMinutes(data.minutes ?? 5);
        setPrompts(Array.isArray(data.prompts) ? data.prompts : []);
        setAccessCode(data.accessCode ?? '');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setLastApiError('GET /api/prompt/config', 0, msg);
    } finally {
      setLoading(false);
    }
  }, [hasLti, setLastFunction, setLastApiResult, setLastApiError]);

  useEffect(() => {
    if (teacher && hasLti) load();
    else setLoading(false);
  }, [teacher, hasLti, load]);

  const handleSave = async () => {
    if (!teacher || !hasLti) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      setLastFunction('PUT /api/prompt/config');
      await promptApi.putPromptConfig({
        minutes,
        prompts,
        accessCode,
      });
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

  const addPrompt = () => setPrompts((p) => [...p, '']);
  const updatePrompt = (i: number, v: string) =>
    setPrompts((p) => {
      const next = [...p];
      next[i] = v;
      return next;
    });
  const removePrompt = (i: number) => setPrompts((p) => p.filter((_, j) => j !== i));

  const handleReset = async () => {
    if (!teacher || !hasLti) return;
    setMinutes(5);
    setPrompts([]);
    setAccessCode('');
    setAssignmentName('');
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      setLastFunction('PUT /api/prompt/config');
      await promptApi.putPromptConfig({
        minutes: 5,
        prompts: [],
        accessCode: '',
        assignmentName: '',
      });
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

  if (!teacher || !context) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Teacher access required.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="prompter-page">
        <div className="prompter-card">
          <p className="prompter-info-message">Loading configuration...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="prompter-page">
      <div className="prompter-card">
        <h1>Prompt Manager Settings</h1>
        {error && <div className="prompter-alert-error">{error}</div>}
        {saved && <div className="prompter-alert-success">Saved.</div>}
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
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="prompter-btn-ready"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            onClick={handleReset}
            disabled={saving}
            className="prompter-btn-secondary"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
