import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config.js';
import conversationRoutes from './routes/conversations.js';
import slotRoutes from './routes/slots.js';
import healthRoutes from './routes/health.js';
import etradeRoutes from './routes/etrade.js';
import promptRoutes from './routes/prompts.js';
import toolRoutes from './routes/tools.js';
import templateRoutes from './routes/templates.js';
import sessionRoutes from './routes/sessions.js';
import slots from './services/slots.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, 'public')));
app.use('/files', express.static(join(__dirname, '..', 'data')));

app.use('/api/conversations', conversationRoutes);
app.use('/api/slots', slotRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/etrade', etradeRoutes);
app.use('/api/prompts', promptRoutes);
app.use('/api/tools', toolRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/sessions', sessionRoutes);

app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'views', 'index.html'));
});

const server = app.listen(config.port, () => {
  console.log(`LLM Workbench running at http://localhost:${config.port}`);
  slots.startPolling();
});

process.on('SIGTERM', () => {
  slots.stopPolling();
  server.close();
});
