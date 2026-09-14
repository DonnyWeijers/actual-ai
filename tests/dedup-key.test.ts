import { normalizeMerchantText, deriveFallbackDedupKey } from '../src/transaction/dedup-key';

describe('normalizeMerchantText', () => {
  test('strips a trailing store number, keeps the rest (no city gazetteer — this is a deliberate limit, see module docstring)', () => {
    expect(normalizeMerchantText('ALBERT HEIJN 1234 DELFT')).toBe('albert heijn delft');
  });

  test('strips a trailing store number, keeps short merchant names intact', () => {
    expect(normalizeMerchantText('AH TO GO 5567')).toBe('ah to go');
  });

  test('strips asterisks used as sub-merchant separators', () => {
    expect(normalizeMerchantText('PAYPAL *SPOTIFY')).toBe('paypal spotify');
  });

  test('strips a date token and a labeled reference number', () => {
    expect(normalizeMerchantText('IDEAL 12-09 REF 887766')).toBe('ideal');
  });

  test('is case-insensitive', () => {
    expect(normalizeMerchantText('Coolblue')).toBe(normalizeMerchantText('COOLBLUE'));
  });

  test('caps at maxTokens', () => {
    expect(normalizeMerchantText('one two three four five', 3)).toBe('one two three');
  });

  test('empty input yields empty output', () => {
    expect(normalizeMerchantText('')).toBe('');
  });

  test('a string that is entirely noise yields empty output', () => {
    expect(normalizeMerchantText('12-09 887766')).toBe('');
  });
});

describe('deriveFallbackDedupKey', () => {
  test('two transactions from the same merchant with different reference noise produce the same key', () => {
    const a = deriveFallbackDedupKey({
      id: 'tx-1', account: 'acc', amount: -550, date: '2026-09-01', imported_payee: 'ALBERT HEIJN 1234 DELFT',
    });
    const b = deriveFallbackDedupKey({
      id: 'tx-2', account: 'acc', amount: -1299, date: '2026-09-05', imported_payee: 'ALBERT HEIJN 9981 DELFT',
    });
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  test('genuinely different merchants produce different keys', () => {
    const a = deriveFallbackDedupKey({
      id: 'tx-1', account: 'acc', amount: -550, date: '2026-09-01', imported_payee: 'ALBERT HEIJN 1234 DELFT',
    });
    const b = deriveFallbackDedupKey({
      id: 'tx-2', account: 'acc', amount: -550, date: '2026-09-01', imported_payee: 'COOLBLUE ROTTERDAM',
    });
    expect(a).not.toBe(b);
  });

  test('income and outcome for the same merchant text do not share a key', () => {
    const outcome = deriveFallbackDedupKey({
      id: 'tx-1', account: 'acc', amount: -550, date: '2026-09-01', imported_payee: 'WISE',
    });
    const income = deriveFallbackDedupKey({
      id: 'tx-2', account: 'acc', amount: 550, date: '2026-09-01', imported_payee: 'WISE',
    });
    expect(outcome).not.toBe(income);
  });

  test('does not key on the raw amount', () => {
    const a = deriveFallbackDedupKey({
      id: 'tx-1', account: 'acc', amount: -401, date: '2026-09-01', imported_payee: 'UBER',
    });
    const b = deriveFallbackDedupKey({
      id: 'tx-2', account: 'acc', amount: -2650, date: '2026-09-02', imported_payee: 'UBER',
    });
    expect(a).toBe(b);
  });

  test('falls back to notes when imported_payee is absent', () => {
    const key = deriveFallbackDedupKey({
      id: 'tx-1',
      account: 'acc',
      amount: -100,
      date: '2026-09-01',
      notes: 'Naam: Azerty.nl via MultiSafepay | Kenmerk: 06-09-2026 12:30 815176',
    });
    expect(key).toBeDefined();
    expect(key).toContain('azerty.nl');
  });

  test('returns undefined when there is nothing stable to key on', () => {
    const key = deriveFallbackDedupKey({
      id: 'tx-1', account: 'acc', amount: -100, date: '2026-09-01',
    });
    expect(key).toBeUndefined();
  });

  test('returns undefined when imported_payee and notes normalize to nothing', () => {
    const key = deriveFallbackDedupKey({
      id: 'tx-1', account: 'acc', amount: -100, date: '2026-09-01', imported_payee: '12-09 887766',
    });
    expect(key).toBeUndefined();
  });
});
