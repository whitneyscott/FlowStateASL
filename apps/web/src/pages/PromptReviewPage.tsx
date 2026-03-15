import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

export default function PromptReviewPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const title = (searchParams.get('title') ?? '').trim();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  if (!token) {
    return (
      <div className="min-h-[400px] flex flex-col items-center justify-center p-6">
        <p className="text-red-600">Invalid or missing submission token.</p>
      </div>
    );
  }

  const videoUrl = `/api/prompt/submission/${encodeURIComponent(token)}`;

  return (
    <div className="min-h-[400px] flex flex-col items-center p-6">
      <h2 className="text-xl font-semibold mb-4">{title || 'ASL Video Submission'}</h2>
      <div className="w-full max-w-2xl relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100 rounded border border-gray-300">
            <p className="text-gray-600">Loading video...</p>
          </div>
        )}
        <video
          src={videoUrl}
          controls
          playsInline
          className="w-full rounded border border-gray-300 bg-black"
          onLoadedData={() => {
            setLoading(false);
            setError(false);
          }}
          onError={() => {
            setLoading(false);
            setError(true);
          }}
        />
        {error && (
          <p className="mt-2 text-red-600">
            Failed to load video. The submission may have expired.
          </p>
        )}
      </div>
    </div>
  );
}
