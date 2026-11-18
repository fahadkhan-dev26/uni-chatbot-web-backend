import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import config from './config/env.js';
import apiLimiter from './middleware/rateLimiter.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

// ── Route imports ────────────────────────────────────────────────────────────
import healthRoutes   from './routes/healthRoutes.js';
import systemRoutes   from './routes/systemRoutes.js';
import authRoutes     from './routes/authRoutes.js';
import documentRoutes from './routes/documentRoutes.js';
import ragRoutes      from './routes/ragRoutes.js';
import chatRoutes     from './routes/chatRoutes.js';

// ── App init ─────────────────────────────────────────────────────────────────
const app = express();

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: config.CLIENT_URL,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api', apiLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/health',    healthRoutes);
app.use('/api/system',    systemRoutes);
app.use('/api/auth',      authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/rag',       ragRoutes);
app.use('/api/chat',      chatRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use(notFoundHandler);

// ── Global error handler ──────────────────────────────────────────────────────
app.use(errorHandler);

export default app;
