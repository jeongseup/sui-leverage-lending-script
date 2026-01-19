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
  getHealthFactor,
  normalizeCoinType as naviNormalize,
} from "@naviprotocol/lending";
import { ILendingProtocol, ReserveInfo } from "./interface";
import {
  PositionInfo,
  AssetPosition,
  USDC_COIN_TYPE,
  MarketAsset,
  AccountPortfolio,
  LendingProtocol,
  Position,
} from "../types";
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

    const pool = this.getPool(coinType) as any;
    if (!pool) return undefined;

    const reserve = getReserveByCoinType(
      normalizeCoinType(pool.coinType ?? pool.suiCoinType ?? ""),
    );

    return {
      coinType: pool.coinType,
      symbol: reserve?.symbol || pool.coinType.split("::").pop() || "???",
      decimals: reserve?.decimals || 9,
    };
  }

  /**
   * Get all market data
   */
  async getMarkets(): Promise<MarketAsset[]> {
    this.ensureInitialized();

    return this.pools.map((pool: any) => {
      const coinType = normalizeCoinType(
        pool.coinType ?? pool.suiCoinType ?? "",
      );
      const reserve = getReserveByCoinType(coinType);
      const decimals = reserve?.decimals || 9;
      const price = parseFloat(pool.oracle?.price ?? pool.price ?? "0");

      // Helper to parse APY (handle bps vs ratio)
      const getApy = (raw: any) => {
        const val = parseFloat(raw ?? "0");
        const ratio = val > 1 ? val / 10000 : val;
        return ratio * 100;
      };

      const supplyApy = getApy(
        pool.supplyApy ?? pool.supplyIncentiveApyInfo?.apy,
      );
      const borrowApy = getApy(
        pool.borrowApy ?? pool.borrowIncentiveApyInfo?.apy,
      );

      return {
        symbol: reserve?.symbol || coinType.split("::").pop() || "UNKNOWN",
        coinType,
        decimals,
        price,
        supplyApy,
        borrowApy,
        maxLtv: parseFloat(pool.liquidationFactor?.threshold ?? "0.8") - 0.05, // Safety margin
        liquidationThreshold: parseFloat(
          pool.liquidationFactor?.threshold ?? "0.8",
        ),
        totalSupply:
          parseFloat(pool.totalSupply ?? pool.totalSupplyAmount ?? "0") /
          Math.pow(10, decimals),
        totalBorrow:
          parseFloat(pool.totalBorrow ?? pool.borrowedAmount ?? "0") /
          Math.pow(10, decimals),
        availableLiquidity:
          parseFloat(
            pool.leftSupply ??
              pool.availableBorrow ??
              pool.leftBorrowAmount ??
              "0",
          ) / Math.pow(10, decimals),
      };
    });
  }

  /**
   * Get aggregated portfolio
   */
  async getAccountPortfolio(address: string): Promise<AccountPortfolio> {
    this.ensureInitialized();

    const [lendingState, healthFactor] = await Promise.all([
      getLendingState(address, { env: "prod" }),
      getHealthFactor(address, { env: "prod" }),
    ]);

    const positions: Position[] = [];
    let totalCollateralUsd = 0;
    let totalDebtUsd = 0;

    for (const state of lendingState as any[]) {
      const coinType = normalizeCoinType(
        state.coinType ?? state.pool?.coinType ?? "",
      );
      const reserve = getReserveByCoinType(coinType);
      const symbol = reserve?.symbol || "UNKNOWN";
      const price = parseFloat(
        state.pool?.oracle?.price ?? state.pool?.price ?? "0",
      );

      const supplyRaw = BigInt(state.supplyBalance ?? 0);
      const borrowRaw = BigInt(state.borrowBalance ?? 0);

      const getApy = (raw: any) => {
        const val = parseFloat(raw ?? "0");
        const ratio = val > 1 ? val / 10000 : val;
        return ratio * 100;
      };

      if (supplyRaw > 0) {
        // Navi internal balances are 9 decimals
        const amount = Number(supplyRaw) / Math.pow(10, NAVI_BALANCE_DECIMALS);
        const valueUsd = amount * price;
        totalCollateralUsd += valueUsd;

        const supplyApy = getApy(
          state.pool?.supplyApy ?? state.pool?.supplyIncentiveApyInfo?.apy,
        );

        positions.push({
          symbol,
          coinType,
          side: "supply",
          amount,
          valueUsd,
          apy: supplyApy,
        });
      }

      if (borrowRaw > 0) {
        const amount = Number(borrowRaw) / Math.pow(10, NAVI_BALANCE_DECIMALS);
        const valueUsd = amount * price;
        totalDebtUsd += valueUsd;

        const borrowApy = getApy(
          state.pool?.borrowApy ?? state.pool?.borrowIncentiveApyInfo?.apy,
        );

        positions.push({
          symbol,
          coinType,
          side: "borrow",
          amount,
          valueUsd,
          apy: borrowApy,
        });
      }
    }

    return {
      protocol: LendingProtocol.Navi,
      address,
      healthFactor: parseFloat(healthFactor.toString()),
      netValueUsd: totalCollateralUsd - totalDebtUsd,
      totalCollateralUsd,
      totalDebtUsd,
      positions,
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
