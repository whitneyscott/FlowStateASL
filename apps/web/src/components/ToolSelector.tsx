import type { LtiContext } from '@aslexpress/shared-types';

const TEACHER_PATTERNS = ['instructor','administrator','faculty','teacher','staff','contentdeveloper','teachingassistant','ta'];

function isTeacher(roles: string): boolean {
  if (!roles || typeof roles !== 'string') return false;
  return TEACHER_PATTERNS.some((p) => roles.toLowerCase().includes(p));
}

interface ToolSelectorProps {
  context: LtiContext | null;
  currentTool: 'flashcards' | 'prompter';
}

export function ToolSelector({ context, currentTool }: ToolSelectorProps) {
  const teacher = context && isTeacher(context.roles) && context.courseId && context.userId !== 'standalone';
  if (!teacher) return null;

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-3 flex gap-2">
      <button
        type="button"
        className={`px-4 py-2 rounded font-semibold ${
          currentTool === 'flashcards'
            ? 'bg-emerald-600 text-white'
            : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
        }`}
      >
        Flashcards
      </button>
      <button
        type="button"
        disabled
        className="px-4 py-2 rounded font-semibold bg-zinc-800 text-zinc-500 cursor-not-allowed"
        title="Coming soon"
      >
        Prompt Manager (inactive)
      </button>
    </div>
  );
}
