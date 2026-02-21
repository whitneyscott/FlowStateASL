import { useState, useEffect } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';

export function useLtiContext() {
  const [context, setContext] = useState<LtiContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ltiToken = params.get('lti_token');
    const url = ltiToken
      ? `/api/lti/context?lti_token=${encodeURIComponent(ltiToken)}`
      : '/api/lti/context';
    fetch(url, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText);
        return res.json();
      })
      .then((data) => {
        setContext(data);
        setError(null);
        if (ltiToken) {
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
