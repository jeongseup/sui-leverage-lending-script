/**
 * Navi Protocol Calculation Utilities
 */

import {
  getLendingState,
  getPools,
  normalizeCoinType,
} from "@naviprotocol/lending";
import { getTokenPrice } from "@7kprotocol/sdk-ts";

// ============================================================================
// Type Definitions
// ============================================================================

export interface NaviPoolInfo {
  coinType: string;
  symbol: string;
  decimals: number;
  supplyApy: number;
  borrowApy: number;
  liquidationThreshold: number;
  ltv: number;
  totalSupply: number;
  totalBorrow: number;
  availableLiquidity: number;
  utilizationRate: number;
  rawPool: any;
}

export interface NaviUserPosition {
  coinType: string;
  symbol: string;
  decimals: number;
  price: number;
  // Supply
  supplyAmount: number;
  supplyValueUsd: number;
  supplyApy: number;
  // Borrow
  borrowAmount: number;
  borrowValueUsd: number;
  borrowApy: number;
  // Risk
  liquidationThreshold: number;
  liquidationPrice: number; // 이 담보가 청산되는 가격
}

export interface NaviAccountSummary {
  positions: NaviUserPosition[];
  totalSupplyValueUsd: number;
  totalBorrowValueUsd: number;
  totalCollateralValueUsd: number;
  netWorthUsd: number;
  healthFactor: number;
  weightedSupplyApy: number;
  weightedBorrowApy: number;
  netApy: number;
}

export interface LeverageInfo {
  maxLeverage: number;
  safeLeverage: number;
  targetLtv: number;
}

// ============================================================================
// Data Fetching Functions
// ============================================================================

export async function fetchNaviPoolData(): Promise<Map<string, NaviPoolInfo>> {
  const pools = await getPools({ env: "prod" });
  const poolsArray: any[] = Array.isArray(pools) ? pools : Object.values(pools);

  const poolMap = new Map<string, NaviPoolInfo>();

  for (const pool of poolsArray) {
    const coinType = normalizeCoinType(pool.coinType ?? pool.suiCoinType ?? "");
    if (!coinType) continue;

    const decimals = pool.token?.decimals ?? 9;
    const symbol = pool.token?.symbol ?? pool.symbol ?? "UNKNOWN";

    const supplyApy = parseFloat(
      pool.supplyApy ?? pool.supplyIncentiveApyInfo?.apy ?? "0"
    );
    const borrowApy = parseFloat(
      pool.borrowApy ?? pool.borrowIncentiveApyInfo?.apy ?? "0"
    );

    const liquidationThreshold = parseFloat(
      pool.liquidationFactor?.threshold ?? "0.8"
    );
    // LTV is stored as scaled by 1e27 in Navi
    const rawLtv = parseFloat(pool.ltv ?? "0");
    const ltv = rawLtv > 1 ? rawLtv / 1e27 : rawLtv || 0.75;

    const totalSupply =
      parseFloat(pool.totalSupply ?? "0") / Math.pow(10, decimals);
    const totalBorrow =
      parseFloat(pool.totalBorrow ?? "0") / Math.pow(10, decimals);

    poolMap.set(coinType, {
      coinType,
      symbol,
      decimals,
      supplyApy,
      borrowApy,
      liquidationThreshold,
      ltv,
      totalSupply,
      totalBorrow,
      availableLiquidity: totalSupply - totalBorrow,
      utilizationRate: totalSupply > 0 ? totalBorrow / totalSupply : 0,
      rawPool: pool,
    });
  }

  return poolMap;
}

export async function fetchNaviUserData(
  userAddress: string,
  poolMap?: Map<string, NaviPoolInfo>
): Promise<NaviUserPosition[]> {
  const lendingState = await getLendingState(userAddress, { env: "prod" });
  const pools = poolMap ?? (await fetchNaviPoolData());

  // 1차: position 데이터 수집
  const rawPositions: Omit<NaviUserPosition, "liquidationPrice">[] = [];

  for (const pos of lendingState) {
    const coinType = normalizeCoinType(pos.pool.coinType);
    const pool = pools.get(coinType);
    if (!pool) continue;

    const supplyBalance = BigInt(pos.supplyBalance);
    const borrowBalance = BigInt(pos.borrowBalance);

    if (supplyBalance <= 0n && borrowBalance <= 0n) continue;

    const price = await getTokenPrice(coinType);
    const supplyAmount = Number(supplyBalance) / Math.pow(10, pool.decimals);
    const borrowAmount = Number(borrowBalance) / Math.pow(10, pool.decimals);

    rawPositions.push({
      coinType,
      symbol: pool.symbol,
      decimals: pool.decimals,
      price,
      supplyAmount,
      supplyValueUsd: supplyAmount * price,
      supplyApy: pool.supplyApy,
      borrowAmount,
      borrowValueUsd: borrowAmount * price,
      borrowApy: pool.borrowApy,
      liquidationThreshold: pool.liquidationThreshold,
    });
  }

  // 2차: 전체 borrow 합계 계산
  const totalBorrowValueUsd = rawPositions.reduce(
    (sum, p) => sum + p.borrowValueUsd,
    0
  );

  // 3차: 각 position에 liquidationPrice 계산
  const positions: NaviUserPosition[] = rawPositions.map((pos) => {
    // liquidationPrice = totalBorrowValueUsd / (supplyAmount * liquidationThreshold)
    let liquidationPrice = 0;
    if (pos.supplyAmount > 0 && pos.liquidationThreshold > 0) {
      liquidationPrice =
        totalBorrowValueUsd / (pos.supplyAmount * pos.liquidationThreshold);
    }

    return {
      ...pos,
      liquidationPrice,
    };
  });

  return positions;
}

export async function fetchNaviAccountSummary(
  userAddress: string,
  poolMap?: Map<string, NaviPoolInfo>
): Promise<NaviAccountSummary> {
  const pools = poolMap ?? (await fetchNaviPoolData());
  const positions = await fetchNaviUserData(userAddress, pools);

  let totalSupplyValueUsd = 0;
  let totalBorrowValueUsd = 0;
  let totalCollateralValueUsd = 0;
  let weightedSupplyApy = 0;
  let weightedBorrowApy = 0;

  for (const pos of positions) {
    totalSupplyValueUsd += pos.supplyValueUsd;
    totalBorrowValueUsd += pos.borrowValueUsd;
    totalCollateralValueUsd += pos.supplyValueUsd * pos.liquidationThreshold;
    weightedSupplyApy += pos.supplyApy * pos.supplyValueUsd;
    weightedBorrowApy += pos.borrowApy * pos.borrowValueUsd;
  }

  if (totalSupplyValueUsd > 0) {
    weightedSupplyApy = weightedSupplyApy / totalSupplyValueUsd;
  }
  if (totalBorrowValueUsd > 0) {
    weightedBorrowApy = weightedBorrowApy / totalBorrowValueUsd;
  }

  const netWorthUsd = totalSupplyValueUsd - totalBorrowValueUsd;
  const healthFactor =
    totalBorrowValueUsd > 0
      ? totalCollateralValueUsd / totalBorrowValueUsd
      : 999;

  // Net APY 계산
  let netApy = 0;
  if (netWorthUsd > 0) {
    const supplyInterest = totalSupplyValueUsd * (weightedSupplyApy / 100);
    const borrowInterest = totalBorrowValueUsd * (weightedBorrowApy / 100);
    netApy = ((supplyInterest - borrowInterest) / netWorthUsd) * 100;
  }

  return {
    positions,
    totalSupplyValueUsd,
    totalBorrowValueUsd,
    totalCollateralValueUsd,
    netWorthUsd,
    healthFactor,
    weightedSupplyApy,
    weightedBorrowApy,
    netApy,
  };
}

// ============================================================================
// Leverage Calculation (Pool 기반)
// ============================================================================

export function calculateLeverageMultiplier(
  pool: NaviPoolInfo,
  safetyBuffer: number = 0.05,
  executionBuffer: number = 0.95
): LeverageInfo {
  const targetLtv = pool.liquidationThreshold - safetyBuffer;

  if (targetLtv >= 1 || targetLtv <= 0) {
    return { maxLeverage: 1, safeLeverage: 1, targetLtv: 0 };
  }

  const theoreticalMax = 1 / (1 - targetLtv);
  const safeLeverage = theoreticalMax * executionBuffer;

  return {
    maxLeverage: Number(theoreticalMax.toFixed(2)),
    safeLeverage: Number(safeLeverage.toFixed(2)),
    targetLtv: Number(targetLtv.toFixed(4)),
  };
}

// ============================================================================
// Example Usage
// ============================================================================

/**
 * ```typescript
 * const summary = await fetchNaviAccountSummary(address);
 *
 * // 전체 요약
 * console.log("Health Factor:", summary.healthFactor);
 * console.log("Net APY:", summary.netApy);
 * console.log("Net Worth:", summary.netWorthUsd);
 *
 * // 각 position 정보
 * for (const pos of summary.positions) {
 *   console.log(`${pos.symbol}:`);
 *   console.log(`  Supply: ${pos.supplyAmount} ($${pos.supplyValueUsd})`);
 *   console.log(`  Borrow: ${pos.borrowAmount} ($${pos.borrowValueUsd})`);
 *   console.log(`  Liquidation Price: $${pos.liquidationPrice}`);
 * }
 *
 * // 레버리지 계산
 * const poolMap = await fetchNaviPoolData();
 * const suiPool = poolMap.get("0x2::sui::SUI");
 * const leverage = calculateLeverageMultiplier(suiPool);
 * console.log("Safe Leverage:", leverage.safeLeverage);
 * ```
 */
