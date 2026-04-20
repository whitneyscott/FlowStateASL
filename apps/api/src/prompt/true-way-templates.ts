import type { PromptConfigJson } from './dto/prompt-config.dto';

export type TrueWayAssignmentKind = 'soar' | 'watch_and_sign' | 'production';

export interface TrueWayTemplateMatch {
  assignmentId: string;
  name: string;
  kind: TrueWayAssignmentKind;
  unitNumber: number;
  subUnit?: number;
}

const RE_SOAR = /^Unit (\d+) SOAR$/i;
const RE_WATCH = /^Unit (\d+)(?:\.(\d+))? Watch and Sign$/i;
const RE_PRODUCTION = /^Unit (\d+)(?:\.(\d+))? Production$/i;

export function matchTrueWayAssignmentTitle(
  name: string,
): { kind: TrueWayAssignmentKind; unitNumber: number; subUnit?: number } | null {
  const n = name.trim();
  let m = n.match(RE_SOAR);
  if (m) {
    return { kind: 'soar', unitNumber: Number(m[1]) };
  }
  m = n.match(RE_WATCH);
  if (m) {
    const sub = m[2] != null && m[2] !== '' ? Number(m[2]) : undefined;
    return {
      kind: 'watch_and_sign',
      unitNumber: Number(m[1]),
      ...(Number.isFinite(sub) ? { subUnit: sub } : {}),
    };
  }
  m = n.match(RE_PRODUCTION);
  if (m) {
    const sub = m[2] != null && m[2] !== '' ? Number(m[2]) : undefined;
    return {
      kind: 'production',
      unitNumber: Number(m[1]),
      ...(Number.isFinite(sub) ? { subUnit: sub } : {}),
    };
  }
  return null;
}

function parseOlLiSentences(html: string): string[] {
  const out: string[] = [];
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let x: RegExpExecArray | null;
  while ((x = re.exec(html)) !== null) {
    const text = x[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) out.push(text);
  }
  return out.slice(0, 10);
}

/** Best-effort defaults merged into existing Prompt Manager config for TRUE+WAY-style titles. */
export function buildPartialPromptConfigForTrueWay(
  kind: TrueWayAssignmentKind,
  assignmentName: string,
  descriptionHtml: string,
): Partial<PromptConfigJson> {
  const base: Partial<PromptConfigJson> = {
    assignmentName,
  };
  if (kind === 'soar') {
    const prompts = parseOlLiSentences(descriptionHtml);
    return {
      ...base,
      promptMode: 'text',
      prompts: prompts.length > 0 ? prompts : [''],
      minutes: 5,
    };
  }
  if (kind === 'watch_and_sign') {
    return {
      ...base,
      promptMode: 'text',
      prompts: ['Watch the stimulus video, then record your response in one take.'],
      minutes: 3,
    };
  }
  return {
    ...base,
    promptMode: 'text',
    prompts: ['Production assessment — configure timing and rubric in Prompt Manager.'],
    minutes: 10,
  };
}

export function scanTrueWayAssignments(
  assignments: Array<{ id: string; name: string }>,
): TrueWayTemplateMatch[] {
  const out: TrueWayTemplateMatch[] = [];
  for (const a of assignments) {
    const m = matchTrueWayAssignmentTitle(a.name);
    if (m) {
      out.push({
        assignmentId: a.id,
        name: a.name,
        kind: m.kind,
        unitNumber: m.unitNumber,
        ...(typeof m.subUnit === 'number' && Number.isFinite(m.subUnit) ? { subUnit: m.subUnit } : {}),
      });
    }
  }
  return out;
}
