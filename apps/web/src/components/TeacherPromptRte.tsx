import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

const MODULES = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ['bold', 'italic', 'underline'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['link'],
    ['clean'],
  ],
};

/** Quill has no separate `bullet` format — lists use `list` (ordered vs bullet is the list value). */
const FORMATS = ['header', 'bold', 'italic', 'underline', 'list', 'link'];

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
  return (
    <div className={wrapClass}>
      <ReactQuill
        key={String(remountKey)}
        theme="snow"
        value={value ?? ''}
        onChange={onChange}
        modules={MODULES}
        formats={FORMATS}
        placeholder={placeholder}
      />
    </div>
  );
}
