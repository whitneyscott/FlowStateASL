import { Routes, Route, Navigate } from 'react-router-dom';
import { useLtiContext } from './hooks/useLtiContext';
import FlashcardsPage from './pages/FlashcardsPage';
import TimerPage from './pages/TimerPage';
import TeacherConfigPage from './pages/TeacherConfigPage';

export default function AppRouter() {
  const { context, loading, error } = useLtiContext();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <p className="text-red-600">{error}</p>
      </div>
    );
  }

  if (!context) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <p className="text-gray-600">Launch from Canvas LTI to continue.</p>
      </div>
    );
  }

  if (context.toolType === 'flashcards') {
    return (
      <Routes>
        <Route path="/flashcards" element={<FlashcardsPage />} />
        <Route path="*" element={<Navigate to="/flashcards" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/prompter" element={<TimerPage />} />
      <Route path="/config" element={<TeacherConfigPage />} />
      <Route path="*" element={<Navigate to="/prompter" replace />} />
    </Routes>
  );
}
