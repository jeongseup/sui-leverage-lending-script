/**
 * DeFi Dash SDK
 *
 * Multi-protocol DeFi SDK for Sui blockchain integrating leverage strategies,
 * flash loans, and lending protocols.
 *
 * @module defi-dash-sdk
 *
 * @example
 * ```typescript
 * import { DefiDashSDK, LendingProtocol } from 'defi-dash-sdk';
 *
 * const sdk = new DefiDashSDK();
 * await sdk.initialize(suiClient, keypair);
 *
 * // Leverage strategy
 * const result = await sdk.leverage({
 *   protocol: LendingProtocol.Suilend,
 *   depositAsset: 'LBTC',
 *   depositAmount: '0.001',
 *   multiplier: 2.0,
 *   dryRun: true
 * });
 * ```
 */

// Main SDK
export {
  DefiDashSDK,
  BrowserLeverageParams,
  BrowserDeleverageParams,
} from "./sdk";

// Types and Enums
export {
  LendingProtocol,
  LeverageParams,
  DeleverageParams,
  PositionInfo,
  AssetPosition,
  StrategyResult,
  LeveragePreview,
  SDKOptions,
  USDC_COIN_TYPE,
  SUI_COIN_TYPE,
  AccountPortfolio,
  MarketAsset,
} from "./types";

// Protocol Adapters (for advanced usage)
export { ILendingProtocol, ReserveInfo } from "./protocols/interface";
export { SuilendAdapter } from "./protocols/suilend";
export { NaviAdapter } from "./protocols/navi";

// Strategy Builders (for advanced usage)
export {
  buildLeverageTransaction,
  calculateLeveragePreview,
  buildDeleverageTransaction,
  calculateDeleverageEstimate,
} from "./strategies";

// Utilities
export * from "./lib/utils";

// Flash Loan
export { ScallopFlashLoanClient } from "./lib/scallop";

// Constants
export {
  COIN_TYPES,
  SUILEND_RESERVES,
  getReserveByCoinType,
} from "./lib/suilend/const";
