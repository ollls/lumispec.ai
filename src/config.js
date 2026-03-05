import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';

if (!existsSync('.env')) {
  console.error('Error: .env file not found.');
  console.error('Run: cp .env.example .env');
  console.error('Then edit .env with your settings.');
  process.exit(1);
}

dotenvConfig();

export default {
  port: parseInt(process.env.PORT || '3000', 10),
  llama: {
    baseUrl: process.env.LLAMA_URL || 'http://localhost:8080',
    maxContextTokens: parseInt(process.env.LLAMA_MAX_CONTEXT || '131072', 10),
  },
  tavily: {
    apiKey: process.env.TAVILY_API_KEY || '',
  },
};
