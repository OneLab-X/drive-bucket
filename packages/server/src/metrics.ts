import type { DriveAdapter } from '@drivebucket/core';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;
  httpRequests: Counter<'method' | 'route' | 'status'>;
  httpDuration: Histogram<'method' | 'route'>;
  driveCalls: Counter<'op' | 'outcome'>;
  driveDuration: Histogram<'op'>;
  driveRetries: Counter<'op' | 'reason'>;
  resizeCache: Counter<'result'>;
  resizeDuration: Histogram;
}

/** Own registry (not the prom-client global) so several servers can coexist in one process. */
export function createMetrics(opts: { defaultMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();
  if (opts.defaultMetrics !== false) collectDefaultMetrics({ register: registry, prefix: 'drivebucket_' });
  const m: Metrics = {
    registry,
    httpRequests: new Counter({
      name: 'drivebucket_http_requests_total',
      help: 'HTTP requests by method, route and status',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'drivebucket_http_request_duration_seconds',
      help: 'HTTP request latency',
      labelNames: ['method', 'route'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [registry],
    }),
    driveCalls: new Counter({
      name: 'drivebucket_drive_api_calls_total',
      help: 'Drive API HTTP attempts by operation and outcome (each retry counts)',
      labelNames: ['op', 'outcome'],
      registers: [registry],
    }),
    driveDuration: new Histogram({
      name: 'drivebucket_drive_api_call_duration_seconds',
      help: 'Drive API call latency',
      labelNames: ['op'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers: [registry],
    }),
    driveRetries: new Counter({
      name: 'drivebucket_drive_api_retries_total',
      help: 'Drive API retries by operation and error reason',
      labelNames: ['op', 'reason'],
      registers: [registry],
    }),
    resizeCache: new Counter({
      name: 'drivebucket_resize_cache_requests_total',
      help: 'Resize cache lookups. Hit ratio = hit / (hit + miss)',
      labelNames: ['result'],
      registers: [registry],
    }),
    resizeDuration: new Histogram({
      name: 'drivebucket_resize_duration_seconds',
      help: 'Time spent in sharp per variant',
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [registry],
    }),
  };
  return m;
}

/** Wire Drive call/retry events from an adapter into the metrics. */
export function observeAdapter(adapter: DriveAdapter, m: Metrics): () => void {
  return adapter.observe({
    onCall: (e) => {
      m.driveCalls.inc({ op: e.op, outcome: e.ok ? 'ok' : `error_${e.status ?? 'network'}` });
      m.driveDuration.observe({ op: e.op }, e.durationMs / 1000);
    },
    onRetry: (e) => m.driveRetries.inc({ op: e.op, reason: e.reason ?? 'unknown' }),
  });
}
