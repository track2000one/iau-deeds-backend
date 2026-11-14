import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { errorHandler } from '../src/middleware/errorHandler.js';
import {
  recordOperationalResponse,
  getOperationalSnapshot,
  resetOperationalMetricsForTests,
  createOperationalMonitoringMiddleware,
} from '../src/services/operationalMonitoring.service.js';

test('process-local metrics count requests, denied access, errors and slow responses', () => {
  resetOperationalMetricsForTests();
  const now = Math.floor(Date.now() / 60000) * 60000 + 5000;
  recordOperationalResponse({ timestamp: now, statusCode: 200, durationMs: 10 });
  recordOperationalResponse({ timestamp: now, statusCode: 401, durationMs: 25 });
  recordOperationalResponse({ timestamp: now, statusCode: 403, durationMs: 2300 });
  recordOperationalResponse({ timestamp: now, statusCode: 500, durationMs: 45 });
  const summary = getOperationalSnapshot(now);
  assert.equal(summary.windowMinutes, 15);
  assert.equal(summary.total, 4);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.clientErrors, 2);
  assert.equal(summary.unauthenticated, 1);
  assert.equal(summary.forbidden, 1);
  assert.equal(summary.serverErrors, 1);
  assert.equal(summary.slowRequests, 1);
  assert.equal(summary.averageDurationMs, 595);
  assert.equal(summary.recentIncidents.length, 3);
  assert.equal(summary.processScope, true);

  // Every bucket older than the 15-minute window expires automatically.
  const later = getOperationalSnapshot(now + 16 * 60000);
  assert.equal(later.total, 0);
  assert.equal(later.recentIncidents.length, 0);
  resetOperationalMetricsForTests();
});

test('HTTP telemetry is bounded, request-ID tagged, sampled and does not log secrets', async () => {
  resetOperationalMetricsForTests();
  const persisted = [];
  const app = express();
  app.use(createOperationalMonitoringMiddleware({
    saveAudit: async (entry) => { persisted.push(entry); return true; },
  }));
  app.get('/api/deeds/:id', (_req, res) => res.status(403).json({ message: 'forbidden' }));
  app.get('/api/assets/:id', (_req, res) => res.status(503).json({ message: 'server error' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const secret = 'private-token-should-not-be-in-audit';
    const first = await fetch(origin + '/api/deeds/sensitive-record?token=' + secret, {
      headers: { authorization: 'Bearer ' + secret },
    });
    const second = await fetch(origin + '/api/deeds/another?token=' + secret, {
      headers: { authorization: 'Bearer ' + secret },
    });
    const failed = await fetch(origin + '/api/assets/internal?token=' + secret);
    const health = await fetch(origin + '/api/health');
    assert.equal(first.status, 403);
    assert.equal(second.status, 403);
    assert.equal(failed.status, 503);
    assert.equal(health.status, 200);
    assert.match(first.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
    assert.match(failed.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
    // A health probe is intentionally excluded from telemetry.
    assert.equal(health.headers.get('x-request-id'), null);
    await new Promise((resolve) => setImmediate(resolve));
    const snapshot = getOperationalSnapshot();
    assert.equal(snapshot.total, 3);
    assert.equal(snapshot.forbidden, 2);
    assert.equal(snapshot.serverErrors, 1);
    assert.equal(snapshot.recentIncidents.length, 3);
    assert.ok(snapshot.recentIncidents.every((x) => ['deeds', 'assets'].includes(x.module)));
    assert.equal(persisted.length, 2, 'Repeated denials are sampled; server errors always recorded');
    assert.ok(persisted.some((x) => x.action === 'access_denied'));
    assert.ok(persisted.some((x) => x.action === 'server_error'));
    const recorded = JSON.stringify({ persisted, snapshot });
    assert.ok(!recorded.includes(secret));
    assert.ok(!recorded.includes('sensitive-record'));
    assert.ok(!recorded.includes('another'));
    assert.ok(!recorded.includes('authorization'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    resetOperationalMetricsForTests();
  }
});

test('unexpected HTTP errors use generic messages and a correlatable request id', async () => {
  resetOperationalMetricsForTests();
  const app = express();
  app.use(createOperationalMonitoringMiddleware({ saveAudit: async () => true }));
  app.get('/api/deeds/throw', () => {
    throw new Error('INTERNAL_DATABASE_PASSWORD_DO_NOT_EXPOSE');
  });
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/deeds/throw`);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.ok(body.requestId);
    assert.equal(body.requestId, response.headers.get('x-request-id'));
    assert.ok(!JSON.stringify(body).includes('INTERNAL_DATABASE_PASSWORD_DO_NOT_EXPOSE'));
    assert.match(body.message, /حدث خطأ داخلي/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    resetOperationalMetricsForTests();
  }
});
