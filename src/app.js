import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import healthRoutes from './routes/health.routes.js';
import deedsRoutes from './routes/deeds.routes.js';
import attachmentsRoutes from './routes/attachments.routes.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

export const app = express();

const allowedOrigin = process.env.FRONTEND_URL || '*';

app.use(helmet());

app.use(
  cors({
    origin: allowedOrigin === '*' ? true : allowedOrigin,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

/**
 * Root route
 * هذا المسار يظهر عند فتح رابط الـ Backend مباشرة بدون /api
 */
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'IAU Deeds and Lands API',
    message: 'Backend is running. Use /api/health or /api/deeds',
    endpoints: {
      health: '/api/health',
      deeds: '/api/deeds',
      attachments: '/api/attachments',
    },
  });
});

/**
 * API Routes
 */
app.use('/api/health', healthRoutes);
app.use('/api/deeds', deedsRoutes);
app.use('/api/attachments', attachmentsRoutes);

/**
 * 404 + Error Handler
 */
app.use(notFound);
app.use(errorHandler);
