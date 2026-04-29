import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { SupportBridgeDialog } from './SupportBridgeDialog';

export interface SupportBridgeLauncherProps {
  /**
   * Must be derived from the same `useLtiContext` result as AppRouter only — never mount a second
   * `useLtiContext` (two GET /api/lti/context calls with the same one-time `boot_nonce` would burn
   * the nonce and fall back to `toolType: 'flashcards'`).
   */
  showSupportButton: boolean;
}

/**
 * Password-gated Bridge log for learners (no "Mode" button). Teachers use Developer mode instead.
 * `?aslBridgeSupport=1` opens the dialog (e.g. support email link from instructor).
 */
export function SupportBridgeLauncher({ showSupportButton }: SupportBridgeLauncherProps) {
  const [open, setOpen] = useState(false);
  const [fromQuery, setFromQuery] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const v = q.get('aslBridgeSupport');
    if (v !== '1' && v?.toLowerCase() !== 'true') {
      return;
    }
    setFromQuery(true);
    setOpen(true);
    q.delete('aslBridgeSupport');
    const nextSearch = q.toString();
    const next = `${location.pathname}${nextSearch ? `?${nextSearch}` : ''}${location.hash || ''}`;
    const current = `${location.pathname}${location.search}${location.hash || ''}`;
    if (next !== current) {
      navigate(next, { replace: true });
    }
  }, [location.search, location.pathname, location.hash, navigate]);

  return (
    <>
      <SupportBridgeDialog
        open={open}
        onClose={() => {
          setOpen(false);
          setFromQuery(false);
        }}
        autoFromQuery={fromQuery}
      />
      {showSupportButton && (
        <button
          type="button"
          className="app-mode-support-float-btn"
          onClick={() => {
            setFromQuery(false);
            setOpen(true);
          }}
          title="Show diagnostic log (password from instructor)"
        >
          Support: diagnostic log
        </button>
      )}
    </>
  );
}
