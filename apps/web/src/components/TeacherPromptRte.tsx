import { useCallback, useMemo, useRef, useState } from 'react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { PromptCourseImageModal } from './PromptCourseImageModal';

/** Quill has no separate `bullet` format — lists use `list` (ordered vs bullet is the list value). */
const FORMATS = ['header', 'bold', 'italic', 'underline', 'list', 'link', 'image'];

type TeacherPromptRteProps = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** Extra class on the outer wrapper (for layout / theme hooks). */
  className?: string;
  /**
   * Unique per editor instance, and must change when GET /config applies new prompt HTML.
   * react-quill often leaves the field blank when `value` is set only after async load; changing `key` remounts
   * the editor so the initial `value` is shown (see FlowStateASL Prompt Manager text mode).
   */
  remountKey: string | number;
};

export function TeacherPromptRte({ value, onChange, placeholder, className, remountKey }: TeacherPromptRteProps) {
  const wrapClass = ['prompter-prompt-rte-wrap', className].filter(Boolean).join(' ');
  const quillRef = useRef<ReactQuill>(null);
  const [imageModalOpen, setImageModalOpen] = useState(false);

  const insertImageUrl = useCallback((url: string) => {
    const editor = quillRef.current?.getEditor();
    if (!editor || !url.trim()) return;
    const range = editor.getSelection(true);
    const idx = range ? range.index : Math.max(0, editor.getLength() - 1);
    editor.insertEmbed(idx, 'image', url.trim(), 'user');
    editor.setSelection(idx + 1, 0, 'silent');
  }, []);

  const modules = useMemo(
    () => ({
      toolbar: {
        container: [
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['link', 'image'],
          ['clean'],
        ],
        handlers: {
          image: () => setImageModalOpen(true),
        },
      },
    }),
    [],
  );

  return (
    <div className={wrapClass}>
      <ReactQuill
        ref={quillRef}
        key={String(remountKey)}
        theme="snow"
        value={value ?? ''}
        onChange={onChange}
        modules={modules}
        formats={FORMATS}
        placeholder={placeholder}
      />
      <PromptCourseImageModal
        open={imageModalOpen}
        onClose={() => setImageModalOpen(false)}
        onInserted={(url) => {
          insertImageUrl(url);
          setImageModalOpen(false);
        }}
      />
    </div>
  );
}
