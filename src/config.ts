import 'dotenv/config';

/** "anthropic"/"claude" (or unset) -> Anthropic; anything else (openai, gemini, groq, openrouter, ollama…) -> OpenAI-compatible. */
const rawProvider = (process.env.LLM_PROVIDER ?? 'anthropic').trim().toLowerCase();
const llmProvider = ['', 'anthropic', 'claude'].includes(rawProvider) ? 'anthropic' : 'openai';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** "anthropic" (default) or "openai" for any OpenAI-compatible endpoint (Gemini free tier, Groq, OpenRouter, Ollama…). */
  llmProvider,
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  llmApiKey: process.env.LLM_API_KEY,
  llmBaseUrl: process.env.LLM_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
  /** Optional, OpenAI-compatible providers only (e.g. Gemini): "low" cuts latency a lot. Left unset because some providers reject it. */
  reasoningEffort: process.env.REASONING_EFFORT || undefined,
  model: process.env.MODEL ?? (llmProvider === 'openai' ? 'gemini-3.5-flash' : 'claude-sonnet-5-5'),
  searchProvider: (process.env.SEARCH_PROVIDER ?? 'tavily').toLowerCase(),
  tavilyKey: process.env.TAVILY_API_KEY,
  defaultTz: process.env.DEFAULT_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  dataDir: process.env.DATA_DIR ?? 'data',
  allowClockOverride: process.env.ALLOW_CLOCK_OVERRIDE === '1',
  /** Max chat requests per minute per client; 0 disables. */
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? 20),
  /** Max model round-trips per user message (each may fan out parallel searches). */
  maxSteps: 4,
  /** Hard cap on searches per user message. */
  maxSearches: 8,
};
