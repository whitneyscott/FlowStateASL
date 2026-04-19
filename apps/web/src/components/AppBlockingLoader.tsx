import { createPortal } from 'react-dom';
import { useLayoutEffect } from 'react';
import './AppBlockingLoader.css';

export interface AppBlockingLoaderProps {
  active: boolean;
  message: string;
  subMessage?: string;
}

/**
 * Full-viewport blocking overlay (portaled to document.body): spinner, message,
 * pointer capture, and body/html overflow lock while active.
 */
export function AppBlockingLoader({ active, message, subMessage }: AppBlockingLoaderProps) {
  useLayoutEffect(() => {
    if (!active) return;
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
    };
  }, [active]);

  if (!active) return null;

  return createPortal(
    <div className="app-blocking-loader-root" aria-busy="true">
      <div className="app-blocking-loader-backdrop" aria-hidden="true" />
      <div className="app-blocking-loader-panel" role="status" aria-live="polite">
        <div className="app-blocking-loader-spinner" aria-hidden />
        <p className="app-blocking-loader-message">{message}</p>
        {subMessage ? <p className="app-blocking-loader-sub">{subMessage}</p> : null}
      </div>
    </div>,
    document.body,
  );
}
