import { NavLink } from 'react-router-dom';
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

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `px-4 py-2 rounded font-semibold no-underline ${isActive ? 'bg-emerald-600 text-white' : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'}`;

export function ToolSelector({ context, currentTool }: ToolSelectorProps) {
  const teacher = context && isTeacher(context.roles) && context.courseId && context.userId !== 'standalone';

  if (currentTool === 'prompter') {
    if (!teacher) return null;
    return (
      <div className="w-full max-w-4xl mx-auto px-4 py-3 flex gap-2">
        <NavLink to="/prompter" end className={navLinkClass}>Timer</NavLink>
        <NavLink to="/config" className={navLinkClass}>Config</NavLink>
        <NavLink to="/viewer?grading=1" className={navLinkClass}>Grade</NavLink>
      </div>
    );
  }

  // Flashcards: no Prompt Manager / Flashcards cross-links — unified entry from Canvas placement.
  return null;
}
