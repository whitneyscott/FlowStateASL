import { Routes, Route, Navigate } from 'react-router-dom';
import { useLtiContext } from './hooks/useLtiContext';
import { BridgeLog } from './components/BridgeLog';
import { ToolSelector } from './components/ToolSelector';
import FlashcardsPage from './pages/FlashcardsPage';
import TimerPage from './pages/TimerPage';
import TeacherConfigPage from './pages/TeacherConfigPage';

export default function AppRouter() {
  const { context, loading, error } = useLtiContext();

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100 p-4">
        <BridgeLog context={null} loading={true} error={null} />
        <p className="text-gray-600">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center bg-gray-100 p-4">
        <BridgeLog context={null} loading={false} error={error} />
        <p className="text-red-600 mt-4">{error}</p>
      </div>
    );
  }

  if (!context) {
    return (
      <div className="min-h-screen flex flex-col items-center bg-gray-100 p-4">
        <BridgeLog context={null} loading={false} error={null} />
        <p className="text-gray-600 mt-4">Launch from Canvas LTI to continue.</p>
      </div>
    );
  }

  if (context.toolType === 'flashcards') {
    return (
      <div className="min-h-screen flex flex-col bg-zinc-900">
        <div className="w-full max-w-4xl mx-auto px-4 py-4">
          <ToolSelector context={context} currentTool="flashcards" />
          <BridgeLog context={context} loading={false} error={null} />
        </div>
        <Routes>
          <Route path="/flashcards" element={<FlashcardsPage />} />
          <Route path="*" element={<Navigate to="/flashcards" replace />} />
        </Routes>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <div className="w-full max-w-4xl mx-auto px-4">
        <BridgeLog context={context} loading={false} error={null} />
      </div>
      <Routes>
        <Route path="/prompter" element={<TimerPage />} />
        <Route path="/config" element={<TeacherConfigPage />} />
        <Route path="*" element={<Navigate to="/prompter" replace />} />
      </Routes>
    </div>
  );
}
