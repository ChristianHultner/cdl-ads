// scripts/lib/isbn.mjs
// ISBN-10 → ISBN-13 (EAN-13/978) conversion for cdl-ads title-cache sync.

/**
 * Convert an ISBN-10 to its ISBN-13 equivalent.
 *
 * Algorithm:
 *   1. Validate input matches ^[0-9]{9}[0-9Xx]$
 *   2. Drop the ISBN-10 check digit (last char), keep the 9-digit root.
 *   3. Prepend '978' → 12-digit string.
 *   4. Compute EAN-13 check digit:
 *        sum = Σ digit[i] * weight[i]  (weight alternates 1, 3 across positions 0-11)
 *        check = (10 - sum mod 10) mod 10
 *   5. Return 12-digit string + check digit (13 chars total).
 *
 * Returns null for any invalid / non-ISBN-10 input.
 */
export function isbn10ToIsbn13(isbn10) {
  if (typeof isbn10 !== 'string') return null;
  if (!/^[0-9]{9}[0-9Xx]$/.test(isbn10)) return null;

  const root9 = isbn10.slice(0, 9);          // 9 root digits
  const prefix = '978' + root9;              // 12-digit EAN base

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const weight = i % 2 === 0 ? 1 : 3;
    sum += parseInt(prefix[i], 10) * weight;
  }
  const check = (10 - (sum % 10)) % 10;

  return prefix + check.toString();
}

// ---------------------------------------------------------------------------
// Self-test — run with: node scripts/lib/isbn.mjs --test
// ---------------------------------------------------------------------------
if (process.argv.includes('--test')) {
  // Known CDL ISBN-10 → ISBN-13 pairs (verified externally):
  //   8415241100 → 9788415241102
  //   8416078955 → 9788416078950
  //   8493824046 → 9788493824044
  const cases = [
    ['8415241100', '9788415241102'],
    ['8416078955', '9788416078950'],
    ['8493824046', '9788493824044'],
  ];

  let passed = 0;
  for (const [isbn10, expectedIsbn13] of cases) {
    const result = isbn10ToIsbn13(isbn10);

    // Length check
    if (result === null || result.length !== 13) {
      throw new Error(`FAIL length: isbn10ToIsbn13(${isbn10}) = ${result}`);
    }
    // Prefix check
    if (!result.startsWith('978')) {
      throw new Error(`FAIL prefix: isbn10ToIsbn13(${isbn10}) = ${result}`);
    }
    // EAN-13 check digit validation
    let sum = 0;
    for (let i = 0; i < 13; i++) {
      sum += parseInt(result[i], 10) * (i % 2 === 0 ? 1 : 3);
    }
    if (sum % 10 !== 0) {
      throw new Error(`FAIL ean13-check: isbn10ToIsbn13(${isbn10}) = ${result} (sum mod 10 = ${sum % 10})`);
    }
    // Exact value check
    if (result !== expectedIsbn13) {
      throw new Error(`FAIL value: isbn10ToIsbn13(${isbn10}) = ${result}, expected ${expectedIsbn13}`);
    }

    console.log(`PASS: ${isbn10} → ${result}`);
    passed++;
  }

  // Null / invalid input guards
  const nullCases = [null, '', '123', 'B00EXAMPLE', '123456789X1', '123456789!'];
  for (const bad of nullCases) {
    const r = isbn10ToIsbn13(bad);
    if (r !== null) throw new Error(`FAIL null-guard: isbn10ToIsbn13(${bad}) = ${r}, expected null`);
    console.log(`PASS null-guard: isbn10ToIsbn13(${JSON.stringify(bad)}) → null`);
  }

  console.log(`\nAll ${passed} ISBN conversion assertions passed. Null-guard: ${nullCases.length} passed.`);
}
