/**
 * llmService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single entry point for text generation, whatever the backing model is.
 *
 *   LLM_PROVIDER=gemini  → Google AI Studio over HTTPS (works on Vercel)
 *   LLM_PROVIDER=ollama  → local inference (development only)
 *
 * When GEMINI_API_KEY is present and LLM_PROVIDER is unset, Gemini wins:
 * a serverless host can never reach a model running on the developer's PC.
 *
 * Callers pass the same { system, user, images } shape and receive
 * { text, model, evalDurationMs } either way.
 */

import config from '../../config/env.js';
import {
  chatCompletion   as ollamaChatCompletion,
  checkOllamaHealth as checkOllamaHealthRaw,
} from './ollamaService.js';
import {
  chatCompletion as geminiChatCompletion,
  checkHealth    as checkGeminiHealth,
} from './geminiService.js';

const VALID_PROVIDERS = new Set(['gemini', 'ollama']);

/**
 * @returns {'gemini'|'ollama'}
 */
export const getProvider = () =>
  VALID_PROVIDERS.has(config.LLM_PROVIDER) ? config.LLM_PROVIDER : 'ollama';

/**
 * Model identifier for the active provider — used in API metadata.
 * @returns {string}
 */
export const getModel = () =>
  getProvider() === 'gemini' ? config.GEMINI_MODEL : config.OLLAMA_MODEL;

/**
 * Whether attached images can actually be interpreted.
 * Gemini models are multi-modal; Ollama needs an explicit vision model.
 *
 * @returns {boolean}
 */
export const supportsVision = () =>
  getProvider() === 'gemini' ? true : Boolean(config.OLLAMA_VISION_MODEL);

/**
 * Generates a completion with the active provider.
 *
 * @param {{ system: string, user: string, images?: { name?: string, data: string, type?: string }[] }} messages
 * @param {object} [opts] - forwarded to the provider client
 * @returns {Promise<{ text: string, model: string, evalDurationMs: number|null }>}
 */
export const chatCompletion = async (messages, opts = {}) => {
  if (getProvider() === 'gemini') {
    return geminiChatCompletion(messages, opts);
  }

  // Ollama needs the vision model chosen explicitly, and only when images
  // were actually passed — llava would be used for a text-only turn otherwise.
  const model =
    messages.images?.length && config.OLLAMA_VISION_MODEL
      ? { ...opts, model: config.OLLAMA_VISION_MODEL }
      : opts;

  return ollamaChatCompletion(messages, model);
};

/**
 * Health payload for the admin/diagnostics endpoint.
 *
 * @returns {Promise<{ ok: boolean, provider: string, model: string, error?: string }>}
 */
export const checkLlmHealth = async () => {
  if (getProvider() === 'gemini') {
    const health = await checkGeminiHealth();

    // A rejected key or a model the key cannot use is not a healthy setup,
    // even though the API itself answered.
    return { ...health, ok: health.ok && health.modelAvailable !== false };
  }

  const health = await checkOllamaHealthRaw();

  return {
    ok:              health.ok && health.modelAvailable !== false,
    provider:        'ollama',
    model:           config.OLLAMA_MODEL,
    baseUrl:         config.OLLAMA_BASE_URL,
    modelAvailable:  health.modelAvailable,
    error:           health.error,
  };
};

/**
 * Configuration summary logged once at boot so a misconfigured deployment is
 * visible in the Vercel logs before the first student asks a question.
 *
 * @returns {{ provider: string, model: string, configured: boolean }}
 */
export const describeProvider = () => ({
  provider:   getProvider(),
  model:      getModel(),
  configured: getProvider() === 'gemini' ? Boolean(config.GEMINI_API_KEY) : true,
});
