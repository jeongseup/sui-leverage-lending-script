# DeFi Dash SDK

> Multi-protocol DeFi SDK for Sui blockchain - leverage strategies, flash loans, and lending protocols

[![npm version](https://img.shields.io/npm/v/defi-dash-sdk.svg)](https://www.npmjs.com/package/defi-dash-sdk)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

## Features

- 🔧 **Utility Functions** - Token formatting, coin type normalization
- 🏦 **Protocol Wrappers** - Scallop, Suilend integration
- 🔄 **Leverage Strategies** - One-click leverage long positions
- ⚡ **Type-Safe** - Full TypeScript support

---

## Installation

```bash
npm install defi-dash-sdk
# or
yarn add defi-dash-sdk
```

---

## Quick Start

### 1. Basic Usage - Utility Functions

```typescript
import { formatUnits, parseUnits, normalizeCoinType } from 'defi-dash-sdk';

// Format token amounts
const humanReadable = formatUnits(1000000, 6); // "1" (USDC)
const rawAmount = parseUnits("1.5", 6); // 1500000n

// Normalize coin types
const normalized = normalizeCoinType("0x2::sui::SUI");
// "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
```

### 2. Using Type Definitions

```typescript
import type { MarketReserve } from 'defi-dash-sdk';

const reserve: MarketReserve = {
  coinType: "0x2::sui::SUI",
  id: "0x...",
  decimals: 9,
  symbol: "SUI"
};
```

---

## API Reference

### Utilities

#### `formatUnits(amount, decimals): string`

Converts raw token amount to human-readable format.

**Parameters:**

- `amount` - Raw amount (string | number | bigint)
- `decimals` - Token decimals (e.g., 6 for USDC, 9 for SUI)

**Returns:** Formatted string with proper decimal placement

**Example:**

```typescript
formatUnits(1500000, 6) // "1.5"
formatUnits(1000000000, 9) // "1"
```

#### `parseUnits(amount, decimals): bigint`

Converts human-readable amount to raw units.

**Parameters:**

- `amount` - Human-readable amount string
- `decimals` - Token decimals

**Returns:** Raw amount as bigint

**Example:**

```typescript
parseUnits("1.5", 6) // 1500000n
```

#### `normalizeCoinType(coinType): string`

Normalizes Sui coin type addresses (pads to 64 chars, ensures 0x prefix).

#### `formatCoinType(type): string`

Uses `normalizeStructTag` from `@mysten/sui` with fallback.

---

## Development

This package is designed for both Node.js scripts and frontend applications.

### For Testing Strategies

Clone the repo to access example scripts:

```bash
git clone https://github.com/yourusername/defi-dash-sdk.git
cd defi-dash-sdk
npm install

# Run example leverage strategy
npm run test:suilend-leverage
```

### Building from Source

```bash
npm run build  # Compiles TypeScript to dist/
```

---

## Architecture

```
defi-dash-sdk/
├── src/
│   ├── index.ts           # SDK entry point
│   └── lib/
│       ├── utils/         # Formatting & normalization
│       ├── scallop/       # Flash loan wrapper
│       └── suilend/       # Lending constants
└── tests/                 # Integration examples
```

---

## Examples

### Using in a Frontend (React/Next.js)

```typescript
import { formatUnits, normalizeCoinType } from 'defi-dash-sdk';

function TokenBalance({ amount, decimals, symbol }) {
  const formatted = formatUnits(amount, decimals);

  return <div>{formatted} {symbol}</div>;
}
```

### Using in a Node.js Script

```typescript
import { parseUnits } from 'defi-dash-sdk';

const depositAmount = parseUnits("100", 6); // 100 USDC
console.log(`Depositing: ${depositAmount} raw units`);
```

---

## Protocol Support

| Protocol    | Type              | Status         |
| ----------- | ----------------- | -------------- |
| Scallop     | Flash Loans       | ✅ Supported   |
| Suilend     | Lending/Borrowing | ✅ Supported   |
| 7k Protocol | Swap Aggregator   | ✅ Supported   |
| NAVI        | Lending           | 🚧 In Progress |

---

## Dependencies

Core dependencies (automatically installed):

- `@mysten/sui` - Sui blockchain SDK
- `@suilend/sdk` - Suilend protocol
- `@scallop-io/sui-scallop-sdk` - Scallop flash loans
- `@7kprotocol/sdk-ts` - 7k swap aggregator

---

## Contributing

Contributions are welcome! Please open an issue or PR.

---

## License

ISC

---

## Links

- [Documentation](#) (Coming Soon)
- [GitHub Repository](#)
- [Example Apps](#)
