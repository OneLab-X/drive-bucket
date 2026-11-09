import { BUCKET, getAdapter } from '@/lib/drive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Newest 60 photos. Drive listing scans the bucket, so cache this in a real app. */
export async function GET() {
  const adapter = await getAdapter();
  const res = await adapter.list(BUCKET, { prefix: 'photos/', maxKeys: 1000 });
  const photos = res.objects
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
    .slice(0, 60)
    .map((o) => ({ key: o.key, size: o.size, lastModified: o.lastModified.toISOString() }));
  return Response.json({ photos }, { headers: { 'cache-control': 'no-store' } });
}
