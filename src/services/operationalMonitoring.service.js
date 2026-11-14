import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createAuditLog } from './audit.service.js';

const WINDOW_MINUTES = 15;
const SLOW_REQUEST_MS = 2_000;
const MAX_RECENT = 80;
const MAX_GATES = 2_048;
const MINUTE_MS = 60_000;
const FINGERPRINT_SALT = randomBytes(16).toString('hex');
const buckets = new Map();
const recentIncidents = [];
const writeGates = new Map();

const routeModule = (path) => {
  const first = String(path || '').split('?')[0].split('/').filter(Boolean);
  if (first[0] !== 'api') return null;
  const value = String(first[1] || 'other');
  return /^[a-z][a-z0-9-]{0,39}$/.test(value) ? value : 'other';
};

const freshStats = (minute) => ({
  minute,
  total: 0,
  succeeded: 0,
  clientErrors: 0,
  unauthenticated: 0,
  forbidden: 0,
  serverErrors: 0,
  slowRequests: 0,
  totalDurationMs: 0,
});

const prune = (now) => {
  const currentMinute = Math.floor(now / MINUTE_MS);
  for (const minute of buckets.keys()) {
    if (minute < currentMinute - (WINDOW_MINUTES - 1)) buckets.delete(minute);
  }
  while (recentIncidents.length && recentIncidents[0].timestamp < now - WINDOW_MINUTES * MINUTE_MS) {
    recentIncidents.shift();
  }
  for (const [fingerprint, until] of writeGates) {
    if (until <= now) writeGates.delete(fingerprint);
  }
  if (writeGates.size > MAX_GATES) {
    for (const fingerprint of writeGates.keys()) {
      writeGates.delete(fingerprint);
      if (writeGates.size <= MAX_GATES / 2) break;
    }
  }
};

const incidentKind = (statusCode) => (
  statusCode >= 500 ? 'server_error'
    : statusCode === 403 ? 'access_denied'
      : statusCode === 401 ? 'authentication_failed'
        : null
);

export const recordOperationalResponse = ({
  timestamp = Date.now(), statusCode, durationMs = 0, module = 'other',
  method = 'GET', requestId = randomUUID(),
}) => {
  prune(timestamp);
  const minute = Math.floor(timestamp / MINUTE_MS);
  const bucket = buckets.get(minute) || freshStats(minute);
  bucket.total += 1;
  bucket.totalDurationMs += Math.max(0, durationMs);
  if (statusCode < 400) bucket.succeeded += 1;
  if (statusCode >= 400 && statusCode < 500) bucket.clientErrors += 1;
  if (statusCode === 401) bucket.unauthenticated += 1;
  if (statusCode === 403) bucket.forbidden += 1;
  if (statusCode >= 500) bucket.serverErrors += 1;
  if (durationMs >= SLOW_REQUEST_MS) bucket.slowRequests += 1;
  buckets.set(minute, bucket);

  const kind = incidentKind(statusCode);
  if (kind) {
    recentIncidents.push({
      timestamp, statusCode, kind, module, method, requestId,
      durationMs: Math.round(durationMs),
    });
    if (recentIncidents.length > MAX_RECENT) recentIncidents.shift();
  }
  return kind;
};

/** Last-15-minute metrics are exact for this process only; they reset on restart. */
export const getOperationalSnapshot = (now = Date.now()) => {
  prune(now);
  const counts = freshStats(null);
  for (const bucket of buckets.values()) {
    for (const key of Object.keys(counts)) {
      if (key !== 'minute') counts[key] += bucket[key];
    }
  }
  const { minute: _unused, totalDurationMs, ...metrics } = counts;
  return {
    windowMinutes: WINDOW_MINUTES,
    windowEndsAt: new Date(now).toISOString(),
    processScope: true,
    ...metrics,
    averageDurationMs: metrics.total ? Math.round(totalDurationMs / metrics.total) : 0,
    recentIncidents: recentIncidents.slice().reverse().map(({ timestamp, ...item }) => ({
      ...item, occurredAt: new Date(timestamp).toISOString(),
    })),
  };
};

/** Only one persisted audit event per minute per hashed origin/user/module/status. */
const shouldPersistEvent = ({ now, kind, module, fingerprint }) => {
  prune(now);
  if (kind === 'server_error') return true;
  const digest = createHash('sha256')
    .update(FINGERPRINT_SALT + String(fingerprint || '')).digest('hex').slice(0, 16);
  const key = `${kind}:${module}:${digest}`;
  if ((writeGates.get(key) || 0) > now) return false;
  writeGates.set(key, now + MINUTE_MS);
  return true;
};

export const createOperationalMonitoringMiddleware = ({
  saveAudit = createAuditLog,
  clock = Date.now,
} = {}) => (req, res, next) => {
  const module = routeModule(req.originalUrl || req.url);
  if (!module || module === 'health' || module === 'audit') return next();

  const requestId = randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  const startedAt = process.hrtime.bigint();

  res.once('finish', () => {
    const now = clock();
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const method = String(req.method || 'GET').toUpperCase();
    const kind = recordOperationalResponse({
      timestamp: now, statusCode: res.statusCode, durationMs: elapsed,
      module, method, requestId,
    });
    if (!kind) return;
    // Prevent unauthenticated request floods from overwhelming persistent logs.
    if (!shouldPersistEvent({
      now, kind, module,
      fingerprint: req.authUser?.id || req.ip || req.socket?.remoteAddress || 'unknown',
    })) return;

    // Never record request bodies, query strings, raw paths, cookies or headers.
    void Promise.resolve(saveAudit({
      user: req.authUser || null,
      action: kind,
      module,
      status: 'failed',
      description: kind === 'server_error'
        ? 'خطأ خادمي في معالجة الطلب'
        : kind === 'access_denied'
          ? 'محاولة وصول مرفوضة بالصلاحيات'
          : 'محاولة طلب دون جلسة دخول صالحة',
      metadata: {
        requestId, method, httpStatus: res.statusCode,
        durationMs: Math.round(elapsed), sampled: kind !== 'server_error',
      },
    })).catch(() => {});
  });
  next();
};

/** Test-only fixture reset; never exposed as an HTTP endpoint. */
export const resetOperationalMetricsForTests = () => {
  buckets.clear();
  recentIncidents.length = 0;
  writeGates.clear();
};
