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
import { notFound, errorHandler } from './middleware/errorHandler.js';

export const app = express();

const allowedOrigin = process.env.FRONTEND_URL || '*';

app.use(helmet());
app.use(
  cors({
    origin: allowedOrigin === '*' ? true : allowedOrigin,
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
app.use('/api/deeds', deedsRoutes);
app.use('/api/attachments', attachmentsRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/records', recordsRoutes);
app.use('/api/archive', archiveRoutes);

app.use(notFound);
app.use(errorHandler);
