// Live check of the Gemini configuration. NOT part of `npm test`: it makes real
// requests with your real key. Run it with `npm run test:gemini-live`.
//
//   1. asks Gemini whether the key may use the configured model (free);
//   2. unless --no-generate is passed, sends one tiny structured-output request
//      through the app's own client (a few tokens).
//
// The key is read the way the app reads it in development — GEMINI_API_KEY from
// the environment or the git-ignored `.env` — and is never printed.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
if (!process.env.GEMINI_API_KEY?.trim()) {
  try {
    process.loadEnvFile(path.join(root, '.env'));
  } catch {
    // No .env — rely on the real environment.
  }
}

const { GeminiClient } = await import(pathToFileURL(path.join(root, 'dist-electron', 'intelligence', 'GeminiClient.js')).href);
const client = new GeminiClient();

if (!client.isConfigured()) {
  console.log('NOT CONFIGURED: GEMINI_API_KEY is not set (environment or .env).');
  process.exit(2);
}
console.log(`Model: ${client.model}`);

const report = (step, err) => {
  console.log(`${step}: FAILED — ${err?.category ?? 'unexpected'}${err?.status ? ` (HTTP ${err.status})` : ''}`);
  if (err?.message) console.log(`  ${err.message}`);
  process.exit(1);
};

try {
  await client.verifyKey(process.env.GEMINI_API_KEY);
  console.log('Key + model check: OK');
} catch (err) {
  report('Key + model check', err);
}

if (!process.argv.includes('--no-generate')) {
  try {
    const response = await client.generateJson({
      systemInstruction: 'Reply with the JSON object requested and nothing else.',
      prompt: 'Set "ok" to true.',
      responseJsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    });
    JSON.parse(response.text);
    console.log(`Structured generation: OK (${response.modelVersion})`);
  } catch (err) {
    report('Structured generation', err);
  }
}
