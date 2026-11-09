'use client';

import { uploadFile, UploadError } from '@drivebucket/next/client';
import { useCallback, useEffect, useState } from 'react';

interface Photo {
  key: string;
  size: number;
  lastModified: string;
}

const PROXY = process.env.NEXT_PUBLIC_DRIVEBUCKET_PROXY_URL?.replace(/\/$/, '');
const BUCKET = 'photos';

/** Through drivebucket-server + CDN when configured (resized variants), else this app's route. */
function src(key: string, width?: number): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  if (PROXY) return `${PROXY}/${BUCKET}/${path}${width ? `?w=${width}&format=webp` : ''}`;
  return `/api/files/${path}`;
}

export default function Page() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/photos');
    if (res.ok) setPhotos(((await res.json()) as { photos: Photo[] }).photos);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    try {
      for (const file of Array.from(files)) {
        setProgress(0);
        await uploadFile(file, {
          // Downscale on the device: faster uploads, less Drive quota.
          resize: { maxEdge: 2048, quality: 0.82 },
          onProgress: (loaded, total) => setProgress(total ? loaded / total : 0),
        });
      }
      await refresh();
    } catch (e) {
      setError(e instanceof UploadError ? `${e.code}: ${e.message}` : String(e));
    } finally {
      setProgress(null);
    }
  }

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 24 }}>Photos on Google Drive</h1>
      <label
        style={{ display: 'block', border: '2px dashed #bbb', borderRadius: 12, padding: 32, textAlign: 'center', cursor: 'pointer', background: '#fff' }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void onFiles(e.dataTransfer.files);
        }}
      >
        <input type="file" accept="image/*" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
        {progress === null ? 'Drop photos here or click to choose' : `Uploading… ${Math.round(progress * 100)}%`}
      </label>
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginTop: 24 }}>
        {photos.map((p) => (
          <li key={p.key}>
            <a href={src(p.key)} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src(p.key, 640)}
                srcSet={PROXY ? `${src(p.key, 320)} 320w, ${src(p.key, 640)} 640w` : undefined}
                sizes="200px"
                alt=""
                loading="lazy"
                style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8, background: '#eee' }}
              />
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
