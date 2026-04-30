import { useEffect, type MutableRefObject } from 'react';
import './TeacherFeedbackRichEditor.css';

function exec(cmd: string, value?: string) {
  try {
    document.execCommand(cmd, false, value);
  } catch {
    /* ignore */
  }
}

interface TeacherFeedbackRichEditorProps {
  initialHtml: string;
  autoFocus?: boolean;
  /** When true, the typing area is on top and Bold/Italic/etc. sit below (e.g. Teacher Viewer freeform). */
  toolbarAtBottom?: boolean;
  /** Ref to the contenteditable element (read innerHTML when saving). */
  editorRef: MutableRefObject<HTMLDivElement | null>;
}

/** Minimal rich text (contentEditable + execCommand) for grading feedback stored as HTML. */
export function TeacherFeedbackRichEditor({
  initialHtml,
  autoFocus,
  toolbarAtBottom = false,
  editorRef,
}: TeacherFeedbackRichEditorProps) {
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.innerHTML = initialHtml || '';
    if (autoFocus) {
      el.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      } catch {
        /* ignore */
      }
    }
  }, [initialHtml, autoFocus, editorRef]);

  const onToolbarMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  const toolbar = (
    <div className="teacher-feedback-richtext-toolbar" onMouseDown={onToolbarMouseDown}>
      <button type="button" className="teacher-feedback-richtext-toolbar-btn" onClick={() => exec('bold')}>
        Bold
      </button>
      <button type="button" className="teacher-feedback-richtext-toolbar-btn" onClick={() => exec('italic')}>
        Italic
      </button>
      <button type="button" className="teacher-feedback-richtext-toolbar-btn" onClick={() => exec('underline')}>
        Underline
      </button>
      <button type="button" className="teacher-feedback-richtext-toolbar-btn" onClick={() => exec('insertUnorderedList')}>
        List
      </button>
      <button type="button" className="teacher-feedback-richtext-toolbar-btn" onClick={() => exec('insertOrderedList')}>
        Numbered
      </button>
      <button type="button" className="teacher-feedback-richtext-toolbar-btn" onClick={() => exec('removeFormat')}>
        Clear format
      </button>
    </div>
  );

  const editor = (
    <div
      ref={editorRef}
      className="teacher-feedback-richtext-editor"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
    />
  );

  return (
    <div
      className={`teacher-feedback-richtext${toolbarAtBottom ? ' teacher-feedback-richtext--toolbar-bottom' : ''}`}
    >
      {toolbarAtBottom ? (
        <>
          {editor}
          {toolbar}
        </>
      ) : (
        <>
          {toolbar}
          {editor}
        </>
      )}
    </div>
  );
}
