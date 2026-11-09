import type { ReactNode } from 'react';

export const metadata = { title: 'drivebucket photos', description: 'Upload photos to Google Drive' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#fafafa', color: '#111' }}>{children}</body>
    </html>
  );
}
