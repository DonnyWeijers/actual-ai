import { TransactionEntity } from '@actual-app/core/src/types/models';

// Store/terminal numbers, card reference numbers, order/kenmerk numbers: any token
// that's mostly digits and at least 3 digits long. Matches "1234", "5567", "887766",
// and mixed forms like "RSM01a07612664474019dd6".
const NUMERIC_NOISE_TOKEN = /^[a-z]*\d{3,}[a-z\d]*$/i;
// "12-09", "06.09.26", "25/09/2026" — dates in the day-first formats real bank feeds use.
const DATE_TOKEN = /^\d{1,2}[-./]\d{1,2}([-./]\d{2,4})?$/;
// Common labels around a reference/order number, in English and Dutch (the sample
// data this was built against is Dutch SEPA feeds).
const NOISE_KEYWORD_TOKEN = /^(ref|nr|no|id|kenmerk|order|omschrijving|invoice|factuur|transactie|bestelling)$/i;

function isNoiseToken(token: string): boolean {
  return NUMERIC_NOISE_TOKEN.test(token) || DATE_TOKEN.test(token) || NOISE_KEYWORD_TOKEN.test(token);
}

/**
 * Reduces a raw bank description ("ALBERT HEIJN 1234 DELFT", "IDEAL 12-09 REF
 * 887766", "SEPA iDEAL/Wero | ... | Kenmerk: 06-09-2026 12:30 815176") to its
 * merchant-identifying core: drop tokens that are dates, reference/store numbers, or
 * common noise keywords, then keep only the first few tokens that remain — real bank
 * feeds consistently put the merchant name first and the noise after. Does not strip
 * trailing city names (no gazetteer, and guessing wrong risks stripping a real word out
 * of a short merchant name) — "ALBERT HEIJN 1234 DELFT" normalizes to "albert heijn
 * delft", not "albert heijn". That's fine for this function's actual job: it only
 * needs the SAME input to normalize the SAME way, not to match the shortest possible
 * form.
 */
export function normalizeMerchantText(raw: string, maxTokens = 3): string {
  const cleaned = raw
    .replace(/[*|/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const tokens = cleaned.split(' ').filter((token) => token.length > 0 && !isNoiseToken(token));
  return tokens.slice(0, maxTokens).join(' ');
}

/**
 * Fallback run-local dedup key for a transaction Actual has NOT resolved a payee id
 * for — the payee id itself (see PayeeCategoryCache call sites) is always the
 * preferred key when available; this only covers what's left over. Built from the
 * same fields the prompt actually varies on (prompt.hbs: payee/importedPayee,
 * description, type), normalized to survive the per-transaction noise real bank
 * feeds embed in those fields.
 *
 * Deliberately excludes the raw amount: it varies per-transaction even for genuine
 * repeats (every coffee run is a different number) and would give a near-0% hit
 * rate. Transaction sign (income/outcome) is included since the prompt encodes it
 * directly ({{type}}) and it is a real semantic difference.
 *
 * Returns undefined when there's nothing stable to key on — callers must treat that
 * as "always ask the LLM," never invent a key that could collide two unrelated
 * transactions.
 */
export function deriveFallbackDedupKey(transaction: TransactionEntity): string | undefined {
  const merchantCore = transaction.imported_payee
    ? normalizeMerchantText(transaction.imported_payee)
    : '';
  const notesCore = transaction.notes
    ? normalizeMerchantText(transaction.notes, 6)
    : '';

  if (!merchantCore && !notesCore) {
    return undefined;
  }

  const sign = transaction.amount > 0 ? 'in' : 'out';
  return `${sign}|${merchantCore}|${notesCore}`;
}
