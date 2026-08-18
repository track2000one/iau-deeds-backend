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
import organizationRoutes from './routes/organization.routes.js';
import auditRoutes from './routes/audit.routes.js';
import siteInspectionsRoutes from './routes/site-inspections.routes.js';
import assetsRoutes from './routes/assets.routes.js';
import assetCyclesRoutes from './routes/asset-cycles.routes.js';
import assetsFastRoutes from './routes/assets-fast.routes.js';
import contractsFollowUpRoutes from './routes/contracts-followup.routes.js';
import mosquesRoutes, { mosquesPublicRoutes } from './routes/mosques.routes.js';
import accountingTransformationRoutes from './routes/accounting-transformation.routes.js';
import accountingCyclesRoutes from './routes/accounting-cycles.routes.js';
import accountingAssetClassificationRoutes from './routes/accounting-asset-classification.routes.js';
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
app.use('/api/mosques/public', mosquesPublicRoutes);

app.use('/api/audit', requireAuth, requireAdmin, auditRoutes);
app.use('/api/users', requireAuth, auditTrail('users'), usersRoutes);
app.use(
  '/api/organization-units',
  requireAuth,
  auditTrail('organization_units'),
  organizationRoutes
);

app.use(
  '/api/deeds',
  requireAuth,
  auditTrail('deeds'),
  requirePermission('deeds'),
  deedsRoutes
);

app.use(
  '/api/assets-fast',
  requireAuth,
  requirePermission('assets'),
  assetsFastRoutes
);

app.use(
  '/api/assets/cycles',
  requireAuth,
  auditTrail('assets'),
  requirePermission('assets'),
  assetCyclesRoutes
);

app.use(
  '/api/assets',
  requireAuth,
  auditTrail('assets'),
  requirePermission('assets'),
  assetsRoutes
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
  '/api/contracts/follow-up',
  requireAuth,
  auditTrail('contracts_followup'),
  contractsFollowUpRoutes
);

app.use(
  '/api/site-inspections',
  requireAuth,
  auditTrail('site_inspections'),
  requirePermission('site_inspections'),
  siteInspectionsRoutes
);

app.use(
  '/api/mosques',
  requireAuth,
  auditTrail('mosques'),
  requirePermission('mosques'),
  mosquesRoutes
);

app.use(
  '/api/accounting-transformation/asset-classification',
  requireAuth,
  auditTrail('accounting_transformation'),
  requirePermission('accounting_transformation'),
  accountingAssetClassificationRoutes
);

app.use(
  '/api/accounting-transformation/cycles',
  requireAuth,
  auditTrail('accounting_transformation'),
  requirePermission('accounting_transformation'),
  accountingCyclesRoutes
);

app.use(
  '/api/accounting-transformation',
  requireAuth,
  auditTrail('accounting_transformation'),
  requirePermission('accounting_transformation'),
  accountingTransformationRoutes
);

app.use(notFound);
app.use(errorHandler);