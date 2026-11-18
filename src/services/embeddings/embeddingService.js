/**
 * embeddingService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Singleton wrapper around @huggingface/transformers v4 feature-extraction
 * pipeline.  Keeps a single model instance alive for the life of the process
 * so the 90 MB model is loaded from disk only once.
 *
 * Model: Xenova/all-MiniLM-L6-v2  (default)
 * ─────────────────────────────────────────────────────────────────────────────
 * Hardware requirements
 * ─────────────────────────────────────────────────────────────────────────────
 * • RAM   : ~200 MB resident after first load
 * • Disk  : ~90 MB download on first run (cached in ./models/)
 * • CPU   : Any modern x64 CPU; embedding 1 chunk takes ~10–50 ms
 * • GPU   : Not required; ONNX Runtime runs on CPU by default
 *
 * First-time model download
 * ─────────────────────────────────────────────────────────────────────────────
 * On the very first call to getEmbedder() (or any embed function), the ONNX
 * model files are downloaded from Hugging Face Hub and saved to ./models/.
 * This happens once per machine; subsequent starts load from local cache.
 * Expect 10–30 seconds on a typical broadband connection.
 * Set EMBEDDING_MODEL_DIR in .env to control the cache location.
 *
 * Output dimensions: 384 floats per text input.
 */

import config from '../../config/env.js';

// Loaded on first use, not at import time: the native onnxruntime binding
// fails to load in some serverless runtimes and would otherwise take down
// every route (including /api/health) during function initialisation.
let _transformers = null;
const loadTransformers = async () => {
  if (_transformers) return _transformers;

  const mod = await import('@huggingface/transformers');
  mod.env.cacheDir          = config.EMBEDDING_MODEL_DIR;  // where models are cached
  mod.env.allowLocalModels  = true;   // read from cache if available
  mod.env.allowRemoteModels = true;   // download on first use

  _transformers = mod;
  return _transformers;
};

/** @type {import('@huggingface/transformers').FeatureExtractionPipeline | null} */
let _embedder = null;
let _loadingPromise = null;

/**
 * Returns (and lazily initialises) the singleton feature-extraction pipeline.
 * Thread-safe: concurrent callers all await the same Promise.
 *
 * @returns {Promise<import('@huggingface/transformers').FeatureExtractionPipeline>}
 */
export const getEmbedder = async () => {
  if (_embedder) return _embedder;

  // Prevent multiple concurrent initialisations
  if (_loadingPromise) return _loadingPromise;

  _loadingPromise = (async () => {
    const model = config.EMBEDDING_MODEL;
    console.log(`🤖  Loading embedding model: ${model}`);
    console.log(`    Cache dir: ${config.EMBEDDING_MODEL_DIR}`);
    console.log('    (First run downloads ~90 MB — subsequent starts are instant)');

    const { pipeline } = await loadTransformers();
    const extractor = await pipeline('feature-extraction', model, {
      // quantized: true reduces model size ~4x with minimal accuracy loss
      // set to false for maximum accuracy if disk/RAM is not a concern
      quantized: true,
    });

    _embedder = extractor;
    console.log(`✅  Embedding model loaded: ${model}`);
    return _embedder;
  })();

  _embedder = await _loadingPromise;
  return _embedder;
};

/**
 * Returns the name of the currently configured model.
 * Used by the re-embed endpoint to detect model changes.
 *
 * @returns {string}
 */
export const getModelName = () => config.EMBEDDING_MODEL;

/**
 * Embeds a single text string.
 * Returns a normalised 384-dimensional Float32 vector.
 *
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export const embedText = async (text) => {
  if (!text || typeof text !== 'string') {
    throw new Error('embedText requires a non-empty string');
  }

  const extractor = await getEmbedder();

  // mean_pooling + normalisation gives sentence-level embeddings
  const output = await extractor(text.trim(), {
    pooling:   'mean',
    normalize: true,
  });

  // output.data is a Float32Array — convert to plain JS array for MongoDB
  return Array.from(output.data);
};

/**
 * Embeds an array of texts in configurable batches.
 * Logs progress every batch so long jobs don't look frozen.
 *
 * @param {string[]}  texts
 * @param {object}    [opts]
 * @param {number}    [opts.batchSize]  - defaults to config.EMBEDDING_BATCH_SIZE
 * @param {Function}  [opts.onProgress] - called with (done, total) after each batch
 * @returns {Promise<number[][]>}       - parallel array of embedding vectors
 */
export const embedBatch = async (texts, { batchSize, onProgress } = {}) => {
  const size    = batchSize ?? config.EMBEDDING_BATCH_SIZE;
  const total   = texts.length;
  const results = [];

  for (let i = 0; i < total; i += size) {
    const batch  = texts.slice(i, i + size);
    const extractor = await getEmbedder();

    // Process each item in the batch (the pipeline can handle arrays directly
    // in some versions; we iterate to be safe across versions)
    const batchVectors = await Promise.all(
      batch.map(async (text) => {
        const out = await extractor(text.trim(), { pooling: 'mean', normalize: true });
        return Array.from(out.data);
      })
    );

    results.push(...batchVectors);

    const done = Math.min(i + size, total);
    if (onProgress) onProgress(done, total);
    else console.log(`    Embedded ${done} / ${total} chunks…`);
  }

  return results;
};
