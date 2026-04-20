import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

const MODULES = {
  toolbar: [
    ['bold', 'italic', 'underline'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['link'],
    ['clean'],
  ],
};

const FORMATS = ['bold', 'italic', 'underline', 'list', 'bullet', 'link'];

type TeacherPromptRteProps = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** Extra class on the outer wrapper (for layout / theme hooks). */
  className?: string;
};

export function TeacherPromptRte({ value, onChange, placeholder, className }: TeacherPromptRteProps) {
  const wrapClass = ['prompter-prompt-rte-wrap', className].filter(Boolean).join(' ');
  return (
    <div className={wrapClass}>
      <ReactQuill
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
