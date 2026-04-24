import { useEffect, useState } from 'react';

function App() {
  const [url, setUrl] = useState('');
  const [details, setDetails] = useState(null);
  const [error, setError] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [downloadingKey, setDownloadingKey] = useState('');
  const [previewFailed, setPreviewFailed] = useState(false);
  const [activeMode, setActiveMode] = useState('video');

  useEffect(() => {
    setPreviewFailed(false);
    setActiveMode('video');
  }, [details?.previewUrl]);

  async function handleAnalyze(event) {
    event.preventDefault();
    setError('');

    if (!url.trim()) {
      setError('Paste a YouTube or Instagram link.');
      return;
    }

    setAnalyzing(true);
    setDetails(null);

    try {
      const response = await fetch('/api/info', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: url.trim() }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.message || 'Unable to load that link.');
      }

      setDetails(payload);
    } catch (requestError) {
      setError(getFriendlyErrorMessage(requestError));
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleDownload({ mode, quality, key }) {
    if (!details) {
      return;
    }

    setError('');
    setDownloadingKey(key);

    try {
      const params = new URLSearchParams({
        url: details.url,
        mode,
      });

      if (mode === 'video' && quality) {
        params.set('quality', quality);
      }

      const response = await fetch(`/api/download?${params.toString()}`);

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || 'Download failed.');
      }

      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const filename = extractFilename(
        response.headers.get('content-disposition'),
        details.title,
        mode,
      );

      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.click();
      window.URL.revokeObjectURL(objectUrl);
    } catch (requestError) {
      setError(getFriendlyErrorMessage(requestError));
    } finally {
      setDownloadingKey('');
    }
  }

  const isPortrait = Boolean(
    details?.previewHeight &&
    details?.previewWidth &&
    details.previewHeight > details.previewWidth,
  );

  const metaItems = details ? buildMetaItems(details) : [];

  return (
    <div className="dx-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="ambient ambient-three" />

      <main className="dx-page">
        <header className="topbar">
          <div className="brand-block">
            <span className="brand-mark">DX</span>
            <div>
              <p className="overline">DX Downloader</p>
              <h1>Paste link. Preview. Download.</h1>
            </div>
          </div>
          <span className="topbar-badge">Mobile ready</span>
        </header>

        <section className="glass-card composer-card">
          <form className="composer-form" onSubmit={handleAnalyze}>
            <input
              className="link-input"
              type="url"
              placeholder="Paste YouTube or Instagram link"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              autoComplete="off"
            />
            <button className="primary-button" type="submit" disabled={analyzing}>
              {analyzing ? 'Loading...' : 'Open'}
            </button>
          </form>
        </section>

        {error ? <div className="message error">{error}</div> : null}

        <section className="glass-card viewer-card">
          {analyzing ? (
            <div className="preview-skeleton" aria-hidden="true">
              <div className="skeleton-thumb" />
              <div className="skeleton-line large" />
              <div className="skeleton-line" />
            </div>
          ) : details ? (
            <>
              <div className="viewer-head">
                <div>
                  <span className="platform-pill">{details.platform}</span>
                  <h2>{details.title}</h2>
                </div>
                {details.duration ? (
                  <span className="duration-pill">{formatDuration(details.duration)}</span>
                ) : null}
              </div>

              <div className={`player-shell ${isPortrait ? 'portrait' : ''}`}>
                {details.previewUrl && !previewFailed ? (
                  <video
                    key={details.previewUrl}
                    className="preview-video"
                    controls
                    playsInline
                    preload="metadata"
                    poster={details.thumbnail || undefined}
                    onError={() => setPreviewFailed(true)}
                  >
                    <source
                      src={details.previewUrl}
                      type={details.previewMimeType || 'video/mp4'}
                    />
                  </video>
                ) : details.thumbnail ? (
                  <img src={details.thumbnail} alt={details.title} className="thumbnail" />
                ) : (
                  <div className="thumbnail-fallback">
                    <span>No preview</span>
                  </div>
                )}
              </div>

              {metaItems.length ? (
                <div className="meta-row">
                  {metaItems.map((item) => (
                    <span className="meta-pill" key={item.label}>
                      <strong>{item.label}</strong>
                      <span>{item.value}</span>
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="mode-switch">
                <button
                  className={activeMode === 'video' ? 'mode-button active' : 'mode-button'}
                  onClick={() => setActiveMode('video')}
                  type="button"
                >
                  Video
                </button>
                <button
                  className={activeMode === 'audio' ? 'mode-button active' : 'mode-button'}
                  onClick={() => setActiveMode('audio')}
                  type="button"
                >
                  Audio
                </button>
              </div>

              {activeMode === 'video' ? (
                <div className="download-grid">
                  {details.videoOptions?.length ? (
                    details.videoOptions.map((option) => {
                      const optionKey = `video-${option.key}`;

                      return (
                        <button
                          className="download-card"
                          key={option.key}
                          onClick={() =>
                            handleDownload({
                              mode: 'video',
                              quality: option.quality,
                              key: optionKey,
                            })
                          }
                          disabled={Boolean(downloadingKey)}
                          type="button"
                        >
                          <span className="download-tag">{option.label}</span>
                          <strong>{option.height}p</strong>
                          <span>
                            {downloadingKey === optionKey ? 'Preparing...' : 'Download MP4'}
                          </span>
                        </button>
                      );
                    })
                  ) : (
                    <button
                      className="download-card"
                      onClick={() =>
                        handleDownload({
                          mode: 'video',
                          quality: 'best',
                          key: 'video-best',
                        })
                      }
                      disabled={Boolean(downloadingKey)}
                      type="button"
                    >
                      <span className="download-tag">Video</span>
                      <strong>Best</strong>
                      <span>{downloadingKey === 'video-best' ? 'Preparing...' : 'Download MP4'}</span>
                    </button>
                  )}
                </div>
              ) : (
                <div className="download-grid">
                  <button
                    className="download-card"
                    onClick={() =>
                      handleDownload({
                        mode: 'audio',
                        key: 'audio-mp3',
                      })
                    }
                    disabled={Boolean(downloadingKey)}
                    type="button"
                  >
                    <span className="download-tag">Audio</span>
                    <strong>MP3</strong>
                    <span>{downloadingKey === 'audio-mp3' ? 'Preparing...' : 'Download MP3'}</span>
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">
              <h2>Ready</h2>
              <p>Paste a link to load the video preview and download options.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function buildMetaItems(details) {
  const items = [];

  if (details.uploader) {
    items.push({ label: 'By', value: details.uploader });
  }

  if (details.uploadDate) {
    items.push({ label: 'Date', value: details.uploadDate });
  }

  if (details.viewCount) {
    items.push({ label: 'Views', value: Number(details.viewCount).toLocaleString() });
  }

  return items;
}

function extractFilename(contentDisposition, title, mode) {
  if (contentDisposition) {
    const utfMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);

    if (utfMatch?.[1]) {
      return decodeURIComponent(utfMatch[1]);
    }

    const plainMatch = contentDisposition.match(/filename="([^"]+)"/i);

    if (plainMatch?.[1]) {
      return plainMatch[1];
    }
  }

  const safeTitle = (title || 'dx-download')
    .replace(/[\\/:*?"<>|]+/g, '')
    .trim()
    .slice(0, 120);

  if (mode === 'audio') {
    return `${safeTitle || 'dx-download'}.mp3`;
  }

  return `${safeTitle || 'dx-download'}.mp4`;
}

function formatDuration(totalSeconds) {
  const seconds = Number(totalSeconds);

  if (!Number.isFinite(seconds)) {
    return '';
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function getFriendlyErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error || '');

  if (error instanceof TypeError || message.toLowerCase().includes('failed to fetch')) {
    return 'DX could not reach the server. Refresh and try again.';
  }

  return message || 'Something went wrong.';
}

export default App;
