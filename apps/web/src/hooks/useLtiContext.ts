import { useState, useEffect } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { getStoredLtiToken, setStoredLtiToken } from '../api/lti-token';

export function useLtiContext() {
  const { setLastFunction } = useDebug();
  const [context, setContext] = useState<LtiContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ltiTokenFromUrl = params.get('lti_token');
    const ltiToken = ltiTokenFromUrl ?? getStoredLtiToken();
    if (ltiTokenFromUrl) setStoredLtiToken(ltiTokenFromUrl);
    const url = ltiToken
      ? `/api/lti/context?lti_token=${encodeURIComponent(ltiToken)}`
      : '/api/lti/context';
    setLastFunction(`GET ${url}`);
    const attempt = async (retries = 3): Promise<Response> => {
      const res = await fetch(url, { credentials: 'include' });
      if (res.ok) return res;
      if (retries > 1 && (res.status === 0 || res.status >= 502)) {
        await new Promise((r) => setTimeout(r, 1500));
        return attempt(retries - 1);
      }
      throw new Error(res.statusText);
    };
    attempt()
      .then((res) => res.json())
      .then((data) => {
        console.log('[useLtiContext] loaded:', {
          source: ltiToken ? 'lti_token' : 'session',
          courseId: data?.courseId,
          userId: data?.userId,
          hasContext: !!(data?.courseId && data?.userId !== 'standalone'),
        });
        setContext(data);
        setError(null);
        if (ltiTokenFromUrl) {
          const url = new URL(window.location.href);
          url.searchParams.delete('lti_token');
          window.history.replaceState({}, '', url.toString());
        }
      })
      .catch((err) => {
        setError(err.message ?? 'Failed to load context');
        setContext(null);
      })
      .finally(() => setLoading(false));
  }, []);

  return { context, loading, error };
}
