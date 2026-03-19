/**
 * Quota manager for YouTube Data API v3.
 *
 * Default quota: 10,000 units/day.
 * Read operations: ~1 unit.
 * Write operations (insert, rate, etc.): 50 units.
 */

export class QuotaExhaustedError extends Error {
  constructor(consumed: number, limit: number) {
    super(`Daily quota exhausted: ${consumed}/${limit} units used. Resume tomorrow.`);
    this.name = 'QuotaExhaustedError';
  }
}

export class QuotaManager {
  private consumed = 0;
  private readonly limit: number;

  constructor(dailyLimit?: number) {
    this.limit = dailyLimit ?? parseInt(process.env.DAILY_QUOTA_LIMIT || '9500', 10);
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.consumed);
  }

  get used(): number {
    return this.consumed;
  }

  canConsume(units: number): boolean {
    return this.consumed + units <= this.limit;
  }

  consume(units: number) {
    this.consumed += units;
  }

  assertCanConsume(units: number) {
    if (!this.canConsume(units)) {
      throw new QuotaExhaustedError(this.consumed, this.limit);
    }
  }

  summary(): string {
    return `Quota: ${this.consumed}/${this.limit} units used (${this.remaining} remaining)`;
  }
}

// ── API call wrapper with exponential backoff ────────────────────

const RETRYABLE_CODES = [429, 500, 503];

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

/**
 * Execute an API call with retry logic.
 * - On 403 quotaExceeded: throws QuotaExhaustedError immediately.
 * - On 429/5xx: retries with exponential backoff.
 * - On other errors: throws immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  quota: QuotaManager,
  unitCost: number,
  opts?: RetryOptions
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 5;
  const baseDelay = opts?.baseDelayMs ?? 1000;

  quota.assertCanConsume(unitCost);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      quota.consume(unitCost);
      return result;
    } catch (err: any) {
      const status = err?.code ?? err?.response?.status ?? err?.status;
      const reason = err?.errors?.[0]?.reason ?? err?.response?.data?.error?.errors?.[0]?.reason ?? '';

      // Quota exceeded — stop immediately
      if (status === 403 && reason === 'quotaExceeded') {
        throw new QuotaExhaustedError(quota.used, quota['limit']);
      }

      // Retryable server errors
      if (RETRYABLE_CODES.includes(status) && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        console.log(`  ⏳ Retryable error (${status}), attempt ${attempt + 1}/${maxRetries}. Waiting ${Math.round(delay)}ms...`);
        await sleep(delay);
        continue;
      }

      // Non-retryable error
      throw err;
    }
  }

  throw new Error('Max retries exceeded');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
