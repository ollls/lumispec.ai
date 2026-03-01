import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config.js';
import conversationRoutes from './routes/conversations.js';
import slotRoutes from './routes/slots.js';
import healthRoutes from './routes/health.js';
import slots from './services/slots.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, 'public')));

app.use('/api/conversations', conversationRoutes);
app.use('/api/slots', slotRoutes);
app.use('/api/health', healthRoutes);

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
