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
  search: {
    engine: process.env.SEARCH_ENGINE || 'keiro', // 'keiro', 'tavily', or 'both'
  },
  tavily: {
    apiKey: process.env.TAVILY_API_KEY || '',
  },
  keiro: {
    apiKey: process.env.KEIRO_API_KEY || '',
    baseUrl: process.env.KEIRO_BASE_URL || 'https://kierolabs.space/api',
  },
  python: {
    venvPath: process.env.PYTHON_VENV || '',
  },
  liteapi: {
    apiKey: process.env.LITEAPI_KEY || '',
  },
  claude: {
    apiKey: process.env.CLAUDE_API_KEY || '',
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
    maxTokens: parseInt(process.env.CLAUDE_MAX_TOKENS || '8192', 10),
  },
  llm: {
    backend: process.env.LLM_BACKEND || 'llama', // 'llama' or 'claude'
  },
  etrade: {
    consumerKey: process.env.ETRADE_CONSUMER_KEY || '',
    consumerSecret: process.env.ETRADE_CONSUMER_SECRET || '',
    sandbox: process.env.ETRADE_SANDBOX === 'true',
  },
};
