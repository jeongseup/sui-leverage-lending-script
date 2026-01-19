# Multi-Protocol DeFi SDK - Implementation Plan

## Goal

Transform the codebase into a clean SDK with:

- **Simple API** for frontend developers
- **Multi-protocol support** (Suilend, Navi)
- **Strategy abstraction** (Leverage, Deleverage)

---

## SDK API Design

### Target Usage (Frontend)

```typescript
import { DefiDashSDK, LendingProtocol } from 'defi-dash-sdk';

// Initialize SDK
const sdk = new DefiDashSDK({
  suiClient,
  keypair,
  network: 'mainnet'
});

// Execute leverage strategy
const result = await sdk.leverage({
  protocol: LendingProtocol.Suilend, // or LendingProtocol.Navi
  depositAsset: 'LBTC',  // or coin type
  depositAmount: '0.001',
  multiplier: 2.0,
  dryRun: true
});

// Execute deleverage strategy
const result = await sdk.deleverage({
  protocol: LendingProtocol.Suilend,
  dryRun: false
});
```

---

## Architecture

```
src/
├── index.ts              # SDK entry point
├── sdk.ts                # DefiDashSDK class
├── types.ts              # Shared types & interfaces
├── strategies/
│   ├── leverage.ts       # LeverageStrategy builder
│   └── deleverage.ts     # DeleverageStrategy builder
├── protocols/
│   ├── interface.ts      # ILendingProtocol interface
│   ├── suilend.ts        # SuilendAdapter
│   └── navi.ts           # NaviAdapter
└── lib/
    ├── utils/            # Existing utilities
    ├── scallop/          # Flash loan client
    └── swap.ts           # 7k swap wrapper
```

---

## Proposed Changes

### Phase 1: Core Interfaces

#### [NEW] [src/types.ts](file:///Users/jeongseup/Workspace/Curg/sui-leverage-lending-script/src/types.ts)

#### [MODIFY] [src/protocols/interface.ts](file:///Users/jeongseup/Workspace/DefiDash/defi-dash-sdk/src/protocols/interface.ts)

Added `getMaxBorrowableAmount` and `getMaxWithdrawableAmount` to `ILendingProtocol`.

#### [MODIFY] [src/protocols/suilend.ts](file:///Users/jeongseup/Workspace/DefiDash/defi-dash-sdk/src/protocols/suilend.ts)

Implemented MaxBorrow/Withdraw logic and fixed APY calculations.

### Phase 2: Frontend Integration (Planned)

#### [MODIFY] [useDefiDash.ts](file:///Users/jeongseup/Workspace/DefiDash/frontend/src/hooks/useDefiDash.ts)

Integrate new SDK methods (`getMarkets`, `getAccountPortfolio`) to replace raw hook logic.

#### [DELETE] [useSuilend.ts](file:///Users/jeongseup/Workspace/DefiDash/frontend/src/hook/useSuilend.ts)

Remove redundant hook after migration.

```typescript
export enum LendingProtocol {
  Suilend = 'suilend',
  Navi = 'navi'
}

export interface LeverageParams {
  protocol: LendingProtocol;
  depositAsset: string;      // Symbol or coin type
  depositAmount: string;     // Human readable
  multiplier: number;        // 1.5x, 2x, etc.
  dryRun?: boolean;
}

export interface DeleverageParams {
  protocol: LendingProtocol;
  dryRun?: boolean;
}

export interface PositionInfo {
  collateral: { amount: bigint; symbol: string; valueUsd: number };
  debt: { amount: bigint; symbol: string; valueUsd: number };
  netValueUsd: number;
  healthFactor?: number;
}

export interface StrategyResult {
  success: boolean;
  txDigest?: string;
  position?: PositionInfo;
  error?: string;
}
```

---

#### [NEW] [src/protocols/interface.ts](file:///Users/jeongseup/Workspace/Curg/sui-leverage-lending-script/src/protocols/interface.ts)

```typescript
import { Transaction } from '@mysten/sui/transactions';

export interface ILendingProtocol {
  readonly name: string;

  // Initialize the protocol client
  initialize(): Promise<void>;

  // Get current position
  getPosition(userAddress: string): Promise<PositionInfo | null>;

  // Lending operations (return coin objects for PTB chaining)
  deposit(tx: Transaction, coin: any, coinType: string): void;
  withdraw(tx: Transaction, coinType: string, amount: string): Promise<any>;
  borrow(tx: Transaction, coinType: string, amount: string): Promise<any>;
  repay(tx: Transaction, coinType: string, coin: any): void;

  // Oracle refresh (protocol-specific)
  refreshOracles(tx: Transaction, coinTypes: string[]): Promise<void>;
}
```

---

### Phase 2: Protocol Adapters

#### [NEW] [src/protocols/suilend.ts](file:///Users/jeongseup/Workspace/Curg/sui-leverage-lending-script/src/protocols/suilend.ts)

Wraps `SuilendClient` with `ILendingProtocol` interface.

**Key methods:**

- `deposit()` → `suilendClient.deposit()`
- `withdraw()` → `suilendClient.withdraw()`
- `borrow()` → `suilendClient.borrow()`
- `repay()` → `suilendClient.repay()`
- `refreshOracles()` → `suilendClient.refreshAll()`

---

#### [NEW] [src/protocols/navi.ts](file:///Users/jeongseup/Workspace/Curg/sui-leverage-lending-script/src/protocols/navi.ts)

Wraps Navi SDK with `ILendingProtocol` interface.

**Key methods:**

- `deposit()` → `depositCoinPTB()`
- `withdraw()` → `withdrawCoinPTB()`
- `borrow()` → `borrowCoinPTB()`
- `repay()` → `repayCoinPTB()`
- `refreshOracles()` → `updateOraclePricesPTB()`

---

### Phase 3: Strategy Builders

#### [NEW] [src/strategies/leverage.ts](file:///Users/jeongseup/Workspace/Curg/sui-leverage-lending-script/src/strategies/leverage.ts)

```typescript
export async function buildLeverageTransaction(
  tx: Transaction,
  params: {
    protocol: ILendingProtocol,
    flashLoanClient: ScallopFlashLoanClient,
    swapClient: MetaAg,
    depositCoinType: string,
    depositAmount: bigint,
    flashLoanUsdc: bigint,
    userAddress: string,
    suiClient: SuiClient
  }
): Promise<void> {
  // 1. Flash loan USDC
  const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(tx, flashLoanUsdc, 'usdc');

  // 2. Swap USDC → deposit asset
  const quote = await swapClient.quote({...});
  const swappedAsset = await swapClient.swap({quote, coinIn: loanCoin, tx});

  // 3. Merge user's deposit with swapped asset
  // ... (handle SUI vs non-SUI)

  // 4. Refresh oracles
  await protocol.refreshOracles(tx, [depositCoinType, USDC_COIN_TYPE]);

  // 5. Deposit to lending protocol
  protocol.deposit(tx, depositCoin, depositCoinType);

  // 6. Borrow USDC to repay flash loan
  const borrowedCoin = await protocol.borrow(tx, USDC_COIN_TYPE, repaymentAmount);

  // 7. Repay flash loan
  flashLoanClient.repayFlashLoan(tx, borrowedCoin, receipt, 'usdc');
}
```

---

#### [NEW] [src/strategies/deleverage.ts](file:///Users/jeongseup/Workspace/Curg/sui-leverage-lending-script/src/strategies/deleverage.ts)

```typescript
export async function buildDeleverageTransaction(
  tx: Transaction,
  params: {
    protocol: ILendingProtocol,
    flashLoanClient: ScallopFlashLoanClient,
    swapClient: MetaAg,
    position: PositionInfo,
    userAddress: string,
    suiClient: SuiClient
  }
): Promise<void> {
  // 1. Flash loan USDC (debt amount + buffer)
  const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(tx, flashLoanUsdc, 'usdc');

  // 2. Refresh oracles
  await protocol.refreshOracles(tx, [collateralType, USDC_COIN_TYPE]);

  // 3. Repay debt using flash loan
  protocol.repay(tx, USDC_COIN_TYPE, loanCoin);

  // 4. Withdraw all collateral
  const withdrawnCoin = await protocol.withdraw(tx, collateralType, withdrawAmount);

  // 5. Swap collateral → USDC
  const swappedUsdc = await swapClient.swap({...});

  // 6. Repay flash loan
  const [repaymentCoin] = tx.splitCoins(swappedUsdc, [totalRepayment]);
  flashLoanClient.repayFlashLoan(tx, repaymentCoin, receipt, 'usdc');

  // 7. Transfer remaining to user
  tx.transferObjects([withdrawnCoin, swappedUsdc], userAddress);
}
```

---

### Phase 4: SDK Entry Point

#### [MODIFY] [src/sdk.ts](file:///Users/jeongseup/Workspace/Curg/sui-leverage-lending-script/src/sdk.ts)

```typescript
export class DefiDashSDK {
  private suiClient: SuiClient;
  private keypair: Ed25519Keypair;
  private flashLoanClient: ScallopFlashLoanClient;
  private swapClient: MetaAg;
  private protocols: Map<LendingProtocol, ILendingProtocol>;

  constructor(options: SDKOptions) { ... }

  async leverage(params: LeverageParams): Promise<StrategyResult> {
    const protocol = this.protocols.get(params.protocol);
    const tx = new Transaction();

    await buildLeverageTransaction(tx, {
      protocol,
      flashLoanClient: this.flashLoanClient,
      swapClient: this.swapClient,
      ...
    });

    if (params.dryRun) {
      return this.dryRun(tx);
    }
    return this.execute(tx);
  }

  async deleverage(params: DeleverageParams): Promise<StrategyResult> {
    // Similar pattern
  }

  async getPosition(protocol: LendingProtocol): Promise<PositionInfo | null> {
    return this.protocols.get(protocol)?.getPosition(this.userAddress);
  }
}
```

---

#### [MODIFY] [src/index.ts](file:///Users/jeongseup/Workspace/Curg/sui-leverage-lending-script/src/index.ts)

```typescript
// SDK exports
export { DefiDashSDK } from './sdk';
export { LendingProtocol } from './types';
export type { LeverageParams, DeleverageParams, PositionInfo, StrategyResult } from './types';

// Utilities
export * from './lib/utils';

// Protocol adapters (for advanced usage)
export { SuilendAdapter } from './protocols/suilend';
export { NaviAdapter } from './protocols/navi';
```

---

## File Changes Summary

| Action | Path                           | Description                    |
| ------ | ------------------------------ | ------------------------------ |
| NEW    | `src/types.ts`                 | Enums, interfaces, types       |
| NEW    | `src/sdk.ts`                   | Main SDK class                 |
| NEW    | `src/protocols/interface.ts`   | ILendingProtocol interface     |
| NEW    | `src/protocols/suilend.ts`     | Suilend adapter                |
| NEW    | `src/protocols/navi.ts`        | Navi adapter                   |
| NEW    | `src/strategies/leverage.ts`   | Leverage transaction builder   |
| NEW    | `src/strategies/deleverage.ts` | Deleverage transaction builder |
| NEW    | `src/lib/swap.ts`              | 7k swap wrapper                |
| MODIFY | `src/index.ts`                 | Update exports                 |

---

## Verification Plan

### Automated Tests

```bash
# TypeScript compilation
npm run build

# Dry-run leverage (Suilend)
npm run test:suilend-leverage

# Dry-run leverage (Navi)
npm run test:navi-leverage
```

### Manual Verification

- Verify SDK can be imported by external project
- Test dry-run for all 4 strategy combinations
