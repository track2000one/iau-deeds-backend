import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import healthRoutes from './routes/health.routes.js';
import deedsRoutes from './routes/deeds.routes.js';
import attachmentsRoutes from './routes/attachments.routes.js';
import uploadsRoutes from './routes/uploads.routes.js';
import recordsRoutes from './routes/records.routes.js';
import archiveRoutes from './routes/archive.routes.js';
import authRoutes from './routes/auth.routes.js';
import usersRoutes from './routes/users.routes.js';
import auditRoutes from './routes/audit.routes.js';
import siteInspectionsRoutes from './routes/site-inspections.routes.js';
import {
  requireAdmin,
  requireAuth,
  requirePermission,
  requireRecordPermission,
  requireAttachmentPermission,
  requireUploadPermission,
} from './middleware/auth.js';
import { auditTrail } from './middleware/audit.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

export const app = express();

const allowedOrigin = process.env.FRONTEND_URL || '*';

app.set('trust proxy', true);
app.use(helmet());
app.use(
  cors({
    origin: allowedOrigin === '*' ? true : allowedOrigin,
    credentials: false,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

app.get('/', (_req, res) => {
  res.json({
    name: 'IAU Deeds and Lands API',
    status: 'running',
  });
});

app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);

app.use('/api/audit', requireAuth, requireAdmin, auditRoutes);
app.use('/api/users', requireAuth, auditTrail('users'), usersRoutes);

app.use(
  '/api/deeds',
  requireAuth,
  auditTrail('deeds'),
  requirePermission('deeds'),
  deedsRoutes
);

app.use(
  '/api/attachments',
  requireAuth,
  auditTrail('attachments'),
  requireAttachmentPermission,
  attachmentsRoutes
);

app.use(
  '/api/uploads',
  requireAuth,
  requireUploadPermission,
  auditTrail('uploads'),
  uploadsRoutes
);

app.use(
  '/api/records',
  requireAuth,
  auditTrail('records'),
  requireRecordPermission,
  recordsRoutes
);

app.use(
  '/api/archive',
  requireAuth,
  auditTrail('archive'),
  requirePermission('archive'),
  archiveRoutes
);


app.use(
  '/api/site-inspections',
  requireAuth,
  auditTrail('site_inspections'),
  requirePermission('site_inspections'),
  siteInspectionsRoutes
);

app.use(notFound);
app.use(errorHandler);
