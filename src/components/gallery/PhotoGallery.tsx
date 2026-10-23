import { useEffect, useState, type ReactNode } from 'react';
import { useAppStore } from '@/stores/appStore';
import { PhotoService } from '@/services/photoService';

interface PhotoGalleryProps {
  emptyUploader: ReactNode;
  onClearAll: () => void;
  personOneName: string;
  personTwoName: string;
  firstMeetingDate: string;
  isDateReady: boolean;
  dateSyncError: string | null;
  onFirstMeetingDateChange: (value: string) => void;
}

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

function toDateInputValue(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function getDaysTogether(firstMeetingDate: string, today: Date): number | null {
  if (!firstMeetingDate) return null;
  const [year, month, day] = firstMeetingDate.split('-').map(Number);
  if (!year || !month || !day) return null;

  const firstDay = Date.UTC(year, month - 1, day);
  const currentDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const elapsedDays = Math.floor((currentDay - firstDay) / DAY_IN_MILLISECONDS);
  return elapsedDays < 0 ? null : elapsedDays + 1;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PhotoGallery({
  emptyUploader,
  onClearAll,
  personOneName,
  personTwoName,
  firstMeetingDate,
  isDateReady,
  dateSyncError,
  onFirstMeetingDateChange,
}: PhotoGalleryProps) {
  const { photos, selectPhoto, removePhoto } = useAppStore();
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState(() => new Date());
  const daysTogether = getDaysTogether(firstMeetingDate, today);
  const coupleNames = [personOneName.trim(), personTwoName.trim()].filter(Boolean).join('与') || '我们';

  useEffect(() => {
    const timer = window.setInterval(() => setToday(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`确定从相册中删除“${name}”吗？`)) return;
    const photo = photos.find((item) => item.id === id);
    try {
      await PhotoService.deleteFromDB(id);
      removePhoto(id);
      if (photo) PhotoService.releasePhoto(photo);
      setError(null);
    } catch {
      setError('删除失败，照片仍保留在本地相册中，请重试。');
    }
  };

  return (
    <main className="gallery-page">
      <section className="gallery-intro">
        <div className="gallery-intro__copy">
          <p className="eyebrow">{coupleNames} · 回忆相册</p>
          <h2 className="gallery-title">
            <span>独属于{coupleNames}的</span>
            <em>回忆相册</em>
          </h2>
          <p className={`gallery-description${photos.length === 0 ? ' gallery-description--poetic' : ''}`}>
            {photos.length === 0
              ? '一眼万年'
              : `我们已经珍藏了 ${photos.length} 张照片，点击任意照片即可放大细看。`}
          </p>
        </div>
        <div className="gallery-intro__aside">
          <section className="anniversary-card" aria-label="相识纪念日">
            <div className="anniversary-card__topline">
              <label htmlFor="first-meeting-date">我们的第一次相识</label>
              {firstMeetingDate && (
                <button type="button" onClick={() => onFirstMeetingDateChange('')} disabled={!isDateReady}>清除日期</button>
              )}
            </div>
            <div className="anniversary-card__date-field">
              <input
                id="first-meeting-date"
                className="anniversary-card__date"
                type="date"
                value={firstMeetingDate}
                max={toDateInputValue(today)}
                disabled={!isDateReady}
                onChange={(event) => onFirstMeetingDateChange(event.currentTarget.value)}
                aria-label="选择第一次相识的日期"
              />
              {!firstMeetingDate && (
                <span className="anniversary-card__date-placeholder" aria-hidden="true">
                  {isDateReady ? '点击此处选择相识日期' : '正在同步日期…'}
                </span>
              )}
            </div>
            <div className="anniversary-card__count" aria-live="polite">
              <strong>{daysTogether?.toLocaleString('zh-CN') ?? '待设置'}</strong>
              {daysTogether !== null && <span>天</span>}
              <small>{daysTogether === null ? '选择日期后自动计算并同步' : '从初见至今'}</small>
            </div>
            {dateSyncError && <small className="anniversary-card__error" role="status">{dateSyncError}</small>}
          </section>
          {photos.length > 0 && (
            <div className="gallery-actions">
              <span className="photo-count"><strong>{photos.length}</strong> 张回忆</span>
              <button className="text-button" onClick={onClearAll}>清空相册</button>
            </div>
          )}
        </div>
      </section>

      {error && <div className="gallery-error" role="alert">{error}</div>}

      {photos.length === 0 ? (
        <section className="empty-gallery">
          <div className="empty-gallery__halo" aria-hidden="true" />
          <div className="empty-gallery__icon" aria-hidden="true">♡</div>
          <h3>从第一张照片开始，珍藏我们的故事</h3>
          {emptyUploader}
          <span className="empty-gallery__formats">支持多种图片格式 · JPG、PNG、WebP 原样保存，其他格式自动转为 JPG</span>
        </section>
      ) : (
        <section className="photo-grid" aria-label="我的照片">
          {photos.map((photo, index) => (
            <article className="photo-tile" key={photo.id} style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}>
              <button
                className="photo-tile__open"
                onClick={() => selectPhoto(photo.id)}
                aria-label={`放大查看${photo.name}`}
              >
                <img
                  src={photo.thumbnail || photo.dataUrl}
                  alt={photo.name}
                  loading="lazy"
                  decoding="async"
                />
                <span className="photo-tile__zoom" aria-hidden="true">⌕</span>
              </button>
              <div className="photo-tile__caption">
                <div>
                  <strong title={photo.name}>{photo.name}</strong>
                  <span>{formatSize(photo.size)}</span>
                </div>
                <button
                  className="photo-tile__delete"
                  onClick={() => void handleDelete(photo.id, photo.name)}
                  aria-label={`删除${photo.name}`}
                  title="删除照片"
                >
                  ×
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
