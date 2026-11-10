import Anthropic from '@anthropic-ai/sdk';

export type Block =
  | { type: 'text'; text: string }
  /** `ext`: provider-specific data that must be echoed back verbatim (Gemini 3 thought signatures). */
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; ext?: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface Msg {
  role: 'user' | 'assistant';
  content: string | Block[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMRequest {
  /** Blocks are concatenated in order; `cache: true` marks the end of the cacheable prefix. */
  system: { text: string; cache?: boolean }[];
  messages: Msg[];
  tools: ToolDef[];
  /** false = the model must answer in text (used on the last step so it can never end on a tool call). */
  allowTools: boolean;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface LLMResponse {
  content: Block[];
  stopReason: string | null;
}

/** The only seam to the model provider. Tests inject a fake; production uses Anthropic. */
export interface LLM {
  complete(req: LLMRequest, onText: (delta: string) => void): Promise<LLMResponse>;
}

export class AnthropicLLM implements LLM {
  private client: Anthropic;
  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  async complete(req: LLMRequest, onText: (delta: string) => void): Promise<LLMResponse> {
    const tools = req.tools.map((t, i) => ({
      ...t,
      // Cache breakpoint after the (static) tool list + static system prompt.
      ...(i === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: req.maxTokens,
        system: req.system.map((s) => ({ type: 'text' as const, text: s.text, ...(s.cache ? { cache_control: { type: 'ephemeral' as const } } : {}) })),
        messages: req.messages as Anthropic.MessageParam[],
        tools: tools as Anthropic.Tool[],
        ...(req.allowTools ? {} : { tool_choice: { type: 'none' as const } }),
      },
      { signal: req.signal },
    );
    stream.on('text', onText);
    const msg = await stream.finalMessage();
    const content: Block[] = [];
    for (const b of msg.content) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
    }
    return { content, stopReason: msg.stop_reason };
  }
}

/**
 * Any OpenAI-compatible chat-completions endpoint: Gemini (free tier), Groq, OpenRouter, Ollama, OpenAI.
 * Plain fetch + SSE parsing, so no extra dependency. Converts our Anthropic-shaped
 * messages/tool blocks to the OpenAI wire format and back.
 */
export class OpenAICompatLLM implements LLM {
  private models: string[];
  /** `model` may be a comma-separated fallback chain: free tiers have per-model daily quotas and busy models 503. */
  constructor(
    private apiKey: string,
    model: string,
    private baseUrl: string,
    private reasoningEffort?: string,
  ) {
    this.models = model.split(',').map((m) => m.trim()).filter(Boolean);
  }

  private toWire(req: LLMRequest): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [{ role: 'system', content: req.system.map((s) => s.text).join('\n\n') }];
    for (const m of req.messages) {
      if (typeof m.content === 'string') {
        out.push({ role: m.role, content: m.content });
        continue;
      }
      if (m.role === 'assistant') {
        const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
        const calls = m.content.filter((b) => b.type === 'tool_use') as Extract<Block, { type: 'tool_use' }>[];
        out.push({
          role: 'assistant',
          content: text || null,
          ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) }, ...(c.ext ? { extra_content: c.ext } : {}) })) } : {}),
        });
      } else {
        for (const b of m.content) {
          if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
          else if (b.type === 'text') out.push({ role: 'user', content: b.text });
        }
      }
    }
    return out;
  }

  async complete(req: LLMRequest, onText: (delta: string) => void): Promise<LLMResponse> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const wire = this.toWire(req);
    const tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    const attemptWith = (model: string) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        signal: req.signal,
        body: JSON.stringify({
          model,
          stream: true,
          max_tokens: req.maxTokens,
          messages: wire,
          tools,
          tool_choice: req.allowTools ? 'auto' : 'none',
          ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
        }),
      });

    // Per model: short backoff for transient 429/5xx. Then fall through to the next model in the chain
    // (exhausted daily quota, retired model, or sustained overload). Only the last error is surfaced.
    let res!: Response;
    for (const [i, model] of this.models.entries()) {
      res = await attemptWith(model);
      for (let attempt = 1; attempt <= 2 && (res.status === 429 || res.status >= 500); attempt++) {
        if (i < this.models.length - 1 && res.status === 429) break; // quota: no point waiting, switch model
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        res = await attemptWith(model);
      }
      const retryable = res.status === 429 || res.status === 404 || res.status >= 500;
      if (!retryable || i === this.models.length - 1) break;
    }
    if (!res.ok || !res.body) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);

    let text = '';
    let finish: string | null = null;
    const calls: { id: string; name: string; args: string; ext?: unknown }[] = [];
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk: { choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; extra_content?: unknown; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[] };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          text += choice.delta.content;
          onText(choice.delta.content);
        }
        for (const tc of choice.delta?.tool_calls ?? []) {
          // Providers differ: OpenAI/Groq stream one call split over chunks keyed by `index`;
          // Gemini sends each parallel call whole, all with index 0. A new name at an index that
          // already has one therefore means a new call.
          let cur = tc.index !== undefined ? calls[tc.index] : calls[calls.length - 1];
          if (!cur || (tc.function?.name && cur.name)) {
            cur = { id: tc.id ?? '', name: '', args: '' };
            calls.push(cur);
          }
          if (tc.id && !cur.id) cur.id = tc.id;
          if (tc.extra_content) cur.ext = tc.extra_content;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }

    const content: Block[] = [];
    if (text) content.push({ type: 'text', text });
    calls.forEach((c, n) => {
      let input: Record<string, unknown> = {};
      try {
        input = c.args ? JSON.parse(c.args) : {};
      } catch {
        /* malformed args -> empty input -> the tool reports "query is required" to the model */
      }
      content.push({ type: 'tool_use', id: c.id || `call_${Date.now()}_${n}`, name: c.name, input, ...(c.ext ? { ext: c.ext } : {}) });
    });
    return { content, stopReason: finish };
  }
}
