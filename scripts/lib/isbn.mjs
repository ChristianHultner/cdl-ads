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
// isbn13ToIsbn10 — reverse conversion
// ---------------------------------------------------------------------------

/**
 * Convert an ISBN-13 (978-prefixed EAN) to its ISBN-10 equivalent.
 *
 * Algorithm:
 *   1. Validate input matches ^978[0-9]{10}$ (13 digits, 978 prefix only).
 *   2. Extract the 9-digit root: isbn13.slice(3, 12)
 *      (drops the '978' prefix AND the isbn13 EAN check digit).
 *   3. Compute ISBN-10 check digit (mod 11):
 *        sum = Σ (10 − i) × digit[i]  for i = 0 … 8
 *        check = (11 − sum mod 11) mod 11
 *        → 'X' when check === 10, digit string otherwise.
 *   4. Return 9-digit root + check character (10 chars total).
 *
 * Returns null for any invalid / non-978-prefixed input.
 */
export function isbn13ToIsbn10(isbn13) {
  if (typeof isbn13 !== 'string') return null;
  if (!/^978[0-9]{10}$/.test(isbn13)) return null;

  const root9 = isbn13.slice(3, 12);   // 9 root digits (strips '978' prefix + isbn13 check)

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += (10 - i) * parseInt(root9[i], 10);
  }
  const check     = (11 - (sum % 11)) % 11;
  const checkChar = check === 10 ? 'X' : check.toString();

  return root9 + checkChar;
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

  // ── isbn13ToIsbn10 — round-trip the three known CDL pairs ──────────────────
  console.log('\n── isbn13ToIsbn10 ──');
  const reverseCases = [
    ['9788415241102', '8415241100'],
    ['9788416078950', '8416078955'],
    ['9788493824044', '8493824046'],
  ];

  let rpassed = 0;
  for (const [isbn13, expectedIsbn10] of reverseCases) {
    const result = isbn13ToIsbn10(isbn13);

    // Length check
    if (result === null || result.length !== 10) {
      throw new Error(`FAIL length: isbn13ToIsbn10(${isbn13}) = ${result}`);
    }
    // ISBN-10 check digit validation (Σ (10−i)×d[i] mod 11 === 0; X counts as 10)
    let ck10sum = 0;
    for (let i = 0; i < 10; i++) {
      const d = (result[i] === 'X' || result[i] === 'x') ? 10 : parseInt(result[i], 10);
      ck10sum += (10 - i) * d;
    }
    if (ck10sum % 11 !== 0) {
      throw new Error(`FAIL isbn10-check: isbn13ToIsbn10(${isbn13}) = ${result} (sum mod 11 = ${ck10sum % 11})`);
    }
    // Exact value check
    if (result !== expectedIsbn10) {
      throw new Error(`FAIL value: isbn13ToIsbn10(${isbn13}) = ${result}, expected ${expectedIsbn10}`);
    }
    // Round-trip: isbn10ToIsbn13 back to original isbn13
    const roundTrip = isbn10ToIsbn13(result);
    if (roundTrip !== isbn13) {
      throw new Error(`FAIL round-trip: isbn10ToIsbn13(isbn13ToIsbn10(${isbn13})) = ${roundTrip}, expected ${isbn13}`);
    }
    console.log(`PASS: ${isbn13} → ${result}  (round-trip: ${result} → ${roundTrip})`);
    rpassed++;
  }

  // Null / invalid input guards for isbn13ToIsbn10
  const rNullCases = [null, '', '978', '9790123456789', '97812345678901', '978123456789X', '979' + '8'.repeat(10)];
  for (const bad of rNullCases) {
    const r = isbn13ToIsbn10(bad);
    if (r !== null) throw new Error(`FAIL null-guard: isbn13ToIsbn10(${bad}) = ${r}, expected null`);
    console.log(`PASS null-guard: isbn13ToIsbn10(${JSON.stringify(bad)}) → null`);
  }

  console.log(`\nAll ${rpassed} reverse ISBN conversion assertions passed. Null-guard: ${rNullCases.length} passed.`);
}
