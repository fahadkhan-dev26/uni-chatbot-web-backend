/**
 * geminiService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Google AI Studio (Gemini) client used when LLM_PROVIDER=gemini.
 *
 * Why a hosted API
 * ─────────────────────────────────────────────────────────────────────────────
 * Ollama binds to the machine that runs it. On Vercel the process has no such
 * machine, so every answer degraded to "AI service unavailable". Gemini is
 * reached over HTTPS from any runtime, which is what a deployed chatbot needs.
 *
 * REST reference: POST /v1beta/models/{model}:generateContent
 * Docs: https://ai.google.dev/api/generate-content
 *
 * The request shape mirrors ollamaService.chatCompletion
 * ({ system, user, images }) → { text, model, evalDurationMs } so the caller
 * does not care which provider is active.
 */

import config from '../../config/env.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

// One retry covers the transient 429/503 bursts the free tier produces.
const RETRYABLE_STATUS = new Set([429, 500, 503]);
const RETRY_DELAY_MS = 1200;

/**
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads the error message out of a Gemini error body without echoing the key.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
const readError = async (response) => {
  try {
    const data = await response.json();
    return data?.error?.message || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
};

const toFriendlyError = (status, message) => {
  if (status === 400 && /api[\s_-]?key/i.test(message)) {
    return 'GEMINI_API_KEY was rejected by Google. Check the key in the server environment.';
  }
  if (status === 403) {
    return `Gemini denied the request (${message}). Check that the key is enabled for the Generative Language API.`;
  }
  if (status === 404) {
    return `Gemini model "${config.GEMINI_MODEL}" is not available for this API key (${message}).`;
  }
  if (status === 429) {
    return 'Gemini rate limit reached. Free-tier quotas reset per minute — try again shortly.';
  }
  if (status >= 500) {
    return `Gemini is temporarily unavailable (${message}).`;
  }
  return `Gemini returned HTTP ${status}: ${message}`;
};

/**
 * Builds the request body. Images become inlineData parts, which is how
 * Gemini accepts attachments without a separate upload step.
 *
 * @param {{ system: string, user: string, images?: { data: string, type?: string }[] }} messages
 * @param {object} opts
 */
const buildBody = ({ system, user, images }, opts) => {
  const parts = [{ text: user }];

  for (const image of images ?? []) {
    parts.push({
      inlineData: {
        mimeType: image.type || 'image/png',
        data:     image.data,
      },
    });
  }

  return {
    systemInstruction: { parts: [{ text: system }] },
    contents:          [{ role: 'user', parts }],
    generationConfig: {
      temperature:     opts.temperature ?? config.LLM_TEMPERATURE,
      maxOutputTokens: opts.maxTokens   ?? config.GEMINI_MAX_TOKENS,
    },
  };
};

/**
 * Joins the text parts of the first candidate. Thinking models may return
 * several parts; parts flagged as thoughts are not part of the answer.
 *
 * @param {any} data
 * @returns {string}
 */
const extractText = (data) => {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  return parts
    .filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text)
    .join('')
    .trim();
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sends one grounded request to Gemini and returns the generated text.
 *
 * @param {{ system: string, user: string, images?: { data: string, type?: string }[] }} messages
 * @param {object} [opts]
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{ text: string, model: string, evalDurationMs: number }>}
 * @throws {Error} on missing key, network failure, timeout, or API error
 */
export const chatCompletion = async ({ system, user, images }, opts = {}) => {
  if (!config.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set, so Gemini cannot be used.');
  }
  if (!system || !user) {
    throw new Error('chatCompletion requires both a system and a user message.');
  }

  const model = config.GEMINI_MODEL;
  const url = `${API_ROOT}/${encodeURIComponent(model)}:generateContent`;
  const startedAt = Date.now();

  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);

    let response;
    try {
      response = await fetchWithTimeout(
        url,
        {
          method:  'POST',
          headers: {
            'Content-Type':   'application/json',
            'x-goog-api-key': config.GEMINI_API_KEY,
          },
          body: JSON.stringify(buildBody({ system, user, images }, opts)),
        },
        config.GEMINI_TIMEOUT_MS
      );
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Gemini did not answer within ${config.GEMINI_TIMEOUT_MS / 1000}s.`);
      }
      throw new Error(`Cannot reach the Gemini API: ${err.message}`);
    }

    if (response.ok) {
      const data = await response.json();
      const text = extractText(data);

      if (!text) {
        const finishReason = data?.candidates?.[0]?.finishReason;
        const blocked = data?.promptFeedback?.blockReason;
        throw new Error(
          blocked
            ? `Gemini blocked the request (${blocked}).`
            : `Gemini returned no text (finishReason: ${finishReason ?? 'unknown'}).`
        );
      }

      return {
        text,
        model:          data.modelVersion ?? model,
        evalDurationMs: Date.now() - startedAt,
      };
    }

    const message = await readError(response);
    lastError = new Error(toFriendlyError(response.status, message));

    if (!RETRYABLE_STATUS.has(response.status)) break;
  }

  throw lastError;
};

/**
 * Confirms the API key works and the configured model exists.
 *
 * @returns {Promise<{ ok: boolean, provider: 'gemini', model: string, error?: string }>}
 */
export const checkHealth = async () => {
  const base = { provider: 'gemini', model: config.GEMINI_MODEL };

  if (!config.GEMINI_API_KEY) {
    return { ...base, ok: false, error: 'GEMINI_API_KEY is not set.' };
  }

  try {
    const response = await fetchWithTimeout(
      `${API_ROOT}?pageSize=50`,
      { method: 'GET', headers: { 'x-goog-api-key': config.GEMINI_API_KEY } },
      5_000
    );

    if (!response.ok) {
      return { ...base, ok: false, error: await readError(response) };
    }

    const { models = [] } = await response.json();
    const names = models.map((model) => (model.name ?? '').replace(/^models\//, ''));
    const modelAvailable = names.includes(config.GEMINI_MODEL);

    return {
      ...base,
      ok: true,
      modelAvailable,
      error: modelAvailable
        ? undefined
        : `Model "${config.GEMINI_MODEL}" is not listed for this key. Set GEMINI_MODEL to one of: ${names.slice(0, 6).join(', ')}`,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      error: err.name === 'AbortError'
        ? 'Gemini did not respond within 5 seconds.'
        : `Cannot reach the Gemini API: ${err.message}`,
    };
  }
};
