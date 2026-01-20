// ============================================================================
// Enums
// ============================================================================

export type PositionSide = "supply" | "borrow";

/**
 * Supported lending protocols
 */
export enum LendingProtocol {
  Suilend = "suilend",
  Navi = "navi",
}

// ============================================================================
// Strategy Parameters
// ============================================================================

/**
 * Parameters for leverage strategy
 */
export interface LeverageParams {
  /** Target lending protocol */
  protocol: LendingProtocol;

  /** Asset to deposit as collateral (symbol like 'LBTC' or full coin type) */
  depositAsset: string;

  /** Amount to deposit (human-readable, e.g., "0.001") */
  depositAmount: string;

  /** Leverage multiplier (e.g., 1.5, 2.0, 3.0) */
  multiplier: number;

  /** If true, only simulate the transaction */
  dryRun?: boolean;
}

/**
 * Parameters for deleverage strategy
 */
export interface DeleverageParams {
  /** Target lending protocol to close position on */
  protocol: LendingProtocol;

  /** If true, only simulate the transaction */
  dryRun?: boolean;
}

// ============================================================================
// Position Info
// ============================================================================

/**
 * Asset position details
 */
export interface AssetPosition {
  /** Raw amount in token units */
  amount: bigint;

  /** Token symbol (e.g., "LBTC", "USDC") */
  symbol: string;

  /** Coin type (full address) */
  coinType: string;

  /** Token decimals */
  decimals: number;

  /** USD value */
  valueUsd: number;
}

/**
 * Current lending position information
 */
export interface PositionInfo {
  /** Collateral (supply) position */
  collateral: AssetPosition;

  /** Debt (borrow) position */
  debt: AssetPosition;

  /** Net value in USD (collateral - debt) */
  netValueUsd: number;

  /** Health factor (> 1 is safe, < 1 is liquidatable) */
  healthFactor?: number;

  /** Current LTV percentage */
  ltvPercent?: number;

  /** Liquidation price of collateral */
  liquidationPrice?: number;

  /** Total deposited USD */
  totalDepositedUsd?: number;

  /** Weighted borrows USD (for health factor calculation) */
  weightedBorrowsUsd?: number;

  /** Borrow limit USD */
  borrowLimitUsd?: number;

  /** Liquidation threshold USD */
  liquidationThresholdUsd?: number;
}

// ============================================================================
// Strategy Results
// ============================================================================

/**
 * Result of strategy execution
 */
export interface StrategyResult {
  /** Whether the strategy succeeded */
  success: boolean;

  /** Transaction digest (if executed) */
  txDigest?: string;

  /** Resulting position info */
  position?: PositionInfo;

  /** Gas used (in MIST) */
  gasUsed?: bigint;

  /** Error message (if failed) */
  error?: string;
}

/**
 * Preview of leverage position before execution
 */
export interface LeveragePreview {
  /** Initial deposit value in USD */
  initialEquityUsd: number;

  /** Flash loan amount in USDC */
  flashLoanUsdc: bigint;

  /** Total position value after leverage */
  totalPositionUsd: number;

  /** Total debt in USD */
  debtUsd: number;

  /** Effective multiplier achieved */
  effectiveMultiplier: number;

  /** Position LTV percentage */
  ltvPercent: number;

  /** Estimated liquidation price */
  liquidationPrice: number;

  /** Price drop buffer before liquidation */
  priceDropBuffer: number;
}

// ============================================================================
// SDK Configuration
// ============================================================================

/**
 * SDK initialization options
 */
export interface SDKOptions {
  /** Sui RPC URL (defaults to mainnet) */
  rpcUrl?: string;

  /** Network environment */
  network?: "mainnet" | "testnet";

  /** 7k Protocol partner address (optional) */
  swapPartner?: string;
}

// ============================================================================
// Constants
// ============================================================================

export const USDC_COIN_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

export const SUI_COIN_TYPE =
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

export const DEFAULT_7K_PARTNER =
  "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf";

// End of types

// ============================================================================
// Aggregated Data Types
// ============================================================================

/**
 * Market data for a single asset
 */
export interface MarketAsset {
  symbol: string;
  coinType: string;
  decimals: number;
  price: number;
  supplyApy: number; // Percentage (e.g., 5.5)
  borrowApy: number; // Percentage (e.g., 8.0)
  maxLtv: number;
  liquidationThreshold: number;
  totalSupply: number;
  totalBorrow: number;
  availableLiquidity: number;
}

/**
 * User position for a single asset (Supply or Borrow)
 */
export interface Position {
  protocol: LendingProtocol;
  coinType: string;
  symbol: string;
  side: PositionSide;
  amount: number;
  /** Raw on-chain amount */
  amountRaw?: string;
  valueUsd: number;
  apy: number;
  /** Rewards APY component */
  rewardsApy?: number;
  /** Earned rewards details */
  rewards?: { symbol: string; amount: number; valueUsd?: number }[];
  /** Estimated liquidation price for collateral (if supply side) */
  estimatedLiquidationPrice?: number;
}

/**
 * Aggregated account portfolio for a protocol
 */
export interface AccountPortfolio {
  protocol: LendingProtocol;
  address: string;
  healthFactor: number;

  netValueUsd: number;
  totalCollateralUsd: number;
  totalDebtUsd: number;

  /** Total deposited USD */
  totalDepositedUsd?: number;

  /** Weighted borrows USD (for health factor calculation) */
  weightedBorrowsUsd?: number;

  /** Borrow limit USD */
  borrowLimitUsd?: number;

  /** Liquidation threshold USD */
  liquidationThresholdUsd?: number;

  positions: Position[];

  /** Net APY on Equity (Annualized return % on net value) */
  netApy?: number;

  /** Estimated Annual Net Earnings in USD */
  totalAnnualNetEarningsUsd?: number;
}
