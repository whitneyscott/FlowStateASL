import { useEffect, useId, useState } from 'react';
import { getConfiguredModePassword, setStudentBridgeEnabled } from '../utils/app-mode';
import './SupportBridgeDialog.css';

interface SupportBridgeDialogProps {
  open: boolean;
  onClose: () => void;
  /** Shown on first open when URL has ?aslBridgeSupport=1 */
  autoFromQuery?: boolean;
}

/**
 * Password-gated Bridge log for non-developer sessions (e.g. students, who have no "Mode" button).
 * Uses the same MODE_PASSWORD as app mode when set at build/deploy.
 */
export function SupportBridgeDialog({ open, onClose, autoFromQuery = false }: SupportBridgeDialogProps) {
  const titleId = useId();
  const pwdId = useId();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPassword('');
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const expected = getConfiguredModePassword();
  const passwordConfigured = expected.length > 0;

  const enable = () => {
    setError(null);
    if (!passwordConfigured) {
      setError('Support password is not configured for this deployment (MODE_PASSWORD).');
      return;
    }
    if (password !== expected) {
      setError('Incorrect password');
      return;
    }
    setStudentBridgeEnabled(true);
    onClose();
  };

  const disable = () => {
    setError(null);
    setStudentBridgeEnabled(false);
    onClose();
  };

  return (
    <div
      className="support-bridge-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="support-bridge-dialog">
        <h2 id={titleId}>Diagnostic log (support)</h2>
        {autoFromQuery && (
          <p className="support-bridge-hint">
            You opened this page with a support link. Enter the support password to show the Bridge Debug Log in
            this browser (Demo or Production is fine). Your instructor or support can use the same log to see timing
            and client events.
          </p>
        )}
        {!autoFromQuery && (
          <p className="support-bridge-hint">
            After you enable this, a green <strong>BRIDGE DEBUG LOG</strong> panel appears at the top. Use it when
            asked to share what the app is doing. Turn it off when finished.
          </p>
        )}
        <label className="support-bridge-label" htmlFor={pwdId}>
          Support password
        </label>
        <input
          id={pwdId}
          className="support-bridge-input"
          type="password"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={passwordConfigured ? 'Enter password' : 'Not configured on this site'}
          disabled={!passwordConfigured}
        />
        {error && (
          <p className="support-bridge-error" role="alert">
            {error}
          </p>
        )}
        <div className="support-bridge-actions">
          <button type="button" className="support-bridge-btn support-bridge-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="support-bridge-btn support-bridge-btn-warn" onClick={disable}>
            Turn off log
          </button>
          <button
            type="button"
            className="support-bridge-btn support-bridge-btn-primary"
            onClick={enable}
            disabled={!passwordConfigured}
          >
            Show log
          </button>
        </div>
      </div>
    </div>
  );
}
