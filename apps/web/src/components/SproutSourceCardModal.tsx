import { useEffect, useId, useRef } from 'react';
import './SproutSourceCardModal.css';

export interface SproutSourceCardModalProps {
  isOpen: boolean;
  onClose: () => void;
  sproutAccountId: string;
  videoId: string;
}

/**
 * Full-screen-style overlay with Sprout embed for the deck source card (teacher grading).
 */
export function SproutSourceCardModal({
  isOpen,
  onClose,
  sproutAccountId,
  videoId,
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
  }, [isOpen, videoId]);

  if (!isOpen || !videoId.trim() || !sproutAccountId.trim()) {
    return null;
  }

  const src = `https://videos.sproutvideo.com/embed/${encodeURIComponent(sproutAccountId.trim())}/${encodeURIComponent(videoId.trim())}`;

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
              key={videoId}
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
