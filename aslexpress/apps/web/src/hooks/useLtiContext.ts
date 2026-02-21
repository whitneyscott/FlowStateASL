import { useState, useEffect } from 'react';
import type { LtiContext } from '@aslexpress/shared-types';

export function useLtiContext() {
  const [context, setContext] = useState<LtiContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/lti/context', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText);
        return res.json();
      })
      .then((data) => {
        setContext(data);
        setError(null);
      })
      .catch((err) => {
        setError(err.message ?? 'Failed to load context');
        setContext(null);
      })
      .finally(() => setLoading(false));
  }, []);

  return { context, loading, error };
}
