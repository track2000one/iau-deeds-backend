import { prisma } from '../prisma.js';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'jwt',
  'secret',
  'clientSecret',
  'privateKey',
]);

const MAX_JSON_LENGTH = 40_000;

export const sanitizeAuditData = (value, depth = 0) => {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[MAX_DEPTH]';

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) =>
      sanitizeAuditData(item, depth + 1)
    );
  }

  if (typeof value === 'object') {
    const output = {};

    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key)) {
        output[key] = '[REDACTED]';
        continue;
      }

      output[key] = sanitizeAuditData(item, depth + 1);
    }

    return output;
  }

  if (typeof value === 'string' && value.length > 5_000) {
    return `${value.slice(0, 5_000)}...[TRUNCATED]`;
  }

  return value;
};

const safeJson = (value) => {
  if (value === undefined) return undefined;

  const sanitized = sanitizeAuditData(value);
  const serialized = JSON.stringify(sanitized);

  if (serialized.length <= MAX_JSON_LENGTH) {
    return sanitized;
  }

  return {
    truncated: true,
    preview: serialized.slice(0, MAX_JSON_LENGTH),
  };
};

export const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];

  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return (
    req.headers['x-real-ip'] ||
    req.ip ||
    req.socket?.remoteAddress ||
    null
  );
};

export const createAuditLog = async ({
  user = null,
  action,
  module,
  entity = null,
  entityId = null,
  entityLabel = null,
  status = 'success',
  description = null,
  previousData = undefined,
  newData = undefined,
  metadata = undefined,
  ipAddress = null,
  userAgent = null,
  errorMessage = null,
}) => {
  try {
    return await prisma.auditLog.create({
      data: {
        userId: user?.id || null,
        username: user?.username || null,
        userEmail: user?.email || null,
        userRole: user?.role || null,
        action,
        module,
        entity,
        entityId,
        entityLabel,
        status,
        description,
        previousData: safeJson(previousData),
        newData: safeJson(newData),
        metadata: safeJson(metadata),
        ipAddress: ipAddress ? String(ipAddress).slice(0, 120) : null,
        userAgent: userAgent ? String(userAgent).slice(0, 700) : null,
        errorMessage: errorMessage
          ? String(errorMessage).slice(0, 2_000)
          : null,
      },
    });
  } catch (error) {
    console.error('Unable to create audit log:', error);
    return null;
  }
};
