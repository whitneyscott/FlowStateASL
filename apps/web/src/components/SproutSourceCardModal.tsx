import { useEffect, useId, useRef } from 'react';
import { appendBridgeLog } from '../utils/bridge-log';
import { buildSproutVideoEmbedUrl } from '../utils/sprout-embed';
import './SproutSourceCardModal.css';

export interface SproutSourceCardModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Sprout API video id (first path segment). */
  videoId: string;
  /** Sprout security token (second path segment in embed URL). */
  securityToken: string;
}

/**
 * Full-screen-style overlay with Sprout embed for the deck source card.
 */
export function SproutSourceCardModal({
  isOpen,
  onClose,
  videoId,
  securityToken,
}: SproutSourceCardModalProps) {
  const titleId = useId();
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    closeBtnRef.current?.focus();
  }, [isOpen, videoId, securityToken]);

  useEffect(() => {
    if (!isOpen || !videoId.trim() || !securityToken.trim()) return;
    const vid = videoId.trim();
    const tok = securityToken.trim();
    const src = buildSproutVideoEmbedUrl(vid, tok);
    console.info('[SproutSourceCard] open embed', { videoId: vid, securityToken: tok, embedSrc: src });
    appendBridgeLog('sprout-source-card', 'Sprout source modal open', {
      videoId: vid,
      embedSrc: src,
    });
  }, [isOpen, videoId, securityToken]);

  if (!isOpen || !videoId.trim() || !securityToken.trim()) {
    return null;
  }

  const src = buildSproutVideoEmbedUrl(videoId, securityToken);

  return (
    <div
      className="prompter-source-card-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="prompter-source-card-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="prompter-source-card-modal-header">
          <h2 id={titleId} className="prompter-source-card-modal-title">
            Source card (Sprout)
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            className="prompter-source-card-modal-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="prompter-source-card-modal-body">
          <div className="prompter-source-card-modal-iframe-wrap">
            <iframe
              key={`${videoId}-${securityToken}`}
              title="Sprout source card video"
              src={src}
              allow="fullscreen; autoplay; encrypted-media"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
