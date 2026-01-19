/**
 * DeFi Dash SDK - Main SDK Class
 *
 * Multi-protocol DeFi SDK for Sui blockchain
 * Supports both Node.js (with keypair) and Browser (with wallet adapter)
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";

import {
  LendingProtocol,
  LeverageParams,
  DeleverageParams,
  PositionInfo,
  StrategyResult,
  LeveragePreview,
  SDKOptions,
  USDC_COIN_TYPE,
  DEFAULT_7K_PARTNER,
  MarketAsset,
  AccountPortfolio,
} from "./types";

import { ILendingProtocol } from "./protocols/interface";
import { SuilendAdapter } from "./protocols/suilend";
import { NaviAdapter } from "./protocols/navi";
import { ScallopFlashLoanClient } from "./lib/scallop";
import {
  buildLeverageTransaction as buildLeverageTx,
  calculateLeveragePreview as calcPreview,
} from "./strategies/leverage";
import {
  buildDeleverageTransaction as buildDeleverageTx,
  calculateDeleverageEstimate,
} from "./strategies/deleverage";
import { normalizeCoinType, parseUnits } from "./lib/utils";
import { getReserveByCoinType, COIN_TYPES } from "./lib/suilend/const";

/**
 * Browser-compatible Leverage Parameters (no dryRun - handled externally)
 */
export interface BrowserLeverageParams {
  protocol: LendingProtocol;
  depositAsset: string;
  depositAmount: string;
  multiplier: number;
}

/**
 * Browser-compatible Deleverage Parameters
 */
export interface BrowserDeleverageParams {
  protocol: LendingProtocol;
}

/**
 * DeFi Dash SDK - Main entry point
 *
 * @example Node.js usage:
 * ```typescript
 * const sdk = new DefiDashSDK();
 * await sdk.initialize(suiClient, keypair);
 * const result = await sdk.leverage({ protocol: LendingProtocol.Suilend, ... });
 * ```
 *
 * @example Browser usage:
 * ```typescript
 * const sdk = new DefiDashSDK();
 * await sdk.initialize(suiClient, userAddress);  // No keypair needed
 *
 * const tx = new Transaction();
 * tx.setSender(userAddress);
 * await sdk.buildLeverageTransaction(tx, { protocol, depositAsset, ... });
 *
 * // Sign with wallet adapter
 * await signAndExecute({ transaction: tx });
 * ```
 */
export class DefiDashSDK {
  private suiClient!: SuiClient;
  private keypair?: Ed25519Keypair; // Optional for browser
  private _userAddress?: string; // For browser mode
  private flashLoanClient!: ScallopFlashLoanClient;
  private swapClient!: MetaAg;
  private protocols: Map<LendingProtocol, ILendingProtocol> = new Map();
  private initialized = false;
  private options: SDKOptions;

  constructor(options: SDKOptions = {}) {
    this.options = options;
  }

  /**
   * Initialize the SDK
   *
   * @param suiClient - Sui client instance
   * @param keypairOrAddress - Ed25519Keypair (Node.js) or user address string (Browser)
   *
   * @example Node.js
   * ```typescript
   * await sdk.initialize(suiClient, keypair);
   * ```
   *
   * @example Browser
   * ```typescript
   * await sdk.initialize(suiClient, account.address);
   * ```
   */
  async initialize(
    suiClient: SuiClient,
    keypairOrAddress: Ed25519Keypair | string,
  ): Promise<void> {
    this.suiClient = suiClient;

    // Detect if keypair or address
    if (typeof keypairOrAddress === "string") {
      // Browser mode: address only
      this._userAddress = keypairOrAddress;
    } else {
      // Node.js mode: keypair
      this.keypair = keypairOrAddress;
      this._userAddress = keypairOrAddress.getPublicKey().toSuiAddress();
    }

    // Initialize flash loan client
    this.flashLoanClient = new ScallopFlashLoanClient();

    // Initialize swap client
    this.swapClient = new MetaAg({
      partner: this.options.swapPartner || DEFAULT_7K_PARTNER,
    });

    // Initialize protocol adapters
    const suilend = new SuilendAdapter();
    await suilend.initialize(suiClient);
    this.protocols.set(LendingProtocol.Suilend, suilend);

    const navi = new NaviAdapter();
    await navi.initialize(suiClient);
    this.protocols.set(LendingProtocol.Navi, navi);

    this.initialized = true;
  }

  private ensureInitialized() {
    if (!this.initialized) {
      throw new Error("SDK not initialized. Call initialize() first.");
    }
  }

  private getProtocol(protocol: LendingProtocol): ILendingProtocol {
    const adapter = this.protocols.get(protocol);
    if (!adapter) {
      throw new Error(`Protocol ${protocol} not supported`);
    }
    return adapter;
  }

  private get userAddress(): string {
    if (!this._userAddress) {
      throw new Error("User address not set. Call initialize() first.");
    }
    return this._userAddress;
  }

  /**
   * Resolve asset symbol to coin type
   */
  private resolveCoinType(asset: string): string {
    // If already a full coin type, normalize it
    if (asset.includes("::")) {
      return normalizeCoinType(asset);
    }

    // Look up by symbol
    const upperSymbol = asset.toUpperCase();
    const coinType = (COIN_TYPES as any)[upperSymbol];
    if (coinType) {
      return normalizeCoinType(coinType);
    }

    throw new Error(`Unknown asset symbol: ${asset}`);
  }

  // ============================================================================
  // Browser-Compatible Transaction Builder Methods
  // ============================================================================

  /**
   * Build leverage transaction (Browser-compatible)
   *
   * Builds the transaction but does NOT execute it.
   * Use with wallet adapter's signAndExecute.
   *
   * @param tx - Transaction to add commands to
   * @param params - Leverage parameters
   *
   * @example
   * ```typescript
   * const tx = new Transaction();
   * tx.setSender(account.address);
   * tx.setGasBudget(200_000_000);
   *
   * await sdk.buildLeverageTransaction(tx, {
   *   protocol: LendingProtocol.Suilend,
   *   depositAsset: 'LBTC',
   *   depositAmount: '0.001',
   *   multiplier: 2.0,
   * });
   *
   * await signAndExecute({ transaction: tx });
   * ```
   */
  async buildLeverageTransaction(
    tx: Transaction,
    params: BrowserLeverageParams,
  ): Promise<void> {
    this.ensureInitialized();

    const protocol = this.getProtocol(params.protocol);
    const coinType = this.resolveCoinType(params.depositAsset);
    const reserve = getReserveByCoinType(coinType);
    const decimals = reserve?.decimals || 8;
    const depositAmount = parseUnits(params.depositAmount, decimals);

    await buildLeverageTx(tx, {
      protocol,
      flashLoanClient: this.flashLoanClient,
      swapClient: this.swapClient,
      suiClient: this.suiClient,
      userAddress: this.userAddress,
      depositCoinType: coinType,
      depositAmount,
      multiplier: params.multiplier,
    });
  }

  /**
   * Build deleverage transaction (Browser-compatible)
   *
   * Builds the transaction but does NOT execute it.
   * Use with wallet adapter's signAndExecute.
   *
   * @param tx - Transaction to add commands to
   * @param params - Deleverage parameters
   *
   * @example
   * ```typescript
   * const tx = new Transaction();
   * tx.setSender(account.address);
   * tx.setGasBudget(200_000_000);
   *
   * await sdk.buildDeleverageTransaction(tx, {
   *   protocol: LendingProtocol.Suilend,
   * });
   *
   * await signAndExecute({ transaction: tx });
   * ```
   */
  async buildDeleverageTransaction(
    tx: Transaction,
    params: BrowserDeleverageParams,
  ): Promise<void> {
    this.ensureInitialized();

    const protocol = this.getProtocol(params.protocol);

    // Get current position
    const position = await protocol.getPosition(this.userAddress);
    if (!position) {
      throw new Error("No position found to deleverage");
    }

    if (position.debt.amount === 0n) {
      throw new Error("No debt to repay. Use withdraw instead.");
    }

    await buildDeleverageTx(tx, {
      protocol,
      flashLoanClient: this.flashLoanClient,
      swapClient: this.swapClient,
      suiClient: this.suiClient,
      userAddress: this.userAddress,
      position,
    });
  }

  // ============================================================================
  // Node.js Strategy Methods (with execution)
  // ============================================================================

  /**
   * Execute leverage strategy (Node.js only)
   *
   * Requires SDK to be initialized with keypair.
   * For browser usage, use buildLeverageTransaction instead.
   */
  async leverage(params: LeverageParams): Promise<StrategyResult> {
    this.ensureInitialized();

    if (!this.keypair) {
      return {
        success: false,
        error:
          "Keypair required for execution. Use buildLeverageTransaction for browser.",
      };
    }

    const tx = new Transaction();
    tx.setSender(this.userAddress);
    tx.setGasBudget(100_000_000);

    try {
      await this.buildLeverageTransaction(tx, params);

      if (params.dryRun) {
        return this.dryRun(tx);
      }

      return this.execute(tx);
    } catch (error: any) {
      return {
        success: false,
        error: error.message || String(error),
      };
    }
  }

  /**
   * Execute deleverage strategy (Node.js only)
   *
   * Requires SDK to be initialized with keypair.
   * For browser usage, use buildDeleverageTransaction instead.
   */
  async deleverage(params: DeleverageParams): Promise<StrategyResult> {
    this.ensureInitialized();

    if (!this.keypair) {
      return {
        success: false,
        error:
          "Keypair required for execution. Use buildDeleverageTransaction for browser.",
      };
    }

    const tx = new Transaction();
    tx.setSender(this.userAddress);
    tx.setGasBudget(100_000_000);

    try {
      await this.buildDeleverageTransaction(tx, params);

      if (params.dryRun) {
        return this.dryRun(tx);
      }

      return this.execute(tx);
    } catch (error: any) {
      return {
        success: false,
        error: error.message || String(error),
      };
    }
  }

  // ============================================================================
  // Position Methods
  // ============================================================================

  /**
   * Get current lending position
   */
  async getPosition(protocol: LendingProtocol): Promise<PositionInfo | null> {
    this.ensureInitialized();
    return this.getProtocol(protocol).getPosition(this.userAddress);
  }

  /**
   * Check if user has a position on specified protocol
   */
  async hasPosition(protocol: LendingProtocol): Promise<boolean> {
    this.ensureInitialized();
    return this.getProtocol(protocol).hasPosition(this.userAddress);
  }

  /**
   * Get max borrowable amount for an asset
   */
  async getMaxBorrowable(
    protocol: LendingProtocol,
    coinType: string,
  ): Promise<string> {
    this.ensureInitialized();
    return this.getProtocol(protocol).getMaxBorrowableAmount(
      this.userAddress,
      this.resolveCoinType(coinType),
    );
  }

  /**
   * Get max withdrawable amount for an asset
   */
  async getMaxWithdrawable(
    protocol: LendingProtocol,
    coinType: string,
  ): Promise<string> {
    this.ensureInitialized();
    return this.getProtocol(protocol).getMaxWithdrawableAmount(
      this.userAddress,
      this.resolveCoinType(coinType),
    );
  }

  // ============================================================================
  // Aggregation Methods
  // ============================================================================

  /**
   * Get aggregated market data from all supported protocols
   */
  async getAggregatedMarkets(): Promise<Record<string, MarketAsset[]>> {
    this.ensureInitialized();
    const result: Record<string, MarketAsset[]> = {};
    const protocols = [LendingProtocol.Suilend, LendingProtocol.Navi];

    await Promise.all(
      protocols.map(async (p) => {
        try {
          const adapter = this.protocols.get(p);
          if (adapter) {
            result[p] = await adapter.getMarkets();
          }
        } catch (e) {
          console.error(`Failed to fetch markets for ${p}`, e);
          result[p] = [];
        }
      }),
    );

    return result;
  }

  /**
   * Get aggregated portfolio data from all supported protocols
   */
  async getAggregatedPortfolio(): Promise<AccountPortfolio[]> {
    this.ensureInitialized();
    const protocols = [LendingProtocol.Suilend, LendingProtocol.Navi];
    const address = this.userAddress;

    const portfolios = await Promise.all(
      protocols.map(async (p) => {
        try {
          const adapter = this.protocols.get(p);
          if (adapter) {
            return await adapter.getAccountPortfolio(address);
          }
        } catch (e) {
          console.error(`Failed to fetch portfolio for ${p}`, e);
        }
        // Return resilient default
        return {
          protocol: p,
          address,
          healthFactor: Infinity,
          netValueUsd: 0,
          totalCollateralUsd: 0,
          totalDebtUsd: 0,
          positions: [],
        } as AccountPortfolio;
      }),
    );

    return portfolios;
  }

  // ============================================================================
  // Preview Methods
  // ============================================================================

  /**
   * Preview leverage position before execution
   */
  async previewLeverage(params: {
    depositAsset: string;
    depositAmount: string;
    multiplier: number;
  }): Promise<LeveragePreview> {
    const coinType = this.resolveCoinType(params.depositAsset);
    const reserve = getReserveByCoinType(coinType);
    const decimals = reserve?.decimals || 8;
    const depositAmount = parseUnits(params.depositAmount, decimals);

    return calcPreview({
      depositCoinType: coinType,
      depositAmount,
      multiplier: params.multiplier,
    });
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get token price in USD
   */
  async getTokenPrice(asset: string): Promise<number> {
    const coinType = this.resolveCoinType(asset);
    return getTokenPrice(coinType);
  }

  /**
   * Get the SuiClient instance
   */
  getSuiClient(): SuiClient {
    this.ensureInitialized();
    return this.suiClient;
  }

  /**
   * Get the user address
   */
  getUserAddress(): string {
    return this.userAddress;
  }

  // ============================================================================
  // Internal Methods
  // ============================================================================

  private async dryRun(tx: Transaction): Promise<StrategyResult> {
    const result = await this.suiClient.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client: this.suiClient }),
    });

    if (result.effects.status.status === "success") {
      return {
        success: true,
        gasUsed: BigInt(result.effects.gasUsed.computationCost),
      };
    }

    return {
      success: false,
      error: result.effects.status.error || "Dry run failed",
    };
  }

  private async execute(tx: Transaction): Promise<StrategyResult> {
    if (!this.keypair) {
      throw new Error("Keypair required for execution");
    }

    const result = await this.suiClient.signAndExecuteTransaction({
      signer: this.keypair,
      transaction: tx,
      options: {
        showEffects: true,
      },
    });

    if (result.effects?.status.status === "success") {
      return {
        success: true,
        txDigest: result.digest,
        gasUsed: BigInt(result.effects.gasUsed.computationCost),
      };
    }

    return {
      success: false,
      txDigest: result.digest,
      error: result.effects?.status.error || "Execution failed",
    };
  }
}
