/**
 * DeFi Dash SDK - Lending Protocol Interface
 *
 * Abstract interface for lending protocols (Suilend, Navi, etc.)
 */

import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { PositionInfo, MarketAsset, AccountPortfolio } from "../types";

/**
 * Common interface for all lending protocol adapters
 */
export interface ILendingProtocol {
  /** Protocol name identifier */
  readonly name: string;

  /**
   * Whether the protocol's repay function consumes the entire coin
   * - true: repay() consumes the coin entirely (e.g., Navi)
   * - false: repay() returns unused portion in the coin (e.g., Suilend)
   */
  readonly consumesRepaymentCoin: boolean;

  /**
   * Initialize the protocol client
   * Must be called before using other methods
   */
  initialize(suiClient: SuiClient): Promise<void>;

  /**
   * Get current lending position for a user
   * @param userAddress - Sui address of the user
   * @returns Position info or null if no position exists
   */
  getPosition(userAddress: string): Promise<PositionInfo | null>;

  /**
   * Check if user has an existing obligation/position
   * @param userAddress - Sui address of the user
   */
  hasPosition(userAddress: string): Promise<boolean>;

  /**
   * Deposit collateral into the lending protocol
   * @param tx - Transaction to add deposit command to
   * @param coin - Coin object to deposit
   * @param coinType - Full coin type string
   * @param userAddress - User's address (for obligation lookup)
   */
  deposit(
    tx: Transaction,
    coin: any,
    coinType: string,
    userAddress: string,
  ): Promise<void>;

  /**
   * Withdraw collateral from the lending protocol
   * @param tx - Transaction to add withdraw command to
   * @param coinType - Full coin type string
   * @param amount - Amount to withdraw (raw units as string)
   * @param userAddress - User's address
   * @returns Withdrawn coin object
   */
  withdraw(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
  ): Promise<any>;

  /**
   * Borrow from the lending protocol
   * @param tx - Transaction to add borrow command to
   * @param coinType - Full coin type string (e.g., USDC)
   * @param amount - Amount to borrow (raw units as string)
   * @param userAddress - User's address
   * @param skipOracle - Skip oracle refresh (if already done)
   * @returns Borrowed coin object
   */
  borrow(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
    skipOracle?: boolean,
  ): Promise<any>;

  /**
   * Repay debt to the lending protocol
   * @param tx - Transaction to add repay command to
   * @param coinType - Full coin type string
   * @param coin - Coin object to use for repayment
   * @param userAddress - User's address
   */
  repay(
    tx: Transaction,
    coinType: string,
    coin: any,
    userAddress: string,
  ): Promise<void>;

  /**
   * Refresh oracle prices (protocol-specific)
   * Must be called before deposit/borrow operations
   * @param tx - Transaction to add refresh commands to
   * @param coinTypes - Coin types to refresh oracles for
   * @param userAddress - User's address (for obligation lookup)
   */
  refreshOracles(
    tx: Transaction,
    coinTypes: string[],
    userAddress: string,
  ): Promise<void>;

  /**
   * Get reserve/pool info for a coin type
   * @param coinType - Full coin type string
   * @returns Reserve info or undefined
   */
  getReserveInfo(coinType: string): Promise<ReserveInfo | undefined>;

  /**
   * Fetch all market data for the protocol
   */
  getMarkets(): Promise<MarketAsset[]>;

  /**
   * Fetch aggregated account portfolio
   * @param address - User address
   */
  getAccountPortfolio(address: string): Promise<AccountPortfolio>;

  /**
   * Calculate max borrowable amount for an asset
   * @param address - User address
   * @param coinType - Coin type using full address
   */
  getMaxBorrowableAmount(address: string, coinType: string): Promise<string>;

  /**
   * Calculate max withdrawable amount for an asset
   * @param address - User address
   * @param coinType - Coin type using full address
   */
  getMaxWithdrawableAmount(address: string, coinType: string): Promise<string>;
}

/**
 * Reserve/Pool information
 */
export interface ReserveInfo {
  /** Coin type */
  coinType: string;

  /** Token symbol */
  symbol: string;

  /** Token decimals */
  decimals: number;

  /** Reserve/Pool ID */
  id?: string;

  /** Open LTV (loan-to-value) percentage */
  openLtvPct?: number;

  /** Close LTV (liquidation threshold) percentage */
  closeLtvPct?: number;

  /** Current deposit APY */
  depositApy?: number;

  /** Current borrow APY */
  borrowApy?: number;
}
