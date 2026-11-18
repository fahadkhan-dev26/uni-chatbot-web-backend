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

// Fail over to another model when the id is retired, the quota is spent, or
// the model is saturated (Google answers 503 "experiencing high demand").
const FAILOVER_STATUS = new Set([404, 429, 500, 503, 504]);
const RETRY_DELAY_MS = 800;
const MAX_MODEL_ATTEMPTS = 3;
const CATALOGUE_TTL_MS = 10 * 60 * 1000;

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
// "no longer available to new users") and individual models get saturated, so a
// single id cannot be trusted. The catalogue is fetched after the first failure
// and ranked; the request then fails over across the ranked ids.

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
 * Orders ids by preference: configured, newest plain flash, any flash variant,
 * plain pro, then the rest. Newest version first within each group.
 *
 * @param {string[]} ids
 * @returns {string[]}
 */
const rankModels = (ids) => {
  const version = (id) => parseFloat(id.match(/gemini-([\d.]+)/)?.[1] ?? '0');
  const ranked = [...ids].sort((a, b) => version(b) - version(a));

  const preferences = [
    (id) => id === config.GEMINI_MODEL,
    (id) => /^gemini-[\d.]+-flash$/.test(id),
    (id) => /flash/.test(id),
    (id) => /^gemini-[\d.]+-pro$/.test(id),
    () => true,
  ];

  const ordered = [];

  for (const matches of preferences) {
    for (const id of ranked) {
      if (matches(id) && !ordered.includes(id)) ordered.push(id);
    }
  }

  return ordered;
};

let catalogue = null;          // { ids: string[], fetchedAt: number }
let catalogueLookup = null;
let modelInUse = null;

/**
 * Loads and ranks the catalogue, cached for a few minutes so a wave of failed
 * requests does not turn into a wave of listing calls.
 *
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<string[]>}
 */
const loadCatalogue = async ({ force = false } = {}) => {
  if (!force && catalogue && Date.now() - catalogue.fetchedAt < CATALOGUE_TTL_MS) {
    return catalogue.ids;
  }
  if (catalogueLookup) return catalogueLookup;

  catalogueLookup = (async () => {
    try {
      const ids = rankModels(await listAvailableModels());
      catalogue = { ids, fetchedAt: Date.now() };
      return ids;
    } catch (err) {
      console.warn(`⚠️  Could not list Gemini models (${err.message}).`);
      return [];
    }
  })().finally(() => {
    catalogueLookup = null;
  });

  return catalogueLookup;
};

/**
 * Candidate ids in the order they should be tried. The configured id goes
 * first so a healthy setup never pays for a listing round trip; ranked
 * catalogue entries follow once a failure has been seen.
 *
 * @returns {string[]}
 */
const candidateModels = () => [
  ...new Set([modelInUse, config.GEMINI_MODEL, ...(catalogue?.ids ?? [])].filter(Boolean)),
];

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
 * One request to one model. Never throws for API-level failures — the caller
 * decides whether the status is worth another model.
 *
 * @returns {Promise<{ ok: true, text: string, model: string } | { ok: false, status: number, error: string }>}
 */
const requestModel = async (model, { system, user, images }, opts) => {
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
      return {
        ok:     false,
        status: 504,
        error:  `Gemini model "${model}" did not answer within ${config.GEMINI_TIMEOUT_MS / 1000}s.`,
      };
    }
    throw new Error(`Cannot reach the Gemini API: ${err.message}`);
  }

  if (response.ok) {
    const data = await response.json();
    const text = extractText(data);

    if (!text) {
      const blocked = data?.promptFeedback?.blockReason;
      const finishReason = data?.candidates?.[0]?.finishReason;

      // Content-level refusal: another model would refuse the same prompt.
      return {
        ok:     false,
        status: 422,
        error:  blocked
          ? `Gemini blocked the request (${blocked}).`
          : `Gemini returned no text (finishReason: ${finishReason ?? 'unknown'}).`,
      };
    }

    return { ok: true, text, model: data.modelVersion ?? model };
  }

  return {
    ok:     false,
    status: response.status,
    error:  toFriendlyError(response.status, await readError(response), model),
  };
};

/**
 * Sends one grounded request to Gemini and returns the generated text.
 *
 * If the configured model is retired or saturated, the same request is retried
 * on the next-ranked model from the live catalogue, so a retired or overloaded
 * id degrades to a working model instead of the fixed fallback.
 *
 * @param {{ system: string, user: string, images?: { data: string, type?: string }[] }} messages
 * @param {object} [opts]
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{ text: string, model: string, evalDurationMs: number }>}
 * @throws {Error} on missing key, network failure, or when every candidate fails
 */
export const chatCompletion = async ({ system, user, images }, opts = {}) => {
  if (!config.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set, so Gemini cannot be used.');
  }
  if (!system || !user) {
    throw new Error('chatCompletion requires both a system and a user message.');
  }

  const startedAt = Date.now();
  const tried = [];
  let lastError = null;

  for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);

    // Only after a failure is the catalogue worth a round trip.
    if (attempt > 0 && !catalogue) await loadCatalogue();

    const model = candidateModels().find((id) => !tried.includes(id));
    if (!model) break;

    tried.push(model);

    const result = await requestModel(model, { system, user, images }, opts);

    if (result.ok) {
      if (modelInUse && modelInUse !== model) {
        console.warn(`⚠️  Gemini failover: now using "${model}".`);
      }
      modelInUse = model;

      return {
        text:           result.text,
        model:          result.model,
        evalDurationMs: Date.now() - startedAt,
      };
    }

    lastError = new Error(result.error);

    if (!FAILOVER_STATUS.has(result.status)) break;
  }

  // Attached so callers can report exactly what was attempted (see
  // meta.llmTriedModels) — the catalogue is otherwise invisible in production.
  const error = lastError ?? new Error('Gemini produced no answer.');
  error.triedModels = tried;
  error.availableModels = catalogue?.ids ?? [];

  throw error;
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
    // using the cached copy.
    const ids = await loadCatalogue({ force: true });

    if (ids.length === 0) {
      throw new Error('the key has no generateContent model available.');
    }

    const model = ids[0];
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
