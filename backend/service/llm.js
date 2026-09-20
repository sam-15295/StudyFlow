// Shared OpenRouter client used by all three LLM agents (extractor, estimator, replan explainer).
// One model (env LLM_MODEL), always asked for strict JSON, always parsed defensively.
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Tests set retryDelayMs to 0.
const config = { retryDelayMs: 1500, timeoutMs: 60000 };

// An error that is safe to show to the user. `status` is the HTTP status the API should return.
class LlmError extends Error {
  constructor(message, { status = 502, transient = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.transient = transient; // worth retrying (rate limit, 5xx, network)
  }
}

// The model replied, but not with the JSON shape we asked for.
class BadOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadOutputError';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callModel(messages, maxTokens, timeoutMs) {
  const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
  const model = (process.env.LLM_MODEL || '').trim();
  if (!apiKey || !model) {
    throw new LlmError('LLM is not configured (OPENROUTER_API_KEY / LLM_MODEL missing)', { status: 500 });
  }

  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      // These are short structured tasks: skip "thinking" (faster, and reasoning tokens can't eat max_tokens).
      // Models without a reasoning mode ignore the field.
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens, reasoning: { enabled: false } }),
      signal: AbortSignal.timeout(timeoutMs || config.timeoutMs),
    });
  } catch (err) {
    throw new LlmError('Could not reach the AI model. Please try again.', { status: 502, transient: true });
  }

  if (res.status === 429) {
    // A per-day cap will not clear in a moment, so don't retry and don't say "try again shortly".
    const body = await res.text().catch(() => '');
    if (/per-day|daily/i.test(body)) {
      throw new LlmError(
        "The free AI model's daily request limit has been reached. Try again tomorrow, or set a different LLM_MODEL.",
        { status: 503 }
      );
    }
    throw new LlmError('The free AI model is busy (rate limited). Please try again in a moment.', {
      status: 503,
      transient: true,
    });
  }
  if (res.status >= 500) {
    throw new LlmError('The AI model is temporarily unavailable. Please try again.', { status: 502, transient: true });
  }
  if (!res.ok) {
    // 401/402/404 etc. are configuration problems; retrying won't help.
    throw new LlmError(`AI model request was rejected (HTTP ${res.status}). Check OPENROUTER_API_KEY and LLM_MODEL.`, {
      status: 502,
    });
  }

  const data = await res.json().catch(() => null);
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  return typeof content === 'string' ? content : '';
}

// Models often wrap JSON in ```json fences or add a sentence around it. Handle both.
function parseJsonLoose(text, kind) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new BadOutputError('The AI model returned an empty response');
  }
  let candidate = text.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();

  try {
    return JSON.parse(candidate);
  } catch {
    // fall through: try to cut out the outermost [...] / {...}
  }
  const open = kind === 'array' ? '[' : '{';
  const close = kind === 'array' ? ']' : '}';
  const start = candidate.indexOf(open);
  const end = candidate.lastIndexOf(close);
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  throw new BadOutputError('The AI model did not return valid JSON');
}

/**
 * Ask the model for JSON, parse it defensively and check its shape.
 *   kind:     'array' | 'object' - what top-level JSON we expect
 *   validate: (parsed) => cleanedValue; throws BadOutputError if the shape is wrong
 *   timeoutMs: optional per-request timeout (default config.timeoutMs)
 * One retry on a transient failure or a bad reply; then throws an LlmError.
 */
async function askForJson({ system, user, kind, validate, maxTokens = 4000, timeoutMs }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let lastError;

  for (let attempt = 0; attempt < 2; attempt++) {
    let text = '';
    try {
      text = await callModel(messages, maxTokens, timeoutMs);
      return validate(parseJsonLoose(text, kind));
    } catch (err) {
      const retryable = err instanceof BadOutputError || (err instanceof LlmError && err.transient);
      if (!retryable) throw err;
      lastError = err;
      if (attempt === 0) {
        if (err instanceof BadOutputError) {
          messages.push(
            { role: 'assistant', content: text || '(empty)' },
            { role: 'user', content: `That was not usable (${err.message}). Reply again with ONLY the JSON ${kind}, no prose and no code fences.` }
          );
        } else {
          await sleep(config.retryDelayMs);
        }
      }
    }
  }

  if (lastError instanceof LlmError) throw lastError;
  throw new LlmError('The AI model returned an invalid response twice. Please try again.', { status: 502 });
}

module.exports = { askForJson, parseJsonLoose, LlmError, BadOutputError, config };
