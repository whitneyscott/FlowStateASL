import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import type { LtiContext } from '@aslexpress/shared-types';
import { useLtiContext } from './hooks/useLtiContext';
import { AppBlockingLoader } from './components/AppBlockingLoader';
import { BridgeLog } from './components/BridgeLog';
import { SupportBridgeLauncher } from './components/SupportBridgeLauncher';
import { useAppMode } from './contexts/AppModeContext';
import FlashcardsPage from './pages/FlashcardsPage';
import TimerPage from './pages/TimerPage';
import TeacherConfigPage from './pages/TeacherConfigPage';
import TeacherViewerPage from './pages/TeacherViewerPage';
import PromptReviewPage from './pages/PromptReviewPage';

const TEACHER_ROLE_RE =
  /instructor|administrator|faculty|teacher|staff|contentdeveloper|teachingassistant|ta/i;

/**
 * Canvas often launches the prompter tool at `/prompter`. Students stay on the timer; instructors
 * should land on Prompt Settings (`/config`) so the Assignments card is available without a separate nav bar.
 */
function PrompterRoute({ context }: { context: LtiContext }) {
  const { search } = useLocation();
  if (TEACHER_ROLE_RE.test(context.roles || '')) {
    return <Navigate to={`/config${search}`} replace />;
  }
  return <TimerPage context={context} />;
}

export default function AppRouter() {
  const { context, loading, error } = useLtiContext();
  const { openModeModal, appMode } = useAppMode();
  const isTeacherRole = !!(context && TEACHER_ROLE_RE.test(context.roles || ''));
  /** One `useLtiContext` only: SupportBridgeLauncher must not call it (boot_nonce is single-use). */
  const showSupportBridgeButton = !loading && (!context || !isTeacherRole);

  if (loading) {
    return (
      <>
        <SupportBridgeLauncher showSupportButton={showSupportBridgeButton} />
        <AppBlockingLoader active message="Loading course…" />
        <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100 p-4" aria-hidden="true">
          <BridgeLog context={null} loading={true} error={null} />
        </div>
      </>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center bg-gray-100 p-4">
        <SupportBridgeLauncher showSupportButton={showSupportBridgeButton} />
        <BridgeLog context={null} loading={false} error={error} />
        <p className="text-red-600 mt-4">{error}</p>
      </div>
    );
  }

  if (!context) {
    return (
      <div className="min-h-screen flex flex-col items-center bg-gray-100 p-4">
        <SupportBridgeLauncher showSupportButton={showSupportBridgeButton} />
        <BridgeLog context={null} loading={false} error={null} />
        <p className="text-gray-600 mt-4">Launch from Canvas LTI to continue.</p>
      </div>
    );
  }

  if (context.toolType === 'flashcards') {
    return (
      <div className="min-h-screen flex flex-col bg-zinc-900">
        <SupportBridgeLauncher showSupportButton={showSupportBridgeButton} />
        {isTeacherRole && (
          <button
            type="button"
            className="app-mode-float-btn"
            onClick={openModeModal}
            title="Application mode (Demo / Developer / Production)"
          >
            Mode: {appMode}
          </button>
        )}
        <div className="w-full max-w-4xl mx-auto px-4 py-4">
          <BridgeLog context={context} loading={false} error={null} />
        </div>
        <Routes>
          <Route
            path="/flashcards"
            element={<FlashcardsPage context={context} />}
          />
          <Route path="*" element={<Navigate to="/flashcards" replace />} />
        </Routes>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <SupportBridgeLauncher showSupportButton={showSupportBridgeButton} />
      {isTeacherRole && (
        <button
          type="button"
          className="app-mode-float-btn"
          onClick={openModeModal}
          title="Application mode (Demo / Developer / Production)"
        >
          Mode: {appMode}
        </button>
      )}
      <div className="w-full max-w-4xl mx-auto px-4 py-4">
        <BridgeLog context={context} loading={false} error={null} />
      </div>
      <Routes>
        <Route path="/prompter" element={<PrompterRoute context={context} />} />
        <Route path="/config" element={<TeacherConfigPage context={context} />} />
        <Route path="/viewer" element={<TeacherViewerPage context={context} />} />
        <Route path="/prompt/review" element={<PromptReviewPage />} />
        <Route
          path="*"
          element={
            <Navigate
              to={context && TEACHER_ROLE_RE.test(context.roles || '') ? '/config' : '/prompter'}
              replace
            />
          }
        />
      </Routes>
    </div>
  );
}
