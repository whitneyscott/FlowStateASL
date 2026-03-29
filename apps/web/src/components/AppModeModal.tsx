import { useEffect, useId, useState } from 'react';
import type { AppMode } from '../utils/app-mode';

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
        'Developer and Production modes need VITE_APP_MODE_PASSWORD set at build time. In local dev, the default is dev2025 when the env var is unset.',
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
          Demo hides developer tools. Developer shows the Bridge debug log and token reset. Production matches Demo
          here (no debug UI) — use it to mirror Canvas Bulk Editor workflows.
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
            <div className="app-mode-option-hint">Default; no Bridge Log or dev actions.</div>
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
            <div className="app-mode-option-hint">Bridge Log, clear Canvas token, ?debug=1 parity.</div>
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
