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

const toFriendlyError = (status, message, model) => {
  if (status === 400 && /api[\s_-]?key/i.test(message)) {
    return 'GEMINI_API_KEY was rejected by Google. Check the key in the server environment.';
  }
  if (status === 403) {
    return `Gemini denied the request (${message}). Check that the key is enabled for the Generative Language API.`;
  }
  if (status === 404) {
    return `Gemini model "${model}" is not available for this API key (${message}).`;
  }
  if (status === 429) {
    return 'Gemini rate limit reached. Free-tier quotas reset per minute — try again shortly.';
  }
  if (status >= 500) {
    return `Gemini is temporarily unavailable (${message}).`;
  }
  return `Gemini returned HTTP ${status}: ${message}`;
};

// ── Model discovery ───────────────────────────────────────────────────────────
// Google retires model ids for new API keys (gemini-2.5-flash already answers
// "no longer available to new users"), so the configured id is treated as a
// preference, not a guarantee. The first usable id from the live catalogue is
// cached per process and re-resolved whenever the API reports a 404.

const UNSUITABLE_MODEL = /embedding|aqa|imagen|veo|tts|live|native-audio|image-preview/i;

/**
 * @returns {Promise<string[]>} model ids without the "models/" prefix
 */
const listAvailableModels = async () => {
  const response = await fetchWithTimeout(
    `${API_ROOT}?pageSize=1000`,
    { method: 'GET', headers: { 'x-goog-api-key': config.GEMINI_API_KEY } },
    5_000
  );

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const { models = [] } = await response.json();

  return models
    .filter((model) => model.supportedGenerationMethods?.includes('generateContent'))
    .map((model) => (model.name ?? '').replace(/^models\//, ''))
    .filter((id) => id && !UNSUITABLE_MODEL.test(id));
};

/**
 * Ranked preference: the configured id, then the newest plain flash model,
 * any flash variant, a plain pro model, then whatever is available.
 *
 * @param {string[]} ids
 * @returns {string|null}
 */
const pickModel = (ids) => {
  const ranked = [...ids].sort((a, b) => {
    const version = (id) => parseFloat(id.match(/gemini-([\d.]+)/)?.[1] ?? '0');
    return version(b) - version(a);
  });

  const preferences = [
    (id) => id === config.GEMINI_MODEL,
    (id) => /^gemini-[\d.]+-flash$/.test(id),
    (id) => /flash/.test(id),
    (id) => /^gemini-[\d.]+-pro$/.test(id),
    () => true,
  ];

  for (const matches of preferences) {
    const found = ranked.find(matches);
    if (found) return found;
  }

  return null;
};

let modelInUse = null;
let modelLookup = null;

/**
 * The model id to call right now. No network call: the configured id is used
 * until the API rejects it, so the common path stays a single request.
 *
 * @returns {Promise<string>}
 */
const resolveModel = async () => {
  if (modelInUse) return modelInUse;
  modelInUse = config.GEMINI_MODEL;
  return modelInUse;
};

/**
 * Replaces the cached model with the best one the key can actually use.
 * Guarded so concurrent requests share one catalogue fetch.
 *
 * @returns {Promise<string>}
 */
const discoverModel = async () => {
  if (modelLookup) return modelLookup;

  modelLookup = (async () => {
    try {
      const ids = await listAvailableModels();
      const picked = pickModel(ids);

      if (picked && picked !== config.GEMINI_MODEL) {
        console.warn(
          `⚠️  Gemini model "${config.GEMINI_MODEL}" is unavailable for this key; using "${picked}".`
        );
      }

      modelInUse = picked ?? config.GEMINI_MODEL;
    } catch (err) {
      console.warn(
        `⚠️  Could not list Gemini models (${err.message}); using "${config.GEMINI_MODEL}".`
      );
      modelInUse = config.GEMINI_MODEL;
    }

    return modelInUse;
  })().finally(() => {
    modelLookup = null;
  });

  return modelLookup;
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

  const startedAt = Date.now();
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);

    const model = await resolveModel();
    const url = `${API_ROOT}/${encodeURIComponent(model)}:generateContent`;

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
    lastError = new Error(toFriendlyError(response.status, message, model));

    // A retired model reads as 404: drop the cached choice, resolve against
    // the live catalogue and try once more.
    if (response.status === 404 && attempt === 0) {
      modelInUse = null;
      await discoverModel();
      continue;
    }

    if (!RETRYABLE_STATUS.has(response.status)) break;
  }

  throw lastError;
};

/**
 * Confirms the API key works and reports which model will actually be used.
 *
 * @returns {Promise<{ ok: boolean, provider: 'gemini', model: string, configuredModel: string, availableModels?: string[], error?: string }>}
 */
export const checkHealth = async () => {
  if (!config.GEMINI_API_KEY) {
    return {
      ok: false,
      provider: 'gemini',
      model: config.GEMINI_MODEL,
      configuredModel: config.GEMINI_MODEL,
      error: 'GEMINI_API_KEY is not set.',
    };
  }

  try {
    // Health must fail loudly, so it lists the catalogue directly instead of
    // going through discoverModel, which swallows listing errors.
    const ids = await listAvailableModels();
    const model = pickModel(ids) ?? config.GEMINI_MODEL;
    modelInUse = model;

    return {
      ok:              true,
      provider:        'gemini',
      model,
      configuredModel: config.GEMINI_MODEL,
      availableModels: ids.slice(0, 10),
    };
  } catch (err) {
    return {
      ok:    false,
      provider: 'gemini',
      model: config.GEMINI_MODEL,
      configuredModel: config.GEMINI_MODEL,
      error: `Cannot list Gemini models: ${err.message}`,
    };
  }
};
