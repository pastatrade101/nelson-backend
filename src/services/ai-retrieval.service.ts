import { env } from '../config/env';
import { supabase } from '../config/supabase';

// ----------------------------------------------------------------------------
// Semantic layer (§10): pluggable embeddings + pgvector search + answer cache.
// Everything degrades gracefully — when no embedding provider/key is configured
// embedText() returns null and every helper becomes a safe no-op, so the chat
// path falls back to the deterministic Phase 2 behaviour.
// ----------------------------------------------------------------------------

export const embeddingEnabled = (): boolean => Boolean(env.AI_EMBEDDING_PROVIDER && env.AI_EMBEDDING_API_KEY);

// Never cache anything that must stay live (§10).
const VOLATILE = /(\$|usd|tzs|ksh|price|pricing|cost|per person|deposit|available|availability|\bdate\b|departure|slot|book now|discount)/i;

type EmbedResponse = { data?: Array<{ embedding?: number[] }> };

const callProvider = async (text: string): Promise<number[] | null> => {
  const provider = (env.AI_EMBEDDING_PROVIDER || '').toLowerCase();
  const key = env.AI_EMBEDDING_API_KEY;
  if (!provider || !key) return null;

  try {
    if (provider === 'voyage') {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: env.AI_EMBEDDING_MODEL || 'voyage-3', input: [text] })
      });
      const data = (await res.json().catch(() => null)) as EmbedResponse | null;
      return data?.data?.[0]?.embedding ?? null;
    }
    // default: openai-compatible
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: env.AI_EMBEDDING_MODEL || 'text-embedding-3-small', input: text })
    });
    const data = (await res.json().catch(() => null)) as EmbedResponse | null;
    return data?.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
};

/** Embed text; returns null (no-op) on any failure or dimension mismatch. */
export const embedText = async (text: string): Promise<number[] | null> => {
  if (!embeddingEnabled() || !text.trim()) return null;
  const vector = await callProvider(text.slice(0, 8000));
  if (!vector || vector.length !== env.AI_EMBEDDING_DIMENSIONS) return null;
  return vector;
};

// ── answer cache ─────────────────────────────────────────────────────────────
export type CachedAnswer = { id: string; answer: string; source: string; similarity: number };

export const lookupAnswerCache = async (query: string): Promise<CachedAnswer | null> => {
  const embedding = await embedText(query);
  if (!embedding) return null;

  let top: { id: string; answer: string; source: string; similarity: number } | undefined;
  try {
    const { data, error } = await supabase.rpc('match_answer_cache', { query_embedding: embedding, match_count: 1 });
    if (error || !Array.isArray(data) || !data.length) return null;
    top = data[0] as { id: string; answer: string; source: string; similarity: number };
  } catch {
    return null;
  }

  if (Number(top.similarity) < env.AI_SEMANTIC_CACHE_THRESHOLD) return null;
  // Best-effort hit stat — a failure here must NOT drop the cache hit.
  try {
    await supabase.from('ai_answer_cache').update({ last_hit_at: new Date().toISOString() }).eq('id', top.id);
  } catch {
    // ignore
  }
  return { id: top.id, answer: top.answer, source: top.source, similarity: Number(top.similarity) };
};

export const storeAnswerCache = async (question: string, answer: string, source = 'ai_simple'): Promise<void> => {
  if (!embeddingEnabled()) return;
  if (VOLATILE.test(question) || VOLATILE.test(answer)) return; // never cache volatile content
  const embedding = await embedText(question);
  if (!embedding) return;
  try {
    await supabase.from('ai_answer_cache').insert({ question, answer, source, question_embedding: embedding });
  } catch {
    // best effort
  }
};

// ── semantic FAQ + tour search ───────────────────────────────────────────────
const FAQ_THRESHOLD = 0.82;

export const searchFaqSemantic = async (query: string): Promise<{ sourceId: string; content: string; similarity: number } | null> => {
  const embedding = await embedText(query);
  if (!embedding) return null;
  try {
    const { data, error } = await supabase.rpc('match_cms_embeddings', { query_embedding: embedding, match_source_type: 'faq', match_count: 1 });
    if (error || !Array.isArray(data) || !data.length) return null;
    const top = data[0] as { source_id: string; content: string; similarity: number };
    if (Number(top.similarity) < FAQ_THRESHOLD) return null;
    return { sourceId: String(top.source_id), content: top.content, similarity: Number(top.similarity) };
  } catch {
    return null;
  }
};

/** tour_id -> cosine similarity (0..1) for blending into the deterministic score. */
export const semanticTourScores = async (query: string): Promise<Map<string, number>> => {
  const result = new Map<string, number>();
  const embedding = await embedText(query);
  if (!embedding) return result;
  try {
    const { data, error } = await supabase.rpc('match_cms_embeddings', { query_embedding: embedding, match_source_type: 'tour', match_count: 20 });
    if (error || !Array.isArray(data)) return result;
    for (const row of data as Array<{ source_id: string; similarity: number }>) {
      result.set(String(row.source_id), Number(row.similarity));
    }
  } catch {
    // ignore
  }
  return result;
};

// ── backfill (admin / scheduled) ─────────────────────────────────────────────
const upsertEmbedding = async (sourceType: 'tour' | 'destination' | 'faq', sourceId: string, content: string): Promise<boolean> => {
  const embedding = await embedText(content);
  if (!embedding) return false;
  try {
    await supabase.from('cms_embeddings').upsert(
      { source_type: sourceType, source_id: sourceId, content, embedding, updated_at: new Date().toISOString() },
      { onConflict: 'source_type,source_id' }
    );
    return true;
  } catch {
    return false;
  }
};

export const embedCmsContent = async (): Promise<{ embedded: number; skipped: number; enabled: boolean }> => {
  if (!embeddingEnabled()) return { embedded: 0, skipped: 0, enabled: false };
  let embedded = 0;
  let skipped = 0;

  const bump = (ok: boolean) => (ok ? (embedded += 1) : (skipped += 1));

  const { data: tours } = await supabase
    .from('tours')
    .select('id,title,short_description,persona_tags,budget_tier,destinations(name,country),tour_categories(name)')
    .eq('status', 'published')
    .is('deleted_at', null)
    .limit(500);
  for (const t of (tours ?? []) as Array<Record<string, unknown>>) {
    const dest = (Array.isArray(t.destinations) ? t.destinations[0] : t.destinations) as { name?: string; country?: string } | null;
    const cat = (Array.isArray(t.tour_categories) ? t.tour_categories[0] : t.tour_categories) as { name?: string } | null;
    const content = [t.title, t.short_description, cat?.name, dest?.name, dest?.country, (t.persona_tags as string[] | undefined)?.join(' '), t.budget_tier]
      .filter(Boolean)
      .join(' — ');
    bump(await upsertEmbedding('tour', String(t.id), content));
  }

  const { data: destinations } = await supabase.from('destinations').select('id,name,country,description,short_description').limit(500);
  for (const d of (destinations ?? []) as Array<Record<string, unknown>>) {
    const content = [d.name, d.country, d.short_description, d.description].filter(Boolean).join(' — ').slice(0, 4000);
    bump(await upsertEmbedding('destination', String(d.id), content));
  }

  const { data: faqs } = await supabase.from('faqs').select('id,question,answer').limit(500);
  for (const f of (faqs ?? []) as Array<Record<string, unknown>>) {
    const content = [f.question, f.answer].filter(Boolean).join(' — ').slice(0, 4000);
    bump(await upsertEmbedding('faq', String(f.id), content));
  }

  return { embedded, skipped, enabled: true };
};
