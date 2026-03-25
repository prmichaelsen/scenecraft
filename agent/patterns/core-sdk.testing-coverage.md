# Pattern: Test Coverage

**Category**: Testing
**Created**: 2026-02-27
**Status**: Active

---

## Overview

The Coverage pattern establishes how to configure Jest coverage collection, set meaningful thresholds, generate reports, and enforce coverage in CI. Coverage is configured in `jest.config.js` and collected only from source files, excluding spec files and generated code.

## Problem Statement

Without a coverage strategy:
- Teams don't know which code paths are untested
- Coverage can drop silently as new code is added
- CI doesn't enforce coverage requirements
- Generated reports are cluttered with non-production code

## Solution

Configure coverage collection scoped to source files in `jest.config.js`, set per-threshold requirements appropriate to the codebase maturity, and run coverage checks in CI using `jest --coverage`.

## Implementation

### jest.config.js with Coverage

```javascript
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.spec.ts'],
  clearMocks: true,
  restoreMocks: true,

  // --- Coverage configuration ---

  // Collect from source, not test files
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',          // exclude test files
    '!src/**/*.fixtures.ts',      // exclude fixture helpers
    '!src/**/*.mock.ts',          // exclude mock helpers
    '!src/**/index.ts',           // exclude barrel exports
    '!src/types/**',              // exclude type-only files
    '!src/**/*.d.ts',             // exclude declaration files
  ],

  // Enforce minimum thresholds — build fails if below
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 85,
      lines: 85,
      statements: 85,
    },
    // Per-file overrides for critical modules
    './src/services/payment.service.ts': {
      branches: 95,
      functions: 100,
      lines: 95,
      statements: 95,
    },
  },

  // Output formats
  coverageReporters: [
    'text',          // console summary
    'text-summary',  // compact console output
    'lcov',          // for CI/Codecov/SonarQube
    'html',          // local browsing: coverage/index.html
  ],

  // Output directory
  coverageDirectory: 'coverage',
};
```

### Running Coverage

```bash
# Run all tests with coverage (respects collectCoverageFrom)
npx jest --coverage

# Run coverage for a specific file
npx jest --coverage --collectCoverageFrom='src/services/user.service.ts' \
  src/services/user.service.spec.ts

# Watch mode with coverage (useful during development)
npx jest --coverage --watch

# CI: fail if below threshold, output lcov for upload
npx jest --coverage --ci
```

### package.json Scripts

```json
{
  "scripts": {
    "test": "jest",
    "test:coverage": "jest --coverage",
    "test:ci": "jest --coverage --ci --forceExit",
    "test:integration": "jest --config jest.integration.config.js"
  }
}
```

### Coverage Report Output

```
----------------------|---------|----------|---------|---------|
File                  | % Stmts | % Branch | % Funcs | % Lines |
----------------------|---------|----------|---------|---------|
All files             |   87.34 |    82.10 |   90.00 |   87.34 |
 services/            |         |          |         |         |
  user.service.ts     |   92.31 |    88.46 |  100.00 |   92.31 |
  product.service.ts  |   84.21 |    78.57 |   85.71 |   84.21 |
 adapters/            |         |          |         |         |
  rest.adapter.ts     |   88.00 |    80.00 |   90.00 |   88.00 |
----------------------|---------|----------|---------|---------|
```

### Excluding Specific Lines

```typescript
// Use Istanbul ignore comments sparingly — only for truly untestable paths
// istanbul ignore next
function unreachableCodePath() {
  throw new Error('This should never happen');
}

// Ignore a branch
const result = condition
  /* istanbul ignore next */
  ? fallbackValue
  : computedValue;

// Ignore a whole function (use sparingly)
/* istanbul ignore next */
function debugOnlyHelper() { ... }
```

### CI Integration (GitHub Actions)

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run tests with coverage
        run: npm run test:ci

      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v4
        with:
          file: ./coverage/lcov.info
          fail_ci_if_error: true
```

### Gradual Coverage Improvement

```javascript
// jest.config.js — start with achievable thresholds, raise over time
coverageThreshold: {
  global: {
    // Phase 1: baseline (add as you increase)
    branches: 60,   // → 70 → 80 → 90
    functions: 70,  // → 80 → 90 → 100
    lines: 70,      // → 80 → 90
    statements: 70, // → 80 → 90
  },
},
```

### Viewing Coverage Locally

```bash
# Generate HTML report
npx jest --coverage

# Open in browser (macOS)
open coverage/index.html

# Open in browser (Linux)
xdg-open coverage/index.html
```

The HTML report shows line-by-line coverage with:
- Green: covered lines
- Red: uncovered lines
- Yellow: partially covered branches

## Usage Guidelines

### When to Use

- ✅ All projects — coverage should always be configured
- ✅ CI pipelines — enforce thresholds on every PR
- ✅ Critical business logic — set higher per-file thresholds
- ✅ After adding new services — verify new code is tested

### When Not to Use

- ❌ 100% coverage as the goal — diminishing returns, encourages bad tests
- ❌ Chasing coverage by writing trivial tests for getters/setters

## Best Practices

1. **Exclude non-production files**: Fixtures, mocks, type files, barrel exports
2. **Start achievable, raise gradually**: Begin at 70%, increase as tests grow
3. **Higher thresholds for critical code**: Payment, auth, data processing
4. **Use `lcov` for CI**: Integrates with Codecov, SonarQube, GitHub PR annotations
5. **Don't add ignores to hit thresholds**: Fix tests instead
6. **Review the HTML report**: Numbers alone don't show which paths are missed

```javascript
// Good: Meaningful threshold on critical service
'./src/services/payment.service.ts': {
  branches: 95,
  lines: 95,
},

// Bad: Blanket 100% forces trivial tests
global: { branches: 100, functions: 100, lines: 100 },
```

## Anti-Patterns

### ❌ Collecting Coverage from Test Files

```javascript
// Bad: Inflates coverage numbers meaninglessly
collectCoverageFrom: ['src/**/*.ts'], // includes *.spec.ts

// Good: Exclude test infrastructure
collectCoverageFrom: [
  'src/**/*.ts',
  '!src/**/*.spec.ts',
  '!src/**/*.fixtures.ts',
],
```

### ❌ Istanbul Ignore Abuse

```typescript
// Bad: Hiding untested code instead of writing tests
/* istanbul ignore next */
async function processPayment(data: PaymentData) {
  // 80 lines of untested payment logic
}
```

### ❌ No CI Enforcement

```bash
# Bad: Coverage runs locally but not in CI
npm test        # CI script — no coverage check

# Good: CI enforces thresholds
npm run test:ci # jest --coverage --ci
```

## Related Patterns

- [Unit Testing](core-sdk.testing-unit.md) - jest.config.js base configuration
- [Integration Testing](core-sdk.testing-integration.md) - Separate coverage runs
- [Mocks and Stubs](core-sdk.testing-mocks.md) - Mocks enable coverage of error paths

---

**Status**: Active
**Recommendation**: Configure coverage from day one. Collect only from `src/**/*.ts`, exclude fixtures and mocks, and enforce thresholds in CI with `jest --coverage --ci`.
