import { useState, useEffect } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';
import { useDebug } from '../contexts/DebugContext';
import { getAuthToken, setAuthToken } from '../api/lti-token';

export function useLtiContext() {
  const { setLastFunction } = useDebug();
  const [context, setContext] = useState<LtiContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const bootNonce = params.get('boot_nonce') ?? '';
    const url = bootNonce
      ? `/api/lti/context?boot_nonce=${encodeURIComponent(bootNonce)}`
      : '/api/lti/context';
    setLastFunction(`GET ${url}`);
    const attempt = async (retries = 3): Promise<Response> => {
      const token = getAuthToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      const res = await fetch(url, { headers });
      if (res.ok) return res;
      if (retries > 1 && (res.status === 0 || res.status >= 502)) {
        await new Promise((r) => setTimeout(r, 1500));
        return attempt(retries - 1);
      }
      throw new Error(res.statusText);
    };
    attempt()
      .then((res) => res.json())
      .then((data: LtiContext & { authToken?: string; bootNonce?: string }) => {
        if (data?.authToken) {
          setAuthToken(data.authToken);
        }
        // assignmentId is what Timer/prompt config use—include it for student deck vs text debugging.
        console.info('[useLtiContext] loaded', {
          source: bootNonce ? 'boot_nonce' : 'bearer',
          courseId: data?.courseId,
          assignmentId: data?.assignmentId,
          resourceLinkId: data?.resourceLinkId,
          toolType: data?.toolType,
          userId: data?.userId,
          roles: data?.roles,
          hasContext: !!(data?.courseId && data?.userId !== 'standalone'),
        });
        setContext(data);
        setError(null);
        if (bootNonce || data?.bootNonce) {
          const url = new URL(window.location.href);
          if (data?.bootNonce) {
            url.searchParams.set('boot_nonce', data.bootNonce);
          } else {
            url.searchParams.delete('boot_nonce');
          }
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
