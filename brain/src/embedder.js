'use strict';

/**
 * Fully local embeddings via transformers.js (ONNX runtime under the hood).
 * Model weights (~90MB) are downloaded once on first use and cached by the
 * library - after that this runs 100% offline.
 *
 * Host controls (DevSarathi):
 *   BRAIN_MODEL_DIR / DEVSARATHI_MODEL_DIR  where the model is cached (default: the library's own cache dir)
 *   BRAIN_OFFLINE=1 / DEVSARATHI_OFFLINE=1  never touch the network; fail with a clear error if the model is missing
 *   BRAIN_EMBEDDER=fake                     deterministic hashing embedder: no model, no network. For tests and CI only -
 *                                           vectors carry no semantics, so search quality is lexical-ish at best.
 */
let pipelinePromise = null;

const EMBEDDING_DIM = 384;
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

function envFlag(...names) {
  return names.some((n) => process.env[n] === '1' || process.env[n] === 'true');
}

function modelDirFromEnv() {
  return process.env.BRAIN_MODEL_DIR || process.env.DEVSARATHI_MODEL_DIR || null;
}

function useFakeEmbedder() {
  return process.env.BRAIN_EMBEDDER === 'fake';
}

async function configuredTransformers() {
  const tf = await import('@xenova/transformers');
  const dir = modelDirFromEnv();
  if (dir) tf.env.cacheDir = dir;
  if (envFlag('BRAIN_OFFLINE', 'DEVSARATHI_OFFLINE')) tf.env.allowRemoteModels = false;
  return tf;
}

async function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = configuredTransformers()
      .then(({ pipeline }) => pipeline('feature-extraction', MODEL_ID))
      .catch((err) => {
        pipelinePromise = null; // allow a retry after the user fixes connectivity / model dir
        if (envFlag('BRAIN_OFFLINE', 'DEVSARATHI_OFFLINE')) {
          throw new Error(
            `Embedding model ${MODEL_ID} is not available offline. Set BRAIN_MODEL_DIR/DEVSARATHI_MODEL_DIR to a folder that already holds it, or run once online. (${err.message})`
          );
        }
        throw err;
      });
  }
  return pipelinePromise;
}

/**
 * Downloads (or verifies) the model ahead of the first build, so a host can show its own
 * notice/progress. Returns once the model is loadable. No repo data is involved.
 */
async function prefetchModel() {
  if (useFakeEmbedder()) return { model: 'fake', cached: true };
  await getPipeline();
  return { model: MODEL_ID, cached: true };
}

// FNV-1a over character trigrams-of-words into 384 buckets, L2-normalized. Deterministic, dependency-free.
function fakeEmbed(text) {
  const vec = new Float32Array(EMBEDDING_DIM);
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const w of words) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) {
      h ^= w.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vec[(h >>> 0) % EMBEDDING_DIM] += 1;
  }
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] /= norm;
  return vec;
}

/**
 * Query-embedding memo. A single agent task tends to re-search the same
 * handful of phrases - refining a query, brain_context calling through to
 * search, the same lookup repeated after an edit - and each repeat used to
 * re-pay the full ONNX forward pass (~16ms warm, and the whole ~1.7s model
 * load if the process was cold).
 *
 * Only embedText (query side) is memoized, never embedBatch: build-time
 * embedding walks each symbol exactly once, so caching it would retain
 * every symbol body in memory for no reuse at all.
 *
 * Keyed on the exact text after whitespace normalization - semantically
 * "near-identical" is not safe to collapse, since a one-word difference is
 * exactly what the embedding is being asked to distinguish.
 */
const MAX_CACHED_QUERY_EMBEDDINGS = 256;
const queryEmbeddingCache = new Map();

function cacheKey(text) {
  return String(text).trim().replace(/\s+/g, ' ');
}

async function embedText(text) {
  if (useFakeEmbedder()) return fakeEmbed(text);

  const key = cacheKey(text);
  const cached = queryEmbeddingCache.get(key);
  if (cached) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves
    // this key to the end and keeps the eviction below a true LRU.
    queryEmbeddingCache.delete(key);
    queryEmbeddingCache.set(key, cached);
    // A copy, so a caller that mutates its vector can't corrupt the cache.
    return Float32Array.from(cached);
  }

  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  const vec = Float32Array.from(output.data);

  queryEmbeddingCache.set(key, vec);
  if (queryEmbeddingCache.size > MAX_CACHED_QUERY_EMBEDDINGS) {
    queryEmbeddingCache.delete(queryEmbeddingCache.keys().next().value);
  }
  return Float32Array.from(vec);
}

/**
 * Embeds many texts in one batched forward pass instead of one await per
 * text - transformers.js accepts an array directly and returns a single
 * tensor of shape [texts.length, EMBEDDING_DIM], which is what actually
 * makes this a batch rather than just a loop the caller doesn't see.
 */
async function embedBatch(texts) {
  if (!texts.length) return [];
  if (useFakeEmbedder()) return texts.map(fakeEmbed);
  const extractor = await getPipeline();
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(Float32Array.from(output.data.subarray(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM)));
  }
  return out;
}

module.exports = { embedText, embedBatch, prefetchModel, EMBEDDING_DIM, MODEL_ID };
