import BigNumber from "bignumber.js";
import { normalizeStructTag } from "@mysten/sui/utils";

/**
 * Calculate Reward APY for a pool
 */
export const calculateRewardApy = (
  rewardManager: any,
  depositOrBorrowUsd: BigNumber,
  parsedReserveMap: any,
  coinScaleMap: Record<string, number> = {},
) => {
  let totalRewardApy = 0;
  const rewardsDetails: string[] = [];
  const nowMs = Date.now();

  if (!rewardManager || !rewardManager.poolRewards)
    return { totalRewardApy, rewardsDetails };

  rewardManager.poolRewards.forEach((pr: any) => {
    if (!pr) return;
    const startTime = Number(pr.startTimeMs);
    const endTime = Number(pr.endTimeMs);

    if (nowMs >= startTime && nowMs <= endTime) {
      const totalRewards = new BigNumber(pr.totalRewards);
      const durationMs = endTime - startTime;
      const durationYear = durationMs / (1000 * 60 * 60 * 24 * 365);
      if (durationYear === 0) return;

      const rewardsPerYear = totalRewards.div(durationYear);

      const ct =
        pr.coinType && pr.coinType.name ? pr.coinType.name : pr.coinType;
      if (!ct) return;

      const rewardCoinType = normalizeStructTag(ct);
      const rewardReserve = parsedReserveMap[rewardCoinType];
      const rewardPrice = rewardReserve ? rewardReserve.price : 0;

      if (rewardPrice > 0) {
        let adjustedRewardsPerYear = rewardsPerYear;
        if (pr.symbol && coinScaleMap[pr.symbol]) {
          adjustedRewardsPerYear = rewardsPerYear.times(
            coinScaleMap[pr.symbol],
          );
        } else if (pr.symbol === "DEEP") {
          // Default behavior for SDK context if map is empty?
          // No, SDK calls with explicit map now.
          // If we remove the hardcoded fix, SDK MUST provide map.
          // We configured SDK to provide map.
        }

        const rewardValuePerYear = adjustedRewardsPerYear.times(rewardPrice);
        if (depositOrBorrowUsd.gt(0)) {
          const apy = rewardValuePerYear.div(depositOrBorrowUsd).times(100);
          rewardsDetails.push(
            `    + Reward (${pr.symbol}): ${apy.toFixed(2)}%`,
          );
          totalRewardApy += apy.toNumber();
        }
      }
    }
  });
  return { totalRewardApy, rewardsDetails };
};

/**
 * Calculate earned rewards (Checkpointed + Pending)
 */
export const calculateRewardsEarned = (
  userRewardManager: any,
  reserve: any,
  isDeposit: boolean,
): { symbol: string; amount: number }[] => {
  const earnings: { symbol: string; amount: number }[] = [];

  if (!userRewardManager || !userRewardManager.rewards) return earnings;

  const manager = isDeposit
    ? reserve.depositsPoolRewardManager
    : reserve.borrowsPoolRewardManager;
  if (!manager || !manager.poolRewards) return earnings;

  userRewardManager.rewards.forEach((r: any) => {
    if (!r) return;

    // 1. Checkpointed Earned Rewards (Atomic * 1e18)
    const earnedRaw = r.earnedRewards
      ? new BigNumber(r.earnedRewards.value)
      : new BigNumber(0);

    const poolReward = manager.poolRewards.find(
      (pr: any) => pr.id === r.poolRewardId,
    );

    let decimals = 0;
    let symbol = "???";
    let pendingHuman = new BigNumber(0);

    if (poolReward) {
      decimals = poolReward.mintDecimals;
      symbol = poolReward.symbol;

      // 2. Pending Rewards
      const poolCumulativeHuman = new BigNumber(
        poolReward.cumulativeRewardsPerShare,
      );
      const userCumulativeRaw = r.cumulativeRewardsPerShare
        ? new BigNumber(r.cumulativeRewardsPerShare.value)
        : new BigNumber(0);
      const userCumulativeHuman = userCumulativeRaw
        .div(new BigNumber(10).pow(18))
        .div(new BigNumber(10).pow(decimals));

      const share = new BigNumber(userRewardManager.share);

      const pending = poolCumulativeHuman
        .minus(userCumulativeHuman)
        .times(share);
      if (pending.gt(0)) pendingHuman = pending;
    } else {
      // Skip pending if pool reward not found
      return;
    }

    // 3. Normalize
    const effectiveDecimals = symbol === "DEEP" ? 3 : decimals;
    const earnedHuman = earnedRaw
      .div(new BigNumber(10).pow(18))
      .div(new BigNumber(10).pow(effectiveDecimals));
    const totalHuman = earnedHuman.plus(pendingHuman);

    if (totalHuman.gt(0)) {
      earnings.push({
        symbol,
        amount: totalHuman.toNumber(),
      });
    }
  });

  return earnings;
};

/**
 * Interface for Aggregated Portfolio Data
 */
export interface PortfolioMetrics {
  netValue: BigNumber;
  totalSupply: BigNumber;
  totalBorrow: BigNumber;
  borrowLimit: BigNumber;
  liquidationThreshold: BigNumber;
  healthFactor: BigNumber;
  netApy: BigNumber;
  totalAnnualNetEarnings: BigNumber;
  weightedOpenLtv: BigNumber;
}

/**
 * Calculate all portfolio metrics
 */
export const calculatePortfolioMetrics = (
  parsedObligation: any,
  parsedReserveMap: any,
): PortfolioMetrics => {
  // Basic Metrics
  const netValue = new BigNumber(parsedObligation.netValueUsd);
  const totalSupply = new BigNumber(parsedObligation.depositedAmountUsd);
  const totalBorrow = new BigNumber(parsedObligation.borrowedAmountUsd);
  const borrowLimit = new BigNumber(parsedObligation.borrowLimitUsd);
  const liquidationThreshold = new BigNumber(
    parsedObligation.unhealthyBorrowValueUsd,
  );
  const weightedBorrows = new BigNumber(parsedObligation.weightedBorrowsUsd);

  const healthFactor = weightedBorrows.eq(0)
    ? new BigNumber(Infinity)
    : liquidationThreshold.div(weightedBorrows);

  // Weighted LTV
  let weightedOpenLtv = new BigNumber(0);
  if (totalSupply.gt(0)) {
    parsedObligation.deposits.forEach((d: any) => {
      const weight = new BigNumber(d.depositedAmountUsd).div(totalSupply);
      weightedOpenLtv = weightedOpenLtv.plus(
        weight.times(d.reserve.config.openLtvPct / 100),
      );
    });
  }

  // Net APY & Earnings
  let totalAnnualIncomeUsd = new BigNumber(0);
  let totalAnnualCostUsd = new BigNumber(0);

  Object.values(parsedReserveMap).forEach((reserve: any) => {
    const userDeposit = parsedObligation.deposits.find(
      (d: any) => d.coinType === reserve.coinType,
    );
    const userBorrow = parsedObligation.borrows.find(
      (b: any) => b.coinType === reserve.coinType,
    );

    if (userDeposit) {
      const supplyApy = reserve.depositAprPercent.toNumber();
      const totalDepositedUsd = new BigNumber(reserve.depositedAmountUsd);
      const supplyRewards = calculateRewardApy(
        reserve.depositsPoolRewardManager,
        totalDepositedUsd,
        parsedReserveMap,
      );
      const totalSupplyApy = supplyApy + supplyRewards.totalRewardApy;

      const myDepositUsd = new BigNumber(userDeposit.depositedAmountUsd);
      const myAnnualIncome = myDepositUsd.times(totalSupplyApy).div(100);
      totalAnnualIncomeUsd = totalAnnualIncomeUsd.plus(myAnnualIncome);
    }

    if (userBorrow) {
      const borrowApr = reserve.borrowAprPercent.toNumber();
      const totalBorrowedUsd = new BigNumber(reserve.borrowedAmountUsd);
      const borrowRewards = calculateRewardApy(
        reserve.borrowsPoolRewardManager,
        totalBorrowedUsd,
        parsedReserveMap,
      );
      const netBorrowApr = borrowApr - borrowRewards.totalRewardApy;

      const myBorrowUsd = new BigNumber(userBorrow.borrowedAmountUsd);
      const myAnnualCost = myBorrowUsd.times(netBorrowApr).div(100);
      totalAnnualCostUsd = totalAnnualCostUsd.plus(myAnnualCost);
    }
  });

  const totalAnnualNetEarnings = totalAnnualIncomeUsd.minus(totalAnnualCostUsd);
  const netApy = netValue.gt(0)
    ? totalAnnualNetEarnings.div(netValue).times(100)
    : new BigNumber(0);

  return {
    netValue,
    totalSupply,
    totalBorrow,
    borrowLimit,
    liquidationThreshold,
    healthFactor,
    netApy,
    totalAnnualNetEarnings,
    weightedOpenLtv,
  };
};

/**
 * Calculate Liquidation Price for a specific collateral
 * Assuming other assets remain constant.
 * HF = ( (Price * Amount * LiqThreshold) + OtherCollateralWeighted ) / WeightedBorrows
 * 1.0 = ( (P_liq * Amount * LiqThreshold) + OtherCollateralWeighted ) / WeightedBorrows
 * WeightedBorrows - OtherCollateralWeighted = P_liq * Amount * LiqThreshold
 * P_liq = (WeightedBorrows - OtherCollateralWeighted) / (Amount * LiqThreshold)
 */
export const calculateLiquidationPrice = (
  coinType: string,
  amount: BigNumber,
  liquidationThreshold: number, // e.g. 0.8
  parsedObligation: any,
): BigNumber | null => {
  // 1. Get Total Weighted Borrows
  const totalWeightedBorrows = new BigNumber(
    parsedObligation.weightedBorrowsUsd,
  );

  // 2. Calculate Other Collateral Weighted Value
  let otherCollateralWeighted = new BigNumber(0);

  // We need to iterate deposits to find "others"
  if (parsedObligation.deposits) {
    parsedObligation.deposits.forEach((d: any) => {
      if (d.coinType === coinType) return; // Skip the target asset

      // Weight = Close LTV (Liquidation Threshold)
      const ltv = d.reserve.config.closeLtvPct / 100;
      const value = new BigNumber(d.depositedAmountUsd);
      otherCollateralWeighted = otherCollateralWeighted.plus(value.times(ltv));
    });
  }

  // 3. Solve for P_liq
  const numerator = totalWeightedBorrows.minus(otherCollateralWeighted);
  // If Numerator < 0, it means other collateral is already enough to cover borrows (HF > 1 even if P=0)
  if (numerator.lte(0)) return new BigNumber(0);

  // Denominator = Amount * LiqThreshold
  // Amount is token units
  const denominator = amount.times(liquidationThreshold);

  if (denominator.eq(0)) return null;

  return numerator.div(denominator);
};
