import { env } from '../config/env.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export function isAiConfigured(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

export class AnthropicError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AnthropicError';
  }
}

interface GenerateArgs {
  system: string;
  user: string;
  maxTokens?: number;
}

export async function generateText({ system, user, maxTokens }: GenerateArgs): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AnthropicError('Anthropic API key is not configured', 503);
  }

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL,
        max_tokens: maxTokens ?? env.ANTHROPIC_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new AnthropicError(`Anthropic request failed: ${reason}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AnthropicError(
      `Anthropic responded ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      res.status,
    );
  }

  const data = (await res.json().catch(() => null)) as {
    content?: Array<{ type?: string; text?: string }>;
  } | null;

  const text = (data?.content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();

  if (!text) throw new AnthropicError('Anthropic returned an empty completion');
  return cleanup(text);
}

function cleanup(text: string): string {
  let out = text.trim();
  const fence = out.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence?.[1]) out = fence[1].trim();
  if (out.length >= 2 && out.startsWith('"') && out.endsWith('"')) {
    out = out.slice(1, -1).trim();
  }
  return out;
}
