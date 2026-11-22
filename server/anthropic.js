// Claude for the local APIs that use it (receipts, monthly review): a client when credentials exist, and the
// SDK's errors as answers the page can show. The SDK is imported only when the server starts, never by the build.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from './http.js';

export const MODEL = 'claude-opus-5-5';

// Why a feature that uses Claude is off, for the page to show
export const notConfigured = (feature) => `${feature} needs an Anthropic API key: add ANTHROPIC_API_KEY to .env.local and restart the server.`;

// An Anthropic client, or null without credentials: ANTHROPIC_API_KEY (from .env.local or the environment), or
// an `ant auth login` profile, which the SDK finds on its own
const PROFILE_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'anthropic');
export async function anthropicClient(vars) {
  const apiKey = vars.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey && !process.env.ANTHROPIC_AUTH_TOKEN && !existsSync(PROFILE_DIR)) return null;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic(apiKey ? { apiKey } : {});
}

// The Anthropic SDK's errors as answers the page can show; anything else passes through
export async function asApiError(err) {
  if (err instanceof ApiError) return err;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ApiError('ANTHROPIC_AUTH', 'Anthropic rejected the API key. Check ANTHROPIC_API_KEY in .env.local.', 502);
  }
  if (err instanceof Anthropic.RateLimitError) return new ApiError('RATE_LIMITED', 'Claude is busy right now. Try again in a minute.', 503);
  if (err instanceof Anthropic.APIConnectionError) return new ApiError('ANTHROPIC_UNREACHABLE', "Couldn't reach Claude. Check the internet connection.", 502);
  if (err instanceof Anthropic.APIError) return new ApiError('ANTHROPIC_ERROR', `Claude returned an error: ${err.message}`, 502);
  return err;
}

// One structured-output request: low effort, and if the model declines, the API retries on a fallback model
// inside the same request. Returns the parsed object, or throws REFUSED / UNREADABLE with `fallbackHint`.
export async function parseWithClaude(client, { system, content, format, fallbackHint }) {
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format },
    system,
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') throw new ApiError('REFUSED', `Claude declined. ${fallbackHint}`, 422);
  if (!response.parsed_output) throw new ApiError('UNREADABLE', `Claude's answer couldn't be read. ${fallbackHint}`, 422);
  return { ...response.parsed_output, model: response.model };
}
