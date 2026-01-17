/**
 * DeFi Dash SDK - Navi Protocol Adapter
 *
 * Implements ILendingProtocol for Navi
 */

import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import {
  depositCoinPTB,
  withdrawCoinPTB,
  borrowCoinPTB,
  repayCoinPTB,
  getPools,
  getLendingState,
  updateOraclePricesPTB,
  getPriceFeeds,
  normalizeCoinType as naviNormalize,
} from "@naviprotocol/lending";
import { ILendingProtocol, ReserveInfo } from "./interface";
import { PositionInfo, AssetPosition, USDC_COIN_TYPE } from "../types";
import { normalizeCoinType } from "../lib/utils";
import { getReserveByCoinType } from "../lib/suilend/const";
import { getTokenPrice } from "@7kprotocol/sdk-ts";

// Navi SDK returns balances with 9 decimal precision internally
const NAVI_BALANCE_DECIMALS = 9;

/**
 * Navi lending protocol adapter
 */
export class NaviAdapter implements ILendingProtocol {
  readonly name = "navi";
  readonly consumesRepaymentCoin = true; // Navi's repayCoinPTB consumes entire coin
  private suiClient!: SuiClient;
  private pools: any[] = [];
  private priceFeeds: any[] = [];
  private initialized = false;

  async initialize(suiClient: SuiClient): Promise<void> {
    this.suiClient = suiClient;

    // Fetch pools
    const poolsResult = await getPools({ env: "prod" });
    this.pools = Array.isArray(poolsResult)
      ? poolsResult
      : Object.values(poolsResult);

    // Fetch price feeds
    this.priceFeeds = await getPriceFeeds({ env: "prod" });

    this.initialized = true;
  }

  private ensureInitialized() {
    if (!this.initialized) {
      throw new Error("NaviAdapter not initialized. Call initialize() first.");
    }
  }

  private getPool(coinType: string) {
    const normalized = normalizeCoinType(coinType);
    return this.pools.find((p) => {
      const poolCoinType = normalizeCoinType(p.coinType ?? p.suiCoinType ?? "");
      return poolCoinType === normalized;
    });
  }

  private getPriceFeed(coinType: string) {
    const normalized = normalizeCoinType(coinType);
    return this.priceFeeds.find(
      (f: any) => normalizeCoinType(f.coinType) === normalized,
    );
  }

  async getPosition(userAddress: string): Promise<PositionInfo | null> {
    this.ensureInitialized();

    const lendingState = await getLendingState(userAddress, { env: "prod" });
    if (lendingState.length === 0) return null;

    const activePositions = lendingState.filter(
      (p) => BigInt(p.supplyBalance) > 0 || BigInt(p.borrowBalance) > 0,
    );

    if (activePositions.length === 0) return null;

    // Find supply position
    let collateral: AssetPosition | null = null;
    let debt: AssetPosition | null = null;

    for (const pos of activePositions) {
      const poolCoinType = normalizeCoinType(pos.pool.coinType);
      const reserve = getReserveByCoinType(poolCoinType);
      const decimals = reserve?.decimals || 9;
      const symbol = reserve?.symbol || poolCoinType.split("::").pop() || "???";

      if (BigInt(pos.supplyBalance) > 0) {
        const amount = BigInt(pos.supplyBalance);
        const price = await getTokenPrice(poolCoinType);
        collateral = {
          amount,
          symbol,
          coinType: poolCoinType,
          decimals: NAVI_BALANCE_DECIMALS, // Navi uses 9 decimals internally
          valueUsd:
            (Number(amount) / Math.pow(10, NAVI_BALANCE_DECIMALS)) * price,
        };
      }

      if (BigInt(pos.borrowBalance) > 0) {
        const rawAmount = BigInt(pos.borrowBalance);
        // Convert from Navi's 9 decimal precision to native decimals
        const amount =
          rawAmount / BigInt(10 ** (NAVI_BALANCE_DECIMALS - decimals));
        const price = await getTokenPrice(poolCoinType);
        debt = {
          amount,
          symbol,
          coinType: poolCoinType,
          decimals,
          valueUsd: (Number(amount) / Math.pow(10, decimals)) * price,
        };
      }
    }

    if (!collateral) return null;

    const netValueUsd = collateral.valueUsd - (debt?.valueUsd || 0);

    return {
      collateral,
      debt: debt || {
        amount: 0n,
        symbol: "USDC",
        coinType: normalizeCoinType(USDC_COIN_TYPE),
        decimals: 6,
        valueUsd: 0,
      },
      netValueUsd,
    };
  }

  async hasPosition(userAddress: string): Promise<boolean> {
    const position = await this.getPosition(userAddress);
    return position !== null;
  }

  async deposit(
    tx: Transaction,
    coin: any,
    coinType: string,
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const pool = this.getPool(coinType);
    if (!pool) {
      throw new Error(`Pool not found for ${coinType}`);
    }

    // Navi's depositCoinPTB expects the coin directly
    await depositCoinPTB(tx as any, pool, coin, {
      env: "prod",
    });
  }

  async withdraw(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
  ): Promise<any> {
    this.ensureInitialized();

    const pool = this.getPool(coinType);
    if (!pool) {
      throw new Error(`Pool not found for ${coinType}`);
    }

    const withdrawnCoin = await withdrawCoinPTB(
      tx as any,
      pool,
      Number(amount),
      { env: "prod" },
    );

    return withdrawnCoin;
  }

  async borrow(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
    skipOracle = false,
  ): Promise<any> {
    this.ensureInitialized();

    const pool = this.getPool(coinType);
    if (!pool) {
      throw new Error(`Pool not found for ${coinType}`);
    }

    const borrowedCoin = await borrowCoinPTB(tx as any, pool, Number(amount), {
      env: "prod",
    });

    return borrowedCoin;
  }

  async repay(
    tx: Transaction,
    coinType: string,
    coin: any,
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const pool = this.getPool(coinType);
    if (!pool) {
      throw new Error(`Pool not found for ${coinType}`);
    }

    await repayCoinPTB(tx as any, pool, coin, {
      env: "prod",
    });
  }

  async refreshOracles(
    tx: Transaction,
    coinTypes: string[],
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const feedsToUpdate = coinTypes
      .map((ct) => this.getPriceFeed(ct))
      .filter(Boolean);

    if (feedsToUpdate.length > 0) {
      await updateOraclePricesPTB(tx as any, feedsToUpdate, {
        env: "prod",
        updatePythPriceFeeds: true,
      });
    }
  }

  async getReserveInfo(coinType: string): Promise<ReserveInfo | undefined> {
    this.ensureInitialized();

    const pool = this.getPool(coinType);
    if (!pool) return undefined;

    const reserve = getReserveByCoinType(normalizeCoinType(coinType));

    return {
      coinType: pool.coinType,
      symbol: reserve?.symbol || pool.coinType.split("::").pop() || "???",
      decimals: reserve?.decimals || 9,
    };
  }

  /**
   * Get all available pools
   */
  getPools() {
    this.ensureInitialized();
    return this.pools;
  }
}
