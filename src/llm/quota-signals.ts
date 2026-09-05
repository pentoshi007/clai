import { ProviderError } from "./http.js";

export function providerErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: unknown }).body ?? "")
      : "";
  return body ? `${message}\n${body}` : message;
}

const QUOTA_EXHAUSTION_RE =
  /quota(?:\s+has been)?\s+exhausted|exceeded your current quota|insufficient[_ ]quota|insufficient (?:credits|balance|funds)|out of credits|no credits(?: remaining)?|credit balance(?: is)? too low|payment required|balance is 0|top up to continue|quota exceeded|usage limit(?: has been)?(?: reached| exceeded)|billing(?:\s+hard)?\s+limit|free(?: tier)? quota|plan(?: and|\/| )billing|resource[_ ]has been exhausted|resource[_ ]exhausted/i;

const RATE_LIMIT_SIGNAL_RE =
  /rate.?limit(?:ed|ing)?(?:\s+(?:exceeded|reached|hit))?|too many requests|throttl(?:ed|ing|e)|requests? per (?:second|minute|hour|day)|tokens? per (?:minute|day)|\b429\b/i;

export function mentionsQuotaExhaustion(error: unknown): boolean {
  return QUOTA_EXHAUSTION_RE.test(providerErrorText(error));
}

export function mentionsRateLimit(error: unknown): boolean {
  if (error instanceof ProviderError && error.status === 429) return true;
  return RATE_LIMIT_SIGNAL_RE.test(providerErrorText(error));
}

export function quotaOrRateLimited(error: unknown): boolean {
  return mentionsQuotaExhaustion(error) || mentionsRateLimit(error);
}
