import { useState } from 'react';
import './ManualTokenModal.css';

interface ManualTokenModalProps {
  message?: string;
  onSuccess: () => void;
  onDismiss?: () => void;
}

export function ManualTokenModal({ message, onSuccess, onDismiss }: ManualTokenModalProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save token');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="manual-token-overlay">
      <div className="manual-token-modal">
        <h3>Canvas API Token Required</h3>
        <p className="manual-token-message">
          {message ??
            'LTI 1.1 does not support OAuth. Enter your Canvas API token to continue.'}
        </p>
        <p className="manual-token-hint">
          You can generate a token in Canvas: Profile → Settings → New Access Token.
        </p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste your Canvas API token"
            className="manual-token-input"
            autoComplete="off"
            disabled={submitting}
          />
          {error && <p className="manual-token-error">{error}</p>}
          <div className="manual-token-actions">
            <button type="submit" disabled={submitting} className="manual-token-submit">
              {submitting ? 'Saving...' : 'Save Token'}
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
      </div>
    </div>
  );
}
