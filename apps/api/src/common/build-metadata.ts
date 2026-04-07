/**
 * Resolve git commit from common host env vars (no secrets).
 * Render: https://render.com/docs/environment-variables
 */
export interface BuildMetadata {
  gitCommit: string | null;
  /** First 7 chars when full SHA; else whole string */
  gitCommitShort: string | null;
  /** Which env var supplied the commit, for debugging */
  source: string | null;
}

export function getBuildMetadata(): BuildMetadata {
  const candidates: ReadonlyArray<readonly [string, string | undefined]> = [
    ['RENDER_GIT_COMMIT', process.env.RENDER_GIT_COMMIT],
    ['SOURCE_VERSION', process.env.SOURCE_VERSION],
    ['GIT_COMMIT', process.env.GIT_COMMIT],
    ['VERCEL_GIT_COMMIT_SHA', process.env.VERCEL_GIT_COMMIT_SHA],
    ['COMMIT_SHA', process.env.COMMIT_SHA],
    ['GITHUB_SHA', process.env.GITHUB_SHA],
  ];
  for (const [source, val] of candidates) {
    const v = (val ?? '').trim();
    if (v) {
      return {
        gitCommit: v,
        gitCommitShort: v.length >= 7 ? v.slice(0, 7) : v,
        source,
      };
    }
  }
  return { gitCommit: null, gitCommitShort: null, source: null };
}
