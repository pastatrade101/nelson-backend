import { env } from '../config/env';
import { GOLDFINCH_ADVISOR_SYSTEM_PROMPT, GOLDFINCH_ADVISOR_TOOLS } from '../prompts/goldfinch-advisor.prompt';
import { emptyUsage, type AiUsage } from './ai-usage.service';

// ----------------------------------------------------------------------------
// Raw Anthropic Messages API wrapper (§8). Backend-only — the API key never
// leaves this layer. Adds: current model IDs, prompt-cache breakpoints on the
// stable prefix (§3.2), native tool use (§3.4), and an SSE streaming helper (§3.5).
// Uses global fetch (Node 18+); no extra dependency required.
// ----------------------------------------------------------------------------

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export class AnthropicError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
  }
}

export type AnthropicRole = 'user' | 'assistant';

// content is a plain string OR an array of content blocks (text / tool_use / tool_result).
export type AnthropicMessage = {
  role: AnthropicRole;
  content: string | Array<Record<string, unknown>>;
};

export type ToolUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type AnthropicResult = {
  text: string;
  toolUses: ToolUse[];
  /** Raw assistant content blocks — needed to replay the turn in a tool loop. */
  content: Array<Record<string, unknown>>;
  stopReason: string | null;
  usage: AiUsage;
  model: string;
};

export type CreateMessageParams = {
  model: string;
  messages: AnthropicMessage[];
  /** Override the default Goldfinch system prompt if needed. */
  system?: string;
  /** Pass the Goldfinch tool set by default; set [] to disable tools. */
  tools?: ReadonlyArray<Record<string, unknown>>;
  /** Per-request context (lead/CMS/page) appended as an UNCACHED system block. */
  dynamicContext?: string;
  maxTokens?: number;
  temperature?: number;
};

const headers = (): Record<string, string> => {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AnthropicError('ANTHROPIC_API_KEY is not configured.', 503);
  }
  const base: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': env.ANTHROPIC_API_KEY,
    'anthropic-version': env.ANTHROPIC_VERSION
  };
  // 1-hour cache TTL is gated behind a beta header.
  if (env.AI_USE_PROMPT_CACHING && env.AI_PROMPT_CACHE_TTL === '1h') {
    base['anthropic-beta'] = 'extended-cache-ttl-2025-04-11';
  }
  return base;
};

/**
 * Build the `system` param as cache-marked blocks. The stable prefix (brand,
 * safety, booking rules) carries cache_control so it bills at ~10% on reuse.
 */
const buildSystem = (systemText: string, dynamicContext?: string): Array<Record<string, unknown>> => {
  const block: Record<string, unknown> = { type: 'text', text: systemText };
  if (env.AI_USE_PROMPT_CACHING) {
    block.cache_control =
      env.AI_PROMPT_CACHE_TTL === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  }
  const blocks = [block];
  // Dynamic per-request context is a SEPARATE, uncached block so the stable
  // prefix above keeps its cache breakpoint warm.
  if (dynamicContext && dynamicContext.trim()) {
    blocks.push({ type: 'text', text: dynamicContext });
  }
  return blocks;
};

/** Attach a cache breakpoint to the last tool so the tool defs cache too. */
const buildTools = (tools: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> => {
  const list = tools.map((tool) => ({ ...tool }));
  if (env.AI_USE_PROMPT_CACHING && list.length) {
    const last = list[list.length - 1];
    last.cache_control =
      env.AI_PROMPT_CACHE_TTL === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  }
  return list;
};

const buildBody = (params: CreateMessageParams, stream: boolean): Record<string, unknown> => {
  const tools = params.tools ?? GOLDFINCH_ADVISOR_TOOLS;
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.maxTokens ?? env.AI_MAX_OUTPUT_TOKENS,
    system: buildSystem(params.system ?? GOLDFINCH_ADVISOR_SYSTEM_PROMPT, params.dynamicContext),
    messages: params.messages
  };
  if (typeof params.temperature === 'number') body.temperature = params.temperature;
  if (tools.length) body.tools = buildTools(tools as ReadonlyArray<Record<string, unknown>>);
  if (stream) body.stream = true;
  return body;
};

const mapUsage = (usage: Record<string, unknown> | undefined): AiUsage => {
  if (!usage) return emptyUsage();
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    input_tokens: num(usage.input_tokens),
    output_tokens: num(usage.output_tokens),
    cache_creation_input_tokens: num(usage.cache_creation_input_tokens),
    cache_read_input_tokens: num(usage.cache_read_input_tokens)
  };
};

/** Non-streaming call. Returns assistant text + any tool_use blocks + usage. */
export const createMessage = async (params: CreateMessageParams): Promise<AnthropicResult> => {
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(buildBody(params, false))
    });
  } catch (error) {
    throw new AnthropicError(`Anthropic request failed: ${(error as Error).message}`, 502);
  }

  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !data) {
    const detail =
      data && typeof data === 'object' && 'error' in data
        ? JSON.stringify((data as { error?: unknown }).error)
        : `HTTP ${response.status}`;
    throw new AnthropicError(`Anthropic error: ${detail}`, response.status || 502);
  }

  const content = Array.isArray(data.content) ? (data.content as Array<Record<string, unknown>>) : [];
  const text = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim();
  const toolUses: ToolUse[] = content
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: String(block.id ?? ''),
      name: String(block.name ?? ''),
      input: (block.input as Record<string, unknown>) ?? {}
    }));

  return {
    text,
    toolUses,
    content,
    stopReason: typeof data.stop_reason === 'string' ? data.stop_reason : null,
    usage: mapUsage(data.usage as Record<string, unknown> | undefined),
    model: typeof data.model === 'string' ? data.model : params.model
  };
};

/**
 * Start a streaming Messages call and return the raw fetch Response. The
 * controller relays `response.body` to the client as `text/event-stream` (§3.5)
 * and accumulates token usage from the final `message_delta` / `message_stop`
 * events. Kept thin so the SSE wiring lives in the controller (Phase 2).
 */
export const streamMessage = async (params: CreateMessageParams): Promise<Response> => {
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(buildBody(params, true))
    });
  } catch (error) {
    throw new AnthropicError(`Anthropic stream failed: ${(error as Error).message}`, 502);
  }
  if (!response.ok || !response.body) {
    throw new AnthropicError(`Anthropic stream error: HTTP ${response.status}`, response.status || 502);
  }
  return response;
};

export const isAnthropicConfigured = (): boolean => Boolean(env.ANTHROPIC_API_KEY);
