import Quill from 'quill';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

/** Pixel font sizes for the inline `font-size` style (not heading levels). */
const FONT_SIZES = [
  '10px',
  '11px',
  '12px',
  '13px',
  '14px',
  '15px',
  '16px',
  '18px',
  '20px',
  '22px',
  '24px',
  '28px',
  '32px',
  '36px',
  '48px',
] as const;

/** Same registry `react-quill` uses — avoid a second copy from `quill/formats/size` import. */
const SizeStyle = Quill.import('attributors/style/size') as { whitelist: string[] };
SizeStyle.whitelist = [...FONT_SIZES];
Quill.register({ 'formats/size': SizeStyle }, true);

const MODULES = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    [{ size: [...FONT_SIZES, false] }],
    ['bold', 'italic', 'underline'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['link'],
    ['clean'],
  ],
};

const FORMATS = ['header', 'size', 'bold', 'italic', 'underline', 'list', 'bullet', 'link'];

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
