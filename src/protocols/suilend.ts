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
import { parseReserve } from "@suilend/sdk/parsers/reserve";
import { parseObligation } from "@suilend/sdk/parsers/obligation";
import { refreshReservePrice } from "@suilend/sdk/utils/simulate";
import { CoinMetadata } from "@mysten/sui/client";
import { normalizeStructTag } from "@mysten/sui/utils";
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
import {
  calculatePortfolioMetrics,
  calculateRewardsEarned,
  calculateLiquidationPrice,
  calculateRewardApy,
} from "../lib/suilend/calculators";
import BigNumber from "bignumber.js";

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

        // Suilend price is Decimal { value: string }
        const price = Number(BigInt((reserve.price as any).value)) / 1e18;

        // APY not directly in reserve object, default to 0 for now
        const supplyApyPct = 0;
        const borrowApyPct = 0;

        const decimals = localReserve?.decimals || 9;

        // Available is u64, Borrowed is Decimal
        const availableLiquidity =
          Number(reserve.availableAmount) / Math.pow(10, decimals);
        const totalBorrow =
          Number(BigInt((reserve.borrowedAmount as any).value)) / 1e18; // WAD
        const totalSupply = availableLiquidity + totalBorrow;

        return {
          symbol: localReserve?.symbol || "UNKNOWN",
          coinType,
          decimals,
          price,
          supplyApy: supplyApyPct,
          borrowApy: borrowApyPct,
          maxLtv: Number(reserve.config.openLtvPct) / 100,
          liquidationThreshold: Number(reserve.config.closeLtvPct) / 100,
          totalSupply,
          totalBorrow,
          availableLiquidity,
        };
      }),
    );
  }

  private coinMetadataCache: Record<string, CoinMetadata> = {};

  async getAccountPortfolio(address: string): Promise<AccountPortfolio> {
    this.ensureInitialized();

    const caps = await SuilendClient.getObligationOwnerCaps(
      address,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    const emptyPortfolio: AccountPortfolio = {
      protocol: LendingProtocol.Suilend,
      address,
      healthFactor: Infinity,
      netValueUsd: 0,
      totalCollateralUsd: 0,
      totalDepositedUsd: 0,
      totalDebtUsd: 0,
      weightedBorrowsUsd: 0,
      borrowLimitUsd: 0,
      liquidationThresholdUsd: 0,
      positions: [],
      netApy: 0,
      totalAnnualNetEarningsUsd: 0,
    };

    if (caps.length === 0) {
      return emptyPortfolio;
    }

    const obligation = await SuilendClient.getObligation(
      caps[0].obligationId,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (!obligation) return emptyPortfolio;

    // Use reserves directly (already fetched by initialize)
    const refreshedReserves = this.client.lendingMarket.reserves;

    // Build Metadata Map (reusing logic specific to this adapter's cache)
    const allCoinTypes = new Set<string>();
    refreshedReserves.forEach((r) => {
      allCoinTypes.add(r.coinType.name);
      r.depositsPoolRewardManager.poolRewards.forEach((pr) => {
        if (pr) allCoinTypes.add(pr.coinType.name);
      });
      r.borrowsPoolRewardManager.poolRewards.forEach((pr) => {
        if (pr) allCoinTypes.add(pr.coinType.name);
      });
    });

    const uniqueCoinTypes = Array.from(allCoinTypes);
    await Promise.all(
      uniqueCoinTypes.map(async (ct) => {
        const normalized = normalizeStructTag(ct);
        if (!this.coinMetadataCache[normalized]) {
          try {
            const metadata = await this.suiClient.getCoinMetadata({
              coinType: ct,
            });
            if (metadata) {
              this.coinMetadataCache[normalized] = metadata;
            }
          } catch (e) {
            // ignore failed metadata fetch
          }
        }
      }),
    );

    // Create a map for parser with fallbacks
    const coinMetadataMap: Record<string, CoinMetadata> = {
      ...this.coinMetadataCache,
    };
    uniqueCoinTypes.forEach((ct) => {
      const normalized = normalizeStructTag(ct);
      if (!coinMetadataMap[normalized]) {
        coinMetadataMap[normalized] = {
          decimals: 9,
          name: ct,
          symbol: ct.split("::").pop() ?? "UNK",
          description: "",
          iconUrl: "",
          id: "",
        };
      }
    });

    const parsedReserveMap: Record<string, any> = {};
    refreshedReserves.forEach((r) => {
      const parsed = parseReserve(r, coinMetadataMap);
      parsedReserveMap[normalizeStructTag(parsed.coinType)] = parsed;
    });

    console.log(
      "SDK Available Reserves:",
      Object.values(parsedReserveMap).map((r: any) => r.token.symbol),
    );

    const parsedObligation = parseObligation(obligation, parsedReserveMap);

    // --- USE CALCULATORS ---
    const metrics = calculatePortfolioMetrics(
      parsedObligation,
      parsedReserveMap,
    );

    // Map to positions
    const positions: Position[] = [];

    // Deposits
    parsedObligation.deposits.forEach((d) => {
      const reserve = d.reserve;
      const earnings = calculateRewardsEarned(
        d.userRewardManager,
        reserve,
        true,
      );

      // Reward APY
      const totalDepositedUsd = new BigNumber(d.reserve.depositedAmountUsd);
      const rewardApyStats = calculateRewardApy(
        reserve.depositsPoolRewardManager,
        totalDepositedUsd,
        parsedReserveMap,
      );
      const interestApy = d.reserve.depositAprPercent.div(100).toNumber();

      // Liquidation Price
      const amountBig = new BigNumber(d.depositedAmount);
      const liqPriceBig = calculateLiquidationPrice(
        d.reserve.coinType,
        amountBig,
        Number(d.reserve.config.closeLtvPct) / 100,
        parsedObligation,
      );

      positions.push({
        protocol: LendingProtocol.Suilend,
        coinType: d.coinType,
        symbol: d.reserve.token.symbol,
        side: "supply",
        amount: d.depositedAmount.toNumber(),
        amountRaw: d.depositedAmount
          .times(Math.pow(10, d.reserve.mintDecimals))
          .toFixed(0),
        valueUsd: d.depositedAmountUsd.toNumber(),
        apy: interestApy + rewardApyStats.totalRewardApy / 100,
        rewardsApy: rewardApyStats.totalRewardApy / 100,
        rewards: earnings,
        estimatedLiquidationPrice: liqPriceBig
          ? liqPriceBig.toNumber()
          : undefined,
      });
    });

    // Borrows
    parsedObligation.borrows.forEach((b) => {
      const reserve = b.reserve;
      const earnings = calculateRewardsEarned(
        b.userRewardManager,
        reserve,
        false,
      );
      positions.push({
        protocol: LendingProtocol.Suilend,
        coinType: b.coinType,
        symbol: b.reserve.token.symbol,
        side: "borrow",
        amount: b.borrowedAmount.toNumber(),
        amountRaw: b.borrowedAmount
          .times(Math.pow(10, b.reserve.mintDecimals))
          .toFixed(0),
        valueUsd: b.borrowedAmountUsd.toNumber(),
        apy: b.reserve.borrowAprPercent.div(100).toNumber(),
        rewards: earnings,
      });
    });

    return {
      protocol: LendingProtocol.Suilend,
      address,
      healthFactor: metrics.healthFactor.toNumber(),
      netValueUsd: metrics.netValue.toNumber(),
      totalCollateralUsd: metrics.totalSupply.toNumber(),
      totalDepositedUsd: metrics.totalSupply.toNumber(),
      totalDebtUsd: metrics.totalBorrow.toNumber(),
      weightedBorrowsUsd: parsedObligation.weightedBorrowsUsd.toNumber(),
      borrowLimitUsd: metrics.borrowLimit.toNumber(),
      liquidationThresholdUsd: metrics.liquidationThreshold.toNumber(),
      positions,
      netApy: metrics.netApy.toNumber(),
      totalAnnualNetEarningsUsd: metrics.totalAnnualNetEarnings.toNumber(),
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

  async getMaxBorrowableAmount(
    address: string,
    coinType: string,
  ): Promise<string> {
    this.ensureInitialized();

    // Check if user has obligation
    const caps = await SuilendClient.getObligationOwnerCaps(
      address,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (caps.length === 0) return "0";

    const obligation = await SuilendClient.getObligation(
      caps[0].obligationId,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (!obligation) return "0";

    const oblAny = obligation as any;
    // Values are in USD (WAD)
    const totalCollateralValue =
      Number(BigInt(oblAny.allowedBorrowValueUsd ?? 0)) / 1e18;
    const totalBorrowValue =
      Number(BigInt(oblAny.borrowedValueUsd ?? 0)) / 1e18;
    const availableBorrowValue = Math.max(
      0,
      totalCollateralValue - totalBorrowValue,
    );

    // Get asset price
    const reserve = (this.client.lendingMarket.reserves as any[]).find(
      (r) => normalizeCoinType(r.coinType.name) === normalizeCoinType(coinType),
    );

    const price = reserve ? Number(reserve.price) / 1e18 : 0;

    if (price === 0) return "0";

    const maxBorrowAmount = availableBorrowValue / price;
    return maxBorrowAmount.toFixed(6).replace(/\.?0+$/, "");
  }

  async getMaxWithdrawableAmount(
    address: string,
    coinType: string,
  ): Promise<string> {
    this.ensureInitialized();

    const caps = await SuilendClient.getObligationOwnerCaps(
      address,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (caps.length === 0) return "0";

    const obligation = await SuilendClient.getObligation(
      caps[0].obligationId,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (!obligation) return "0";

    // Find deposit
    const deposit = (obligation.deposits || []).find(
      (d: any) =>
        normalizeCoinType(d.coinType?.name) === normalizeCoinType(coinType),
    );

    if (!deposit) return "0";

    const localReserve = getReserveByCoinType(normalizeCoinType(coinType));
    const decimals = localReserve?.decimals || 9;
    const depositedRaw = BigInt(
      deposit.depositedCtokenAmount?.toString() ?? "0",
    );
    const depositAmount = Number(depositedRaw) / Math.pow(10, decimals);

    // Exchange rate CToken -> Token?
    // Wait, depositedCtokenAmount is not the underlying amount?
    // Suilend SDK handles this?
    // frontend code: `formatAmount(depositedRaw, decimals)` -> it assumes 1 cToken = 1 Token?
    // Actually Suilend has cTokenExchangeRate.
    // Frontend `useUserPositions` used `depositedCtokenAmount` as `supplied`.
    // Wait, let's check frontend again.
    // In `useUserPositions`: `suppliedRaw = BigInt(deposit.depositedCtokenAmount)`.
    // It seems frontend simplified it or cToken ~ Token?
    // In `getAccountPortfolio` above, I used `rate` to convert.
    // `const rate = Number(reserve.cTokenExchangeRate) / 1e18;`
    // `const amount = (Number(rawAmount) / Math.pow(10, decimals)) * rate;`
    // So cToken != Token.
    // I should use the converted amount as the "Deposited Amount".

    const reserve = (this.client.lendingMarket.reserves as any[]).find(
      (r) => normalizeCoinType(r.coinType.name) === normalizeCoinType(coinType),
    );
    const rate = reserve ? Number(reserve.cTokenExchangeRate) / 1e18 : 1;
    const depositedAmount =
      (Number(depositedRaw) / Math.pow(10, decimals)) * rate;

    // If no borrows, can withdraw all
    if (!obligation.borrows || obligation.borrows.length === 0) {
      return depositedAmount.toFixed(6).replace(/\.?0+$/, "");
    }

    const oblAny = obligation as any;
    const allowedBorrow =
      Number(BigInt(oblAny.allowedBorrowValueUsd ?? 0)) / 1e18;
    const currentBorrow = Number(BigInt(oblAny.borrowedValueUsd ?? 0)) / 1e18;
    const excessValue = allowedBorrow - currentBorrow;

    if (excessValue <= 0) return "0";

    // Buffer 0.95
    const safeValue = excessValue * 0.95;

    // Need price to convert Value -> Amount
    const price = reserve ? Number(reserve.price) / 1e18 : 0;
    if (price === 0) return "0";

    const maxWithdrawValueAmount = safeValue / price; // This is amount * LTV weight?
    // Wait.
    // AllowedBorrow = CollateralValue * LTV.
    // If I withdraw X amount, CollateralValue decreases by X * Price.
    // AllowedBorrow decreases by X * Price * LTV.
    // We want RemainingAllowed >= CurrentBorrow.
    // (CollateralValue - X*Price) * LTV >= CurrentBorrow.
    // CollateralValue*LTV - X*Price*LTV >= CurrentBorrow.
    // AllowedBorrow - X*Price*LTV >= CurrentBorrow.
    // AllowedBorrow - CurrentBorrow >= X*Price*LTV.
    // ExcessValue >= X * Price * LTV.
    // X <= ExcessValue / (Price * LTV).

    // Frontend logic: `const maxWithdrawAmount = safeValue`?
    // Frontend code:
    // `const safeValue = excessValue * SAFETY_BUFFER`
    // `const maxWithdrawAmount = safeValue` -> This seems wrong if safeValue is USD?
    // It returns `finalAmount` which is `Math.min(maxWithdrawAmount, deposited)`.
    // Wait, `maxWithdrawAmount` in frontend snippet was `safeValue`.
    // If `safeValue` is USD, and `deposited` is Amount... comparing apples to oranges?
    // Let's re-read frontend `useMaxWithdraw`.

    // Frontend:
    // `const maxWithdrawAmount = safeValue`
    // `const finalAmount = Math.min(...)`.
    // If `safeValue` is USD, it assumes Price=1?
    // Ah, lines 398-399: "// Convert to amount (simplified)"
    // It didn't divide by price!
    // This looks like a bug in frontend code unless Price=1.
    // But I should implement it *correctly* in SDK.
    // Formula: MaxWithdrawAmount = (ExcessLiq / (Price * LTV)) * Buffer.
    // Wait, Suilend docs might differ.
    // Effectively: DeltaAllowed = Excess.
    // DeltaAllowed = WithdrawAmount * Price * LTV.
    // WithdrawAmount = Excess / (Price * LTV).

    const ltv = reserve ? Number(reserve.config.openLtvPct) / 100 : 0;
    if (ltv === 0) return depositedAmount.toFixed(6).replace(/\.?0+$/, ""); // If LTV 0, doesn't affect borrow limit? Or implies 0 collateral value.
    // If LTV is 0, then this asset didn't contribute to borrow limit. So withdrawing it doesn't lower borrow limit.
    // So we can withdraw ALL of it? Yes.

    // Wait, if LTV is 0, allowedBorrow doesn't change when we withdraw.
    // So we can withdraw max = deposited.

    let maxWithdrawAmount = 0;
    if (ltv > 0) {
      // safeValue is excess USD allowed.
      // We need to divide by (Price * LTV) to get amount.
      maxWithdrawAmount = safeValue / (price * ltv);
    } else {
      maxWithdrawAmount = depositedAmount;
    }

    const finalAmount = Math.min(maxWithdrawAmount, depositedAmount);
    return finalAmount.toFixed(6).replace(/\.?0+$/, "");
  }
}
