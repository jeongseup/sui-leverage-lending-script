/**
 * DeFi Dash SDK - Suilend Protocol Adapter
 *
 * Implements ILendingProtocol for Suilend
 */

import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import {
  SuilendClient,
  LENDING_MARKET_ID,
  LENDING_MARKET_TYPE,
} from "@suilend/sdk";
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
import { normalizeCoinType, formatUnits } from "../lib/utils";
import { getReserveByCoinType, SUILEND_RESERVES } from "../lib/suilend/const";
import { getTokenPrice } from "@7kprotocol/sdk-ts";

// Suilend uses WAD (10^18) for internal precision
const WAD = 10n ** 18n;

/**
 * Suilend lending protocol adapter
 */
export class SuilendAdapter implements ILendingProtocol {
  readonly name = "suilend";
  readonly consumesRepaymentCoin = false; // Suilend returns unused portion
  private client!: SuilendClient;
  private suiClient!: SuiClient;
  private initialized = false;

  async initialize(suiClient: SuiClient): Promise<void> {
    this.suiClient = suiClient;
    this.client = await SuilendClient.initialize(
      LENDING_MARKET_ID,
      LENDING_MARKET_TYPE,
      suiClient,
    );
    this.initialized = true;
  }

  private ensureInitialized() {
    if (!this.initialized) {
      throw new Error(
        "SuilendAdapter not initialized. Call initialize() first.",
      );
    }
  }

  async getPosition(userAddress: string): Promise<PositionInfo | null> {
    this.ensureInitialized();

    const caps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (caps.length === 0) return null;

    const obligation = await SuilendClient.getObligation(
      caps[0].obligationId,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (!obligation) return null;

    const deposits = obligation.deposits || [];
    const borrows = obligation.borrows || [];

    if (deposits.length === 0 && borrows.length === 0) return null;

    // Parse first deposit as collateral
    let collateral: AssetPosition | null = null;
    if (deposits.length > 0) {
      const deposit = deposits[0] as any;
      const coinType = normalizeCoinType(deposit.coinType.name);
      const reserve = getReserveByCoinType(coinType);
      const amount = BigInt(deposit.depositedCtokenAmount);
      const price = await getTokenPrice(coinType);
      const decimals = reserve?.decimals || 9;

      collateral = {
        amount,
        symbol: reserve?.symbol || "???",
        coinType,
        decimals,
        valueUsd: (Number(amount) / Math.pow(10, decimals)) * price,
      };
    }

    // Parse first borrow as debt
    let debt: AssetPosition | null = null;
    if (borrows.length > 0) {
      const borrow = borrows[0] as any;
      const coinType = normalizeCoinType(borrow.coinType.name);
      const reserve = getReserveByCoinType(coinType);
      const rawAmount = BigInt(borrow.borrowedAmount.value);
      const amount = rawAmount / WAD;
      const price = await getTokenPrice(coinType);
      const decimals = reserve?.decimals || 6;

      debt = {
        amount,
        symbol: reserve?.symbol || "USDC",
        coinType,
        decimals,
        valueUsd: (Number(amount) / Math.pow(10, decimals)) * price,
      };
    }

    if (!collateral) return null;

    const netValueUsd = collateral.valueUsd - (debt?.valueUsd || 0);

    return {
      collateral,
      debt: debt || {
        amount: 0n,
        symbol: "USDC",
        coinType: USDC_COIN_TYPE,
        decimals: 6,
        valueUsd: 0,
      },
      netValueUsd,
    };
  }

  async hasPosition(userAddress: string): Promise<boolean> {
    this.ensureInitialized();
    const caps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );
    return caps.length > 0;
  }

  async deposit(
    tx: Transaction,
    coin: any,
    coinType: string,
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const caps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    let obligationOwnerCap: any;
    let isNew = false;

    if (caps.length > 0) {
      obligationOwnerCap = caps[0].id;
    } else {
      // Create new obligation
      obligationOwnerCap = this.client.createObligation(tx);
      isNew = true;
    }

    this.client.deposit(coin, coinType, obligationOwnerCap, tx);

    if (isNew) {
      tx.transferObjects([obligationOwnerCap], userAddress);
    }
  }

  async withdraw(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
  ): Promise<any> {
    this.ensureInitialized();

    const caps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (caps.length === 0) {
      throw new Error("No obligation found for withdrawal");
    }

    const cap = caps[0];
    const result = await this.client.withdraw(
      cap.id,
      cap.obligationId,
      coinType,
      amount,
      tx,
      false, // Skip refresh, assume already done
    );

    return result[0];
  }

  async borrow(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
    skipOracle = false,
  ): Promise<any> {
    this.ensureInitialized();

    const caps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (caps.length === 0) {
      throw new Error("No obligation found for borrowing");
    }

    const cap = caps[0];
    const result = await this.client.borrow(
      cap.id,
      cap.obligationId,
      coinType,
      amount,
      tx,
      skipOracle,
    );

    return result[0];
  }

  async repay(
    tx: Transaction,
    coinType: string,
    coin: any,
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const caps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (caps.length === 0) {
      throw new Error("No obligation found for repayment");
    }

    this.client.repay(caps[0].obligationId, coinType, coin, tx);
  }

  async refreshOracles(
    tx: Transaction,
    coinTypes: string[],
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const caps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (caps.length > 0) {
      const obligation = await SuilendClient.getObligation(
        caps[0].obligationId,
        [LENDING_MARKET_TYPE],
        this.suiClient,
      );
      await this.client.refreshAll(tx, obligation, coinTypes);
    } else {
      // For new obligations, just refresh reserves
      await this.client.refreshAll(tx, undefined, coinTypes);
    }
  }

  async getMarkets(): Promise<MarketAsset[]> {
    this.ensureInitialized();
    const reserves = this.client.lendingMarket.reserves as any[];

    return Promise.all(
      reserves.map(async (reserve) => {
        const coinType = normalizeCoinType(reserve.coinType.name);
        const localReserve = getReserveByCoinType(coinType);

        // Suilend price is usually 18 decimals WAD or straight USD?
        const price = Number(reserve.price) / 1e18;

        const supplyApy = 0; // TODO: Implement APY
        const borrowApy = 0; // TODO: Implement APY

        const decimals = localReserve?.decimals || 9;

        // Available / Borrowed
        const availableLiquidity =
          Number(reserve.availableAmount) / Math.pow(10, decimals);
        const totalBorrow = Number(reserve.borrowedAmount.value) / 1e18; // WAD
        const totalSupply = availableLiquidity + totalBorrow;

        return {
          symbol: localReserve?.symbol || "UNKNOWN",
          coinType,
          decimals,
          price,
          supplyApy,
          borrowApy,
          maxLtv: Number(reserve.config.openLtvPct) / 100,
          liquidationThreshold: Number(reserve.config.closeLtvPct) / 100,
          totalSupply,
          totalBorrow,
          availableLiquidity,
        };
      }),
    );
  }

  async getAccountPortfolio(address: string): Promise<AccountPortfolio> {
    this.ensureInitialized();

    // Reuse specific obligation logic
    const caps = await SuilendClient.getObligationOwnerCaps(
      address,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (caps.length === 0) {
      return {
        protocol: LendingProtocol.Suilend,
        address,
        healthFactor: Infinity,
        netValueUsd: 0,
        totalCollateralUsd: 0,
        totalDebtUsd: 0,
        positions: [],
      };
    }

    const obligation = await SuilendClient.getObligation(
      caps[0].obligationId,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    const positions: Position[] = [];
    let totalCollateralUsd = 0;
    let totalDebtUsd = 0;

    if (obligation) {
      const deposits = obligation.deposits || [];
      for (const d of deposits) {
        const coinType = normalizeCoinType((d as any).coinType.name);
        const reserve = (this.client.lendingMarket.reserves as any[]).find(
          (r) => normalizeCoinType(r.coinType.name) === coinType,
        );
        if (!reserve) continue;

        const localReserve = getReserveByCoinType(coinType);
        const decimals = localReserve?.decimals || 9;
        const symbol = localReserve?.symbol || "UNKNOWN";

        const price = Number(reserve.price) / 1e18;
        const rate = Number(reserve.cTokenExchangeRate) / 1e18;
        const rawAmount = BigInt((d as any).depositedCtokenAmount);
        const amount = (Number(rawAmount) / Math.pow(10, decimals)) * rate;

        const valueUsd = amount * price;
        totalCollateralUsd += valueUsd;

        positions.push({
          symbol,
          coinType,
          side: "supply",
          amount,
          valueUsd,
          apy: 0,
        });
      }

      const borrows = obligation.borrows || [];
      for (const b of borrows) {
        const coinType = normalizeCoinType((b as any).coinType.name);
        const reserve = (this.client.lendingMarket.reserves as any[]).find(
          (r) => normalizeCoinType(r.coinType.name) === coinType,
        );
        if (!reserve) continue;

        const localReserve = getReserveByCoinType(coinType);
        const decimals = localReserve?.decimals || 9;
        const symbol = localReserve?.symbol || "UNKNOWN";

        const price = Number(reserve.price) / 1e18;

        const rawAmount = BigInt((b as any).borrowedAmount.value);
        const amount = Number(rawAmount) / 1e18;

        const valueUsd = amount * price;
        totalDebtUsd += valueUsd;

        positions.push({
          symbol,
          coinType,
          side: "borrow",
          amount,
          valueUsd,
          apy: 0,
        });
      }
    }

    const healthFactor =
      totalDebtUsd > 0 ? totalCollateralUsd / totalDebtUsd : Infinity;

    return {
      protocol: LendingProtocol.Suilend,
      address,
      healthFactor,
      netValueUsd: totalCollateralUsd - totalDebtUsd,
      totalCollateralUsd,
      totalDebtUsd,
      positions,
    };
  }

  async getReserveInfo(coinType: string): Promise<ReserveInfo | undefined> {
    const reserve = getReserveByCoinType(normalizeCoinType(coinType));
    if (!reserve) return undefined;

    return {
      coinType: reserve.coinType,
      symbol: reserve.symbol,
      decimals: reserve.decimals,
      id: reserve.id,
    };
  }

  /**
   * Get obligation owner cap info
   */
  async getObligationCap(userAddress: string) {
    this.ensureInitialized();
    const caps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );
    return caps.length > 0 ? caps[0] : null;
  }

  /**
   * Get the underlying Suilend client for advanced operations
   */
  getSuilendClient(): SuilendClient {
    this.ensureInitialized();
    return this.client;
  }
}
