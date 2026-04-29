import { useEffect, useId, useState } from 'react';
import type { AppMode } from '../utils/app-mode';
import { ltiTokenHeaders } from '../api/lti-token';

interface AppModeModalProps {
  open: boolean;
  currentMode: AppMode;
  onClose: () => void;
  getExpectedPassword: () => string;
  onApplyMode: (mode: AppMode) => void;
}

export function AppModeModal({
  open,
  currentMode,
  onClose,
  getExpectedPassword,
  onApplyMode,
}: AppModeModalProps) {
  const titleId = useId();
  const pwdId = useId();
  const [selected, setSelected] = useState<AppMode>(currentMode);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [resettingToken, setResettingToken] = useState(false);

  useEffect(() => {
    if (open) {
      setSelected(currentMode);
      setPassword('');
      setError(null);
    }
  }, [open, currentMode]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const showPassword = selected !== 'demo';

  const apply = () => {
    setError(null);
    if (selected === 'demo') {
      onApplyMode('demo');
      onClose();
      return;
    }

    const expected = getExpectedPassword();
    if (!expected) {
      setError(
        'Developer and Production modes require MODE_PASSWORD to be set at build/deploy time.',
      );
      return;
    }
    if (password !== expected) {
      setError('Incorrect password');
      return;
    }

    onApplyMode(selected);
    onClose();
  };

  const resetCanvasToken = async () => {
    setError(null);
    setResettingToken(true);
    try {
      const res = await fetch('/api/oauth/canvas/token/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ltiTokenHeaders() },
        credentials: 'include',
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || `Could not reset token (HTTP ${res.status})`);
        return;
      }
      // Force a clean app refresh so next protected call prompts for manual token / OAuth again.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset token');
    } finally {
      setResettingToken(false);
    }
  };

  return (
    <div
      className="app-mode-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="app-mode-modal">
        <h2 id={titleId}>Application mode</h2>
        <p className="app-mode-modal-desc">
          Applies to <strong>Prompt Manager</strong> and <strong>Flashcards</strong> in this app. Demo and Production
          hide the Bridge debug log and related client diagnostics. Only <strong>Developer</strong> shows them (after
          password). Production matches Demo for this UI — use it to mirror Canvas Bulk Editor workflows.
        </p>

        <label className="app-mode-option">
          <input
            type="radio"
            name="aslAppMode"
            value="demo"
            checked={selected === 'demo'}
            onChange={() => setSelected('demo')}
          />
          <span>
            <div className="app-mode-option-label">Demo</div>
            <div className="app-mode-option-hint">Default; no Bridge Log or dev actions (both tools).</div>
          </span>
        </label>

        <label className="app-mode-option">
          <input
            type="radio"
            name="aslAppMode"
            value="developer"
            checked={selected === 'developer'}
            onChange={() => setSelected('developer')}
          />
          <span>
            <div className="app-mode-option-label">Developer</div>
            <div className="app-mode-option-hint">Bridge Log and clear Canvas token on teacher routes.</div>
          </span>
        </label>

        <label className="app-mode-option">
          <input
            type="radio"
            name="aslAppMode"
            value="production"
            checked={selected === 'production'}
            onChange={() => setSelected('production')}
          />
          <span>
            <div className="app-mode-option-label">Production</div>
            <div className="app-mode-option-hint">Same UI as Demo for this app (password required to select).</div>
          </span>
        </label>

        {showPassword && (
          <div className="app-mode-password-block">
            <label htmlFor={pwdId}>Mode password</label>
            <input
              id={pwdId}
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
            />
          </div>
        )}

        {error && (
          <p className="app-mode-error" role="alert">
            {error}
          </p>
        )}

        <div className="app-mode-actions">
          <button
            type="button"
            className="app-mode-btn app-mode-btn-warning"
            onClick={resetCanvasToken}
            disabled={resettingToken}
            title="Clear Canvas token from this session and reload"
          >
            {resettingToken ? 'Resetting token...' : 'Reset Canvas token'}
          </button>
          <button type="button" className="app-mode-btn app-mode-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="app-mode-btn app-mode-btn-primary" onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
