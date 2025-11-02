/**
 * OpenAI公式Node.js Expressサンプルに基づくToken Service
 * Ephemeral Tokenを生成してクライアントに提供
 */

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import app from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 Token Service running on http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
  console.log(`🔑 Session endpoint: http://localhost:${PORT}/session`);

  // 環境変数チェック
  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠️  OPENAI_API_KEY not set - service will not work properly');
    console.warn('   Please set OPENAI_API_KEY environment variable');
  }
});
