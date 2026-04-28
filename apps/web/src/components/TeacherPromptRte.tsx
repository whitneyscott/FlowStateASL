import { useMemo } from 'react';
import Quill from 'quill';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

/** Pixel font sizes (inline `style="font-size: …"` — survives storage better than class-only sizes). */
const RTE_FONT_SIZES = ['10px', '12px', '14px', '16px', '18px', '20px', '24px', '28px', '32px'] as const;

const SizeStyle = Quill.import('attributors/style/size') as { whitelist: string[] };
SizeStyle.whitelist = [...RTE_FONT_SIZES];
Quill.register({ 'formats/size': SizeStyle }, true);

const RTE_FORMATS = ['header', 'size', 'bold', 'italic', 'underline', 'list', 'bullet', 'link'] as const;

type TeacherPromptRteProps = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** Extra class on the outer wrapper (for layout / theme hooks). */
  className?: string;
};

export function TeacherPromptRte({ value, onChange, placeholder, className }: TeacherPromptRteProps) {
  const modules = useMemo(
    () => ({
      toolbar: {
        container: [
          [{ header: [1, 2, 3, false] }],
          [{ size: [...RTE_FONT_SIZES, false] }],
          ['bold', 'italic', 'underline'],
          [{ list: 'ordered' }, { list: 'bullet' }],
          ['link'],
          ['clean'],
        ],
      },
    }),
    [],
  );

  const wrapClass = ['prompter-prompt-rte-wrap', className].filter(Boolean).join(' ');
  return (
    <div className={wrapClass}>
      <ReactQuill
        theme="snow"
        value={value ?? ''}
        onChange={onChange}
        modules={modules}
        formats={[...RTE_FORMATS]}
        placeholder={placeholder}
      />
    </div>
  );
}
