/**
 * ollamaService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin HTTP client for the Ollama local inference server.
 * Uses the native Node fetch API (available in Node 18+).
 *
 * Ollama REST API reference:
 *   POST /api/chat       — chat completion (system + user messages)
 *   GET  /api/tags       — list locally available models
 *   GET  /api/version    — Ollama server version
 *
 * Why /api/chat and not /api/generate
 * ─────────────────────────────────────────────────────────────────────────────
 * Ollama applies the model's own chat template to /api/chat requests, which is
 * what instruction-following models (llama3.2, qwen2.5, mistral) are trained
 * on. Sending one giant string to /api/generate bypasses that template and
 * measurably weakens instruction adherence.
 *
 * Configuration (via environment variables):
 *   OLLAMA_BASE_URL    — default: http://localhost:11434
 *   OLLAMA_MODEL       — default: llama3.2
 *   OLLAMA_TIMEOUT_MS  — request timeout in ms, default: 120000
 *   OLLAMA_MAX_TOKENS  — max tokens in the response, default: 1024
 *   OLLAMA_TEMPERATURE — sampling temperature [0–1], default: 0.1
 *   OLLAMA_NUM_CTX     — context window in tokens, default: 8192
 *
 * Temperature note:
 *   We use 0.1 (near-deterministic) so the model follows the system prompt
 *   strictly and does not creatively extend beyond the provided context.
 */

import config from '../../config/env.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Wraps fetch with a timeout using AbortController.
 *
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Checks whether the Ollama server is reachable and the configured model
 * is available locally.
 *
 * @returns {Promise<{ ok: boolean, version?: string, models?: string[], error?: string }>}
 */
export const checkOllamaHealth = async () => {
  try {
    const [versionRes, tagsRes] = await Promise.all([
      fetchWithTimeout(
        `${config.OLLAMA_BASE_URL}/api/version`,
        { method: 'GET' },
        5_000
      ),
      fetchWithTimeout(
        `${config.OLLAMA_BASE_URL}/api/tags`,
        { method: 'GET' },
        5_000
      ),
    ]);

    if (!versionRes.ok || !tagsRes.ok) {
      return { ok: false, error: 'Ollama server responded with an error.' };
    }

    const { version }      = await versionRes.json();
    const { models = [] }  = await tagsRes.json();
    const modelNames       = models.map((m) => m.name);
    const modelAvailable   = modelNames.some((n) =>
      n === config.OLLAMA_MODEL || n.startsWith(`${config.OLLAMA_MODEL}:`)
    );

    return {
      ok:             true,
      version,
      models:         modelNames,
      configuredModel: config.OLLAMA_MODEL,
      modelAvailable,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, error: 'Ollama server did not respond within 5 seconds.' };
    }
    return {
      ok:    false,
      error: `Cannot reach Ollama at ${config.OLLAMA_BASE_URL}: ${err.message}`,
    };
  }
};

/**
 * Sends a system + user message pair to Ollama and returns the complete
 * generated text (stream:false, so the whole answer arrives in one JSON body).
 *
 * @param {{ system: string, user: string, images?: string[] }} messages
 *   `images` are base64 strings; only multi-modal models understand them.
 * @param {object} [opts]
 * @param {string} [opts.model]       - Override the configured model
 * @param {number} [opts.maxTokens]   - Override OLLAMA_MAX_TOKENS
 * @param {number} [opts.temperature] - Override OLLAMA_TEMPERATURE
 * @param {number} [opts.numCtx]      - Override OLLAMA_NUM_CTX
 * @returns {Promise<{ text: string, model: string, evalDurationMs: number|null }>}
 * @throws {Error} on network failure, timeout, or Ollama error response
 */
export const chatCompletion = async ({ system, user, images }, opts = {}) => {
  if (!system || !user) {
    throw new Error('chatCompletion requires both a system and a user message.');
  }

  const model       = opts.model       ?? config.OLLAMA_MODEL;
  const temperature = opts.temperature ?? config.OLLAMA_TEMPERATURE;

  const userMessage = { role: 'user', content: user };
  if (images?.length) userMessage.images = images;

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      userMessage,
    ],
    stream: false,              // get the full response in one JSON object
    options: {
      temperature,
      num_predict:    opts.maxTokens ?? config.OLLAMA_MAX_TOKENS,
      num_ctx:        opts.numCtx    ?? config.OLLAMA_NUM_CTX,
      // Determinism helpers for academic / fact-based answers
      top_k:          40,
      top_p:          0.9,
      repeat_penalty: 1.1,
    },
  };

  let response;
  try {
    response = await fetchWithTimeout(
      `${config.OLLAMA_BASE_URL}/api/chat`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      },
      config.OLLAMA_TIMEOUT_MS
    );
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(
        `Ollama request timed out after ${config.OLLAMA_TIMEOUT_MS / 1000}s. ` +
        'The model may still be loading. Try again in a moment.'
      );
    }
    throw new Error(
      `Cannot reach Ollama at ${config.OLLAMA_BASE_URL}. ` +
      `Start it with "ollama serve" (install: winget install Ollama.Ollama), ` +
      `then pull the model: ollama pull ${config.OLLAMA_MODEL}`
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '(no body)');
    throw new Error(`Ollama returned HTTP ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const text = data.message?.content;

  if (!text || !text.trim()) {
    throw new Error('Ollama returned an empty message.');
  }

  return {
    text:           text.trim(),
    model:          data.model ?? model,
    evalDurationMs: data.eval_duration ? Math.round(data.eval_duration / 1_000_000) : null,
  };
};
