import { useId, useState } from 'react';
import './ManualTokenModal.css';

interface ManualTokenModalProps {
  message?: string;
  onSuccess: () => void;
  onDismiss?: () => void;
  variant?: 'default' | 'prompter';
}

export function ManualTokenModal({ message, onSuccess, onDismiss, variant = 'default' }: ManualTokenModalProps) {
  const fieldId = useId();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setError('Please enter your Canvas API token');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/oauth/canvas/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token: token.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error ?? `HTTP ${res.status}`);
        return;
      }
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save token');
    } finally {
      setSubmitting(false);
    }
  };

  const handleContinue = () => {
    setSaved(false);
    setToken('');
    onSuccess();
  };

  return (
    <div
      className={`manual-token-overlay ${variant === 'prompter' ? 'manual-token-overlay--prompter' : ''}`}
      role="presentation"
    >
      <div
        className={`manual-token-modal ${variant === 'prompter' ? 'manual-token-modal--prompter' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-token-title"
      >
        <h3 id="manual-token-title">Canvas API token</h3>
        <p className="manual-token-message">
          {message ??
            'LTI 1.1 does not support OAuth. Enter your Canvas API token to continue.'}
        </p>
        <p className="manual-token-hint">
          Generate a token in Canvas: <strong>Account</strong> → <strong>Settings</strong> →{' '}
          <strong>New Access Token</strong>.
        </p>

        {!saved ? (
          <form onSubmit={handleSubmit} className="manual-token-form">
            <label htmlFor={fieldId} className="manual-token-label">
              Paste your token
            </label>
            <input
              id={fieldId}
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="e.g. 1045~…"
              className="manual-token-input"
              autoComplete="off"
              disabled={submitting}
              spellCheck={false}
            />
            <label className="manual-token-show-label">
              <input
                type="checkbox"
                checked={showToken}
                onChange={(e) => setShowToken(e.target.checked)}
                disabled={submitting}
              />
              Show token
            </label>
            {error && (
              <p className="manual-token-error" role="alert">
                {error}
              </p>
            )}
            <div className="manual-token-actions">
              <button type="submit" disabled={submitting} className="manual-token-submit">
                {submitting ? 'Saving…' : 'Submit token'}
              </button>
              {onDismiss && (
                <button
                  type="button"
                  onClick={onDismiss}
                  disabled={submitting}
                  className="manual-token-dismiss"
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        ) : (
          <div className="manual-token-success" role="status">
            <div className="manual-token-check-wrap" aria-hidden>
              <svg className="manual-token-check-icon" viewBox="0 0 52 52" focusable="false">
                <circle className="manual-token-check-circle" cx="26" cy="26" r="24" fill="none" />
                <path className="manual-token-check-mark" fill="none" d="M14 27l8 8 16-16" />
              </svg>
            </div>
            <p className="manual-token-success-title">Token saved</p>
            <p className="manual-token-success-detail">
              Your Canvas token is stored for this session. You can continue in the app.
            </p>
            <button type="button" className="manual-token-submit" onClick={handleContinue}>
              Continue
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
