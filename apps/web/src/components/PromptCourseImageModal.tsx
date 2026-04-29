import { useCallback, useEffect, useState } from 'react';
import {
  browseCourseFiles,
  coursePromptImageViewUrl,
  getSignedCourseImageViewPath,
  uploadCoursePromptImage,
} from '../api/prompt.api';
import { appendBridgeLog } from '../utils/bridge-log';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Root-relative `/api/prompt/course-files/:id/view` URL for Quill / saved HTML (host-agnostic). */
  onInserted: (imageUrl: string) => void;
};

export function PromptCourseImageModal({ open, onClose, onInserted }: Props) {
  const [tab, setTab] = useState<'upload' | 'pick'>('upload');
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [folderName, setFolderName] = useState('');
  const [parentFolderId, setParentFolderId] = useState<string | null>(null);
  const [subfolders, setSubfolders] = useState<Array<{ id: string; name: string }>>([]);
  const [imageFiles, setImageFiles] = useState<
    Array<{ id: string; display_name: string; content_type: string; size: number }>
  >([]);
  const [totalFilesInFolder, setTotalFilesInFolder] = useState(0);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const loadBrowse = useCallback(async (targetFolderId: string | null) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const out = await browseCourseFiles(targetFolderId);
      appendBridgeLog('prompt-image-debug', 'browseCourseFiles loaded', {
        targetFolderId: targetFolderId ?? '(root)',
        folderId: out.folder.id,
        folderName: out.folder.name,
        imageCount: out.imageFiles.length,
        totalFilesInFolder: out.totalFilesInFolder,
      });
      setFolderName(out.folder.name);
      setParentFolderId(out.folder.parentFolderId);
      setSubfolders(out.subfolders);
      setImageFiles(out.imageFiles);
      setTotalFilesInFolder(out.totalFilesInFolder);
    } catch (e) {
      appendBridgeLog('prompt-image-debug', 'browseCourseFiles failed', {
        targetFolderId: targetFolderId ?? '(root)',
        error: e instanceof Error ? e.message : String(e),
      });
      setBrowseError(e instanceof Error ? e.message : String(e));
      setSubfolders([]);
      setImageFiles([]);
      setTotalFilesInFolder(0);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setTab('upload');
    setUploadError(null);
    setBrowseError(null);
    void loadBrowse(null);
  }, [open, loadBrowse]);

  const enterFolder = (id: string) => {
    void loadBrowse(id);
  };

  const goUp = () => {
    if (parentFolderId) void loadBrowse(parentFolderId);
  };

  const goRoot = () => {
    void loadBrowse(null);
  };

  const pickFile = async (id: string) => {
    try {
      appendBridgeLog('prompt-image-debug', 'pickFile started', { fileId: id, folderName });
      const { path } = await getSignedCourseImageViewPath(id);
      const normalized = coursePromptImageViewUrl(path);
      appendBridgeLog('prompt-image-debug', 'pickFile signed path resolved', {
        fileId: id,
        signedPath: path,
        normalizedPath: normalized,
      });
      onInserted(normalized);
      onClose();
    } catch (e) {
      appendBridgeLog('prompt-image-debug', 'pickFile failed', {
        fileId: id,
        error: e instanceof Error ? e.message : String(e),
      });
      setBrowseError(e instanceof Error ? e.message : String(e));
    }
  };

  const onUploadInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadBusy(true);
    setUploadError(null);
    try {
      appendBridgeLog('prompt-image-debug', 'uploadCoursePromptImage started', {
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
      });
      const { viewPath } = await uploadCoursePromptImage(file);
      const normalized = coursePromptImageViewUrl(viewPath);
      appendBridgeLog('prompt-image-debug', 'uploadCoursePromptImage success', {
        fileName: file.name,
        returnedViewPath: viewPath,
        normalizedPath: normalized,
      });
      onInserted(normalized);
      onClose();
    } catch (err) {
      appendBridgeLog('prompt-image-debug', 'uploadCoursePromptImage failed', {
        fileName: file.name,
        error: err instanceof Error ? err.message : String(err),
      });
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadBusy(false);
    }
  };

  const canGoUp = Boolean(parentFolderId);

  if (!open) return null;

  return (
    <div className="prompter-modal-overlay" style={{ zIndex: 10040 }}>
      <div
        className="prompter-modal prompter-modal-file-explorer"
        role="dialog"
        aria-labelledby="prompt-img-modal-title"
      >
        <h3 id="prompt-img-modal-title">Insert image</h3>
        <p className="prompter-hint prompter-file-explorer-intro">
          Upload a new file or browse this course&apos;s Canvas Files. Folders match Canvas; only image files are listed
          for insertion.
        </p>
        <div className="prompter-file-explorer-tabs">
          <button
            type="button"
            className={tab === 'upload' ? 'prompter-btn-start-sm' : 'prompter-btn-secondary'}
            onClick={() => setTab('upload')}
          >
            Upload new
          </button>
          <button
            type="button"
            className={tab === 'pick' ? 'prompter-btn-start-sm' : 'prompter-btn-secondary'}
            onClick={() => setTab('pick')}
          >
            Course Files
          </button>
        </div>

        {tab === 'upload' ? (
          <div className="prompter-file-explorer-upload">
            <label className="prompter-settings-label prompter-settings-label-block">
              <input
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                disabled={uploadBusy}
                onChange={onUploadInput}
              />
            </label>
            {uploadBusy ? <p className="prompter-hint">Uploading…</p> : null}
            {uploadError ? <p className="prompter-error-message">{uploadError}</p> : null}
          </div>
        ) : (
          <div className="prompter-file-explorer-body">
            <div className="prompter-file-explorer-toolbar">
              <button type="button" className="prompter-btn-secondary prompter-file-explorer-toolbar-btn" onClick={goRoot}>
                Course files
              </button>
              <button
                type="button"
                className="prompter-btn-secondary prompter-file-explorer-toolbar-btn"
                disabled={!canGoUp || browseLoading}
                onClick={goUp}
              >
                Up
              </button>
              <span className="prompter-file-explorer-crumbs" title={folderName}>
                {folderName || '…'}
              </span>
            </div>

            {browseLoading ? <p className="prompter-hint">Loading folder…</p> : null}
            {browseError ? <p className="prompter-error-message">{browseError}</p> : null}

            {!browseLoading && !browseError ? (
              <>
                <div className="prompter-file-explorer-split">
                  <div className="prompter-file-explorer-pane prompter-file-explorer-pane-folders">
                    <div className="prompter-file-explorer-pane-title">Folders</div>
                    {subfolders.length === 0 ? (
                      <p className="prompter-hint prompter-file-explorer-empty">No subfolders</p>
                    ) : (
                      <ul className="prompter-file-explorer-folder-list">
                        {subfolders.map((sf) => (
                          <li key={sf.id}>
                            <button
                              type="button"
                              className="prompter-file-explorer-folder-row"
                              onClick={() => enterFolder(sf.id)}
                            >
                              <span className="prompter-file-explorer-folder-icon" aria-hidden>
                                📁
                              </span>
                              <span className="prompter-file-explorer-folder-name">{sf.name}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="prompter-file-explorer-pane prompter-file-explorer-pane-files">
                    <div className="prompter-file-explorer-pane-title">
                      Images here
                      {totalFilesInFolder > 0 ? (
                        <span className="prompter-file-explorer-count">
                          {' '}
                          ({imageFiles.length} image{imageFiles.length === 1 ? '' : 's'} of {totalFilesInFolder} file
                          {totalFilesInFolder === 1 ? '' : 's'})
                        </span>
                      ) : null}
                    </div>
                    {imageFiles.length === 0 ? (
                      <p className="prompter-hint prompter-file-explorer-empty">
                        No images in this folder. Open a subfolder or upload. Non-image files are hidden.
                      </p>
                    ) : (
                      <ul className="prompter-file-explorer-file-list">
                        {imageFiles.map((f) => (
                          <li key={f.id}>
                            <button
                              type="button"
                              className="prompter-file-explorer-file-row"
                              onClick={() => pickFile(f.id)}
                            >
                              <span className="prompter-file-explorer-file-icon" aria-hidden>
                                🖼
                              </span>
                              <span className="prompter-file-explorer-file-name">{f.display_name}</span>
                              <span className="prompter-file-explorer-file-meta">
                                {(f.size / 1024).toFixed(0)} KB · {f.content_type || 'image'}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        )}

        <div className="prompter-modal-actions">
          <button type="button" className="prompter-btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
