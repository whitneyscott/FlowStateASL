import { useCallback, useEffect, useState } from 'react';
import {
  coursePromptImageViewUrl,
  getCourseFilesRootFolder,
  listCourseImageFiles,
  uploadCoursePromptImage,
} from '../api/prompt.api';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Absolute or root-relative URL suitable for Quill `insertEmbed` / `<img src>`. */
  onInserted: (imageUrl: string) => void;
};

export function PromptCourseImageModal({ open, onClose, onInserted }: Props) {
  const [tab, setTab] = useState<'upload' | 'pick'>('upload');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [files, setFiles] = useState<
    Array<{ id: string; display_name: string; content_type: string; size: number }>
  >([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const loadList = useCallback(async (fid: string, p: number) => {
    setListLoading(true);
    setListError(null);
    try {
      const out = await listCourseImageFiles(fid, p);
      setFolderId(out.folderId);
      setPage(out.page);
      setFiles(out.files);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
      setFiles([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setTab('upload');
    setUploadError(null);
    setListError(null);
    setPage(1);
    setFiles([]);
    let cancelled = false;
    (async () => {
      try {
        const root = await getCourseFilesRootFolder();
        if (cancelled) return;
        await loadList(root.folderId, 1);
      } catch (e) {
        if (!cancelled) {
          setListError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, loadList]);

  const pickFile = (id: string) => {
    const path = `/api/prompt/course-files/${id}/view`;
    onInserted(coursePromptImageViewUrl(path));
    onClose();
  };

  const onUploadInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadBusy(true);
    setUploadError(null);
    try {
      const { viewPath } = await uploadCoursePromptImage(file);
      onInserted(coursePromptImageViewUrl(viewPath));
      onClose();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="prompter-modal-overlay" style={{ zIndex: 10040 }}>
      <div className="prompter-modal prompter-modal-wide" role="dialog" aria-labelledby="prompt-img-modal-title">
        <h3 id="prompt-img-modal-title">Insert image</h3>
        <p className="prompter-hint">
          Images are stored in this course&apos;s Canvas Files area. Prompt HTML only references them (no embedded
          binary).
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
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
            Choose from course files
          </button>
        </div>

        {tab === 'upload' ? (
          <div>
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
          <div>
            {listLoading ? <p className="prompter-hint">Loading files…</p> : null}
            {listError ? <p className="prompter-error-message">{listError}</p> : null}
            {!listLoading && !listError && files.length === 0 ? (
              <p className="prompter-hint">No image files in this folder page. Upload one first or use another folder in Canvas.</p>
            ) : null}
            <ul className="prompter-course-file-pick-list" style={{ listStyle: 'none', padding: 0, margin: '8px 0', maxHeight: 240, overflow: 'auto' }}>
              {files.map((f) => (
                <li key={f.id}>
                  <button type="button" className="prompter-btn-secondary" style={{ width: '100%', textAlign: 'left', marginBottom: 6 }} onClick={() => pickFile(f.id)}>
                    {f.display_name}
                    <span style={{ color: '#666', fontSize: 12, marginLeft: 8 }}>
                      {(f.size / 1024).toFixed(0)} KB · {f.content_type}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                className="prompter-btn-secondary"
                disabled={listLoading || page <= 1}
                onClick={() => folderId && loadList(folderId, page - 1)}
              >
                Previous page
              </button>
              <span className="prompter-hint">Page {page}</span>
              <button
                type="button"
                className="prompter-btn-secondary"
                disabled={listLoading || files.length < 1}
                onClick={() => folderId && loadList(folderId, page + 1)}
              >
                Next page
              </button>
            </div>
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
