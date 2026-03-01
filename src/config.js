export default {
  port: parseInt(process.env.PORT || '3000', 10),
  llama: {
    baseUrl: process.env.LLAMA_URL || 'http://localhost:8080',
    maxContextTokens: parseInt(process.env.LLAMA_MAX_CONTEXT || '131072', 10),
  },
};
