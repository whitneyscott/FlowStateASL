import { useCallback, useMemo, useState, type ReactNode } from 'react';

const CHROME_CAPTIONS_URL = 'chrome://settings/captions';

const PLAY_STORE_LIVE_TRANSCRIBE =
  'https://play.google.com/store/apps/details?id=com.google.audio.hearing.visualization.accessibility.scribe';

export type CaptionsAccessibilityPanelProps = {
  /** When set, enables built-in live captions. Omit or pass null until Deepgram is integrated. */
  onStart?: (() => void) | null;
};

export type CaptionsPlatform =
  | 'ios'
  | 'android'
  | 'macos'
  | 'windows'
  | 'chrome-desktop'
  | 'fallback';

/** Detection priority: mobile OS → desktop OS → Chrome (non-Edge). */
export function detectCaptionsPlatform(): CaptionsPlatform {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const isIPadTouchMac = platform === 'MacIntel' && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
  const isIOS = /iPhone|iPod|iPad/i.test(ua) || isIPadTouchMac;
  if (isIOS) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Mac/i.test(platform) && !isIOS) return 'macos';
  if (/Win/i.test(platform)) return 'windows';
  if (/Chrome\//i.test(ua) && !/Edg/i.test(ua) && !/Android/i.test(ua) && !isIOS) return 'chrome-desktop';
  return 'fallback';
}

function KbdShortcut({ keys }: { keys: string[] }) {
  return (
    <span className="prompter-captions-kbd-row" aria-label={keys.join(' + ')}>
      {keys.map((k) => (
        <kbd key={k} className="prompter-captions-kbd">
          {k}
        </kbd>
      ))}
    </span>
  );
}

function IOSContent() {
  return (
    <div className="prompter-captions-option-body">
      <p className="prompter-captions-option-desc">
        Live Captions is built into iOS 16+ and iPadOS 16+. It captions any audio playing on your device.
      </p>
      <p className="prompter-captions-muted prompter-captions-version-note">Requires iOS 16 or iPadOS 16 or later.</p>
      <ol className="prompter-captions-steps">
        <li>Open the Settings app</li>
        <li>Tap Accessibility</li>
        <li>Tap Live Captions</li>
        <li>Toggle Live Captions on</li>
      </ol>
      <p className="prompter-captions-note">
        Live Captions on iPhone works in any app and any browser — no additional setup required once enabled.
      </p>
      <p>
        <a href="app-settings:" className="prompter-captions-deep-link">
          Open Accessibility Settings
        </a>
      </p>
      <p className="prompter-captions-muted">
        If the link doesn&apos;t open Settings, search &quot;Live Captions&quot; in your Settings app.
      </p>
    </div>
  );
}

function MacOSContent() {
  return (
    <div className="prompter-captions-option-body">
      <p className="prompter-captions-option-desc">
        Live Captions is built into macOS Ventura (13.0) and later.
      </p>
      <p className="prompter-captions-kbd-label">
        Keyboard shortcut: <KbdShortcut keys={['Option', 'Command', 'F5']} />
      </p>
      <ol className="prompter-captions-steps">
        <li>Open System Settings</li>
        <li>Click Accessibility</li>
        <li>Click Live Captions</li>
        <li>Toggle Live Captions on</li>
      </ol>
      <p className="prompter-captions-note">Works in Safari, Chrome, Firefox, and any other app on your Mac.</p>
      <p className="prompter-captions-muted">
        Requires macOS Ventura or later. If you don&apos;t see it in Accessibility settings, check for a macOS update.
      </p>
    </div>
  );
}

function AndroidPrimaryContent() {
  return (
    <div className="prompter-captions-option-body">
      <p className="prompter-captions-option-desc">
        Free app developed with Gallaudet University. Real-time captions using your phone&apos;s microphone.
      </p>
      <p>
        <a
          href={PLAY_STORE_LIVE_TRANSCRIBE}
          target="_blank"
          rel="noopener noreferrer"
          className="prompter-captions-deep-link"
        >
          Get Live Transcribe on Google Play
        </a>
      </p>
      <div className="prompter-captions-android-secondary">
        <h4 className="prompter-captions-subheading">Android Live Captions (Android 10+)</h4>
        <ol className="prompter-captions-steps">
          <li>Open Settings</li>
          <li>Tap Accessibility</li>
          <li>Tap Live Captions</li>
          <li>Toggle on</li>
        </ol>
        <p className="prompter-captions-muted">
          Available on Pixel and most Android 10+ devices. May not be available on all manufacturers.
        </p>
      </div>
    </div>
  );
}

function AndroidOtherContent() {
  return (
    <div className="prompter-captions-option-body">
      <h4 className="prompter-captions-subheading">Live Transcribe</h4>
      <p className="prompter-captions-option-desc">
        Free app developed with Gallaudet University. Real-time captions using your phone&apos;s microphone.
      </p>
      <p>
        <a
          href={PLAY_STORE_LIVE_TRANSCRIBE}
          target="_blank"
          rel="noopener noreferrer"
          className="prompter-captions-deep-link"
        >
          Get Live Transcribe on Google Play
        </a>
      </p>
      <h4 className="prompter-captions-subheading">Android Live Captions (Android 10+)</h4>
      <ol className="prompter-captions-steps">
        <li>Open Settings</li>
        <li>Tap Accessibility</li>
        <li>Tap Live Captions</li>
        <li>Toggle on</li>
      </ol>
      <p className="prompter-captions-muted">
        Available on Pixel and most Android 10+ devices. May not be available on all manufacturers.
      </p>
    </div>
  );
}

function WindowsContent() {
  return (
    <div className="prompter-captions-option-body">
      <p className="prompter-captions-option-desc">
        Windows can show system captions for audio playing on your PC.
      </p>
      <p className="prompter-captions-kbd-label">
        Keyboard shortcut: <KbdShortcut keys={['Win', 'Ctrl', 'L']} />
      </p>
      <p>
        <a href="ms-settings:easeofaccess-captions" className="prompter-captions-deep-link">
          Open caption settings
        </a>
      </p>
      <p className="prompter-captions-muted">
        Works in Edge. If nothing opens, search &quot;Live Captions&quot; in Windows Settings. This link may not work in
        Chrome or Firefox.
      </p>
    </div>
  );
}

function ChromeDesktopContent() {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(CHROME_CAPTIONS_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div className="prompter-captions-option-body">
      <div className="prompter-captions-chrome-url-row">
        <code className="prompter-captions-code-block">{CHROME_CAPTIONS_URL}</code>
        <button type="button" className="prompter-captions-copy-btn" onClick={onCopy}>
          {copied ? 'Copied!' : 'Copy to clipboard'}
        </button>
      </div>
      <p className="prompter-captions-option-desc prompter-captions-chrome-instruction">
        Paste this into your Chrome address bar, then enable Live Captions.
      </p>
    </div>
  );
}

type OptionId = 'ios' | 'macos' | 'android' | 'windows' | 'chrome';

const OPTION_SUMMARY: Record<OptionId, string> = {
  ios: 'iPhone/iPad Live Captions',
  macos: 'Mac Live Captions',
  android: 'Android (Live Transcribe & Live Captions)',
  windows: 'Windows Live Captions',
  chrome: 'Chrome Live Captions',
};

function OptionDetails({ id, children }: { id: OptionId; children: ReactNode }) {
  return (
    <details className="prompter-captions-details">
      <summary className="prompter-captions-summary">{OPTION_SUMMARY[id]}</summary>
      {children}
    </details>
  );
}

/**
 * First-class accessibility panel for teachers grading submissions: built-in path (future Deepgram)
 * plus OS/browser-specific steps for system live captions.
 */
export function CaptionsAccessibilityPanel({ onStart }: CaptionsAccessibilityPanelProps) {
  const platform = useMemo(() => detectCaptionsPlatform(), []);

  const builtInEnabled = typeof onStart === 'function';
  const primaryIds = useMemo((): Set<OptionId> => {
    if (platform === 'ios') return new Set(['ios']);
    if (platform === 'android') return new Set(['android']);
    if (platform === 'macos') return new Set(['macos']);
    if (platform === 'windows') return new Set(['windows']);
    if (platform === 'chrome-desktop') return new Set(['chrome']);
    return new Set();
  }, [platform]);

  const otherIds = useMemo(() => {
    const all: OptionId[] = ['ios', 'macos', 'android', 'windows', 'chrome'];
    return all.filter((id) => !primaryIds.has(id));
  }, [primaryIds]);

  const renderOptionBody = (id: OptionId) => {
    switch (id) {
      case 'ios':
        return <IOSContent />;
      case 'macos':
        return <MacOSContent />;
      case 'android':
        return <AndroidOtherContent />;
      case 'windows':
        return <WindowsContent />;
      case 'chrome':
        return <ChromeDesktopContent />;
      default:
        return null;
    }
  };

  return (
    <section className="prompter-captions-access-panel" aria-labelledby="prompter-captions-built-in-heading">
      <div className="prompter-captions-access-section prompter-captions-access-section--primary">
        <h3 id="prompter-captions-built-in-heading" className="prompter-captions-section-title">
          Built-in captions
        </h3>
        <div className="prompter-captions-built-in-row">
          <div className="prompter-captions-built-in-copy">
            <div className="prompter-captions-built-in-label">Built-in live captions</div>
            <p className="prompter-captions-built-in-sublabel">Automatic real-time captions — no setup required.</p>
          </div>
          <div className="prompter-captions-built-in-action">
            {/* TODO: wire onStart to Deepgram streaming handler (see CaptionsAccessibilityPanel props) */}
            <button
              type="button"
              className="prompter-captions-start-btn"
              disabled={!builtInEnabled}
              onClick={builtInEnabled && onStart ? () => onStart() : undefined}
            >
              Start live captions
            </button>
            {!builtInEnabled ? (
              <span className="prompter-captions-coming-soon-badge" aria-label="Coming soon">
                Coming soon
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="prompter-captions-access-section">
        <h3 className="prompter-captions-section-title">Enable captions manually</h3>

        {platform === 'fallback' ? (
          <div className="prompter-captions-fallback-stack">
            {(['ios', 'macos', 'android', 'windows', 'chrome'] as OptionId[]).map((id) => (
              <OptionDetails key={id} id={id}>
                {renderOptionBody(id)}
              </OptionDetails>
            ))}
          </div>
        ) : (
          <>
            <div className="prompter-captions-primary-option">
              {platform === 'ios' ? (
                <>
                  <h4 className="prompter-captions-option-title">{OPTION_SUMMARY.ios}</h4>
                  <IOSContent />
                </>
              ) : null}
              {platform === 'android' ? (
                <>
                  <h4 className="prompter-captions-option-title">Live Transcribe</h4>
                  <AndroidPrimaryContent />
                </>
              ) : null}
              {platform === 'macos' ? (
                <>
                  <h4 className="prompter-captions-option-title">{OPTION_SUMMARY.macos}</h4>
                  <MacOSContent />
                </>
              ) : null}
              {platform === 'windows' ? (
                <>
                  <h4 className="prompter-captions-option-title">{OPTION_SUMMARY.windows}</h4>
                  <WindowsContent />
                </>
              ) : null}
              {platform === 'chrome-desktop' ? (
                <>
                  <h4 className="prompter-captions-option-title">{OPTION_SUMMARY.chrome}</h4>
                  <ChromeDesktopContent />
                </>
              ) : null}
            </div>

            {otherIds.length > 0 ? (
              <details className="prompter-captions-details prompter-captions-details--other">
                <summary className="prompter-captions-summary">Other options</summary>
                <div className="prompter-captions-other-stack">
                  {otherIds.map((id) => (
                    <OptionDetails key={id} id={id}>
                      {renderOptionBody(id)}
                    </OptionDetails>
                  ))}
                </div>
              </details>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
