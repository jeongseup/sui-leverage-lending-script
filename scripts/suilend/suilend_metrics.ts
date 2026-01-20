import * as dotenv from "dotenv";
dotenv.config({ path: ".env.scripts" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuilendClient } from "@suilend/sdk/client";
import { LENDING_MARKET_ID, LENDING_MARKET_TYPE } from "@suilend/sdk/client";
import { parseReserve } from "@suilend/sdk/parsers/reserve";
import { parseObligation } from "@suilend/sdk/parsers/obligation";
import { refreshReservePrice } from "@suilend/sdk/utils/simulate";
import BigNumber from "bignumber.js";
import { CoinMetadata } from "@mysten/sui/client";
import { normalizeStructTag } from "@mysten/sui/utils";
import { formatCoinType } from "../../src/lib/utils";
import {
  calculateRewardApy,
  calculateRewardsEarned,
  calculateLiquidationPrice,
} from "../../src/lib/suilend/calculators";

// Setup
const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");
const secretKey = process.env.SECRET_KEY;

if (!secretKey) {
  console.error("Please set SECRET_KEY in .env");
  process.exit(1);
}

const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
const client = new SuiClient({ url: SUI_FULLNODE_URL });

async function main() {
  const userAddress = keypair.getPublicKey().toSuiAddress();
  console.log(`👤 User: ${userAddress}`);

  // 1. Initialize Suilend Client
  console.log("🔄 Connecting to Suilend...");
  const suilendClient = await SuilendClient.initialize(
    LENDING_MARKET_ID,
    LENDING_MARKET_TYPE,
    client,
  );

  // 2. Fetch Obligation ID
  console.log("🔍 Fetching obligation...");
  const obligations = await SuilendClient.getObligationOwnerCaps(
    userAddress,
    suilendClient.lendingMarket.$typeArgs,
    client,
  );

  if (obligations.length === 0) {
    console.log("❌ No obligation found for this account.");
    return;
  }

  const obligationOwnerCap = obligations[0];
  const obligationId = obligationOwnerCap.obligationId;
  console.log(`📝 Obligation ID: ${obligationId}`);

  // 3. Refresh Obligation (Update State for accuracy)
  const tx = new Transaction();
  try {
    const ob = await suilendClient.getObligation(obligationId);
    await suilendClient.refreshAll(tx, ob);
  } catch (e) {
    console.warn("Refresh warning:", e);
  }

  // Fetch fresh obligation data (raw)
  const obligation = await suilendClient.getObligation(obligationId);

  // 4. Fetch and Parse Reserves
  console.log("📊 Fetching and parsing reserves...");

  // In SDK, we use client.lendingMarket.reserves directly.
  // We skip refreshReservePrice to ensure data consistency with SDK and implicit types match.
  const reserves = suilendClient.lendingMarket.reserves;

  // Refresh price feeds first to get accurate USD values
  const refreshedReserves = await refreshReservePrice(
    reserves,
    suilendClient.pythConnection,
  );
  // const refreshedReserves = reserves;

  // Need CoinMetadata for parsing
  // Collect all coin types: Assets + Rewards
  const allCoinTypes = new Set<string>();

  refreshedReserves.forEach((r) => {
    allCoinTypes.add(r.coinType.name as string);

    // Deposits Rewards
    r.depositsPoolRewardManager.poolRewards.forEach((pr) => {
      if (pr) allCoinTypes.add(pr.coinType.name as string);
    });

    // Borrows Rewards
    r.borrowsPoolRewardManager.poolRewards.forEach((pr) => {
      if (pr) allCoinTypes.add(pr.coinType.name as string);
    });
  });

  const uniqueCoinTypes = Array.from(allCoinTypes);
  const coinMetadataMap: Record<string, CoinMetadata> = {};

  await Promise.all(
    uniqueCoinTypes.map(async (ct) => {
      try {
        const fixedType = formatCoinType(ct);
        const metadata = await client.getCoinMetadata({ coinType: fixedType });
        if (metadata) {
          // Store using the normalized tag that matches parseReserve expectation
          coinMetadataMap[normalizeStructTag(ct)] = metadata;
        }
      } catch (e) {
        console.warn(`⚠️ Failed to fetch metadata for ${ct}. Continuing...`);
      }
    }),
  );

  const parsedReserveMap: Record<string, any> = {};
  refreshedReserves.forEach((r) => {
    const parsed = parseReserve(r, coinMetadataMap);
    parsedReserveMap[parsed.coinType] = parsed;
  });

  // 5. Parse Obligation to get Metrics
  const parsedObligation = parseObligation(obligation, parsedReserveMap);

  // 6. Display Metrics
  console.log("\n📈 --- Suilend Position Metrics ---");

  // A. Net Value & Health
  const netValue = parsedObligation.netValueUsd;
  const totalSupply = parsedObligation.depositedAmountUsd;
  const totalBorrow = parsedObligation.weightedBorrowsUsd; // This is WEIGHTED borrow for HF
  const actualTotalBorrow = parsedObligation.borrowedAmountUsd; // Actual borrow amount
  const borrowLimit = parsedObligation.borrowLimitUsd;
  const liquidationThreshold = parsedObligation.unhealthyBorrowValueUsd;

  // Health Factor = Unhealthy Borrow Limit / Weighted Borrows
  const healthFactor = totalBorrow.eq(0)
    ? new BigNumber(Infinity)
    : liquidationThreshold.div(totalBorrow);

  console.log(`\n💰 Net Value: $${netValue.toFixed(2)}`);
  console.log(`📥 Total Supply: $${totalSupply.toFixed(2)}`);
  console.log(`📤 Total Borrow: $${actualTotalBorrow.toFixed(2)}`);
  console.log(`🛡️  Borrow Limit: $${borrowLimit.toFixed(2)}`);
  console.log(`⚠️  Liquidation Threshold: $${liquidationThreshold.toFixed(2)}`);
  console.log(
    `🏥 Health Factor: ${healthFactor.toFixed(4)} ${
      healthFactor.lt(1) ? "🔴 (LIQUIDATABLE)" : "🟢 (SAFE)"
    }`,
  );
  console.log(`   (Liquidated if HF < 1.0)`);

  // B. Looping Multiplier
  // Effective Leverage = Collateral / Equity = Supply / Net Value
  // Max Leverage = 1 / (1 - LTV)
  const effectiveLeverage = netValue.eq(0)
    ? new BigNumber(0)
    : totalSupply.div(netValue);

  // System LTV = Borrow Limit / Supply (Approximate based on Open LTV weighted)
  // Or better to use the weighted average OpenLTV of actual deposits
  let weightedOpenLtv = new BigNumber(0);
  if (totalSupply.gt(0)) {
    parsedObligation.deposits.forEach((d) => {
      const weight = d.depositedAmountUsd.div(totalSupply);
      weightedOpenLtv = weightedOpenLtv.plus(
        weight.times(d.reserve.config.openLtvPct / 100),
      );
    });
  }

  const currentLtv = weightedOpenLtv.toNumber();
  const maxLeverage = 1 / (1 - currentLtv);

  console.log(`\n🔄 Looping Multiplier (Leverage):`);
  console.log(`   Current Effective: ${effectiveLeverage.toFixed(2)}x`);
  console.log(
    `   Max Theoretical:   ~${maxLeverage.toFixed(
      2,
    )}x (based on weighted Open LTV: ${(currentLtv * 100).toFixed(1)}%)`,
  );

  const printEarnedRewards = (
    userRewardManager: any,
    reserve: any,
    isDeposit: boolean,
  ) => {
    const earnings = calculateRewardsEarned(
      userRewardManager,
      reserve,
      isDeposit,
    );
    earnings.forEach((e) => {
      const formatted =
        e.amount < 0.000001 ? e.amount.toExponential(4) : e.amount.toFixed(6);
      console.log(`      Rewards earned: ${formatted} ${e.symbol}`);
    });
  };

  // C. Interest Rates (APY)
  console.log("\n📉 Interest Rates (APY) & Earnings:");

  let totalAnnualIncomeUsd = new BigNumber(0);
  let totalAnnualCostUsd = new BigNumber(0);

  Object.values(parsedReserveMap).forEach((reserve: any) => {
    const userDeposit = parsedObligation.deposits.find(
      (d) => d.coinType === reserve.coinType,
    );
    const userBorrow = parsedObligation.borrows.find(
      (b) => b.coinType === reserve.coinType,
    );

    if (userDeposit || userBorrow) {
      console.log(`  ${reserve.token.symbol}:`);

      // --- Supply Side ---
      const supplyApy = reserve.depositAprPercent.toNumber();
      const totalDepositedUsd = new BigNumber(reserve.depositedAmountUsd);

      const supplyRewards = calculateRewardApy(
        reserve.depositsPoolRewardManager,
        totalDepositedUsd,
        parsedReserveMap,
        { DEEP: 0.001 },
      );
      const totalSupplyApy = supplyApy + supplyRewards.totalRewardApy;

      if (userDeposit) {
        const myDepositUsd = new BigNumber(userDeposit.depositedAmountUsd);
        const myAnnualIncome = myDepositUsd.times(totalSupplyApy).div(100);
        totalAnnualIncomeUsd = totalAnnualIncomeUsd.plus(myAnnualIncome);
      }

      console.log(`    Supply APY: ${totalSupplyApy.toFixed(2)}%`);
      console.log(`      Interest: ${supplyApy.toFixed(2)}%`);
      supplyRewards.rewardsDetails.forEach((r) => {
        const match = r.match(/\+ Reward \((.+)\): (.+)%/);
        if (match) {
          console.log(`      Rewards in ${match[1]} (${match[2]}%)`);
        } else {
          console.log(`      ${r.replace("+", "Rewards in")}`);
        }
      });

      if (userDeposit) {
        console.log(
          `    [My Deposit]: $${userDeposit.depositedAmountUsd.toFixed(2)}`,
        );
        printEarnedRewards(userDeposit.userRewardManager, reserve, true);
      }

      // --- Borrow Side ---
      const borrowApr = reserve.borrowAprPercent.toNumber();
      const totalBorrowedUsd = new BigNumber(reserve.borrowedAmountUsd);

      const borrowRewards = calculateRewardApy(
        reserve.borrowsPoolRewardManager,
        totalBorrowedUsd,
        parsedReserveMap,
        { DEEP: 0.001 },
      );
      // Net Borrow APR = Interest - Rewards
      const netBorrowApr = borrowApr - borrowRewards.totalRewardApy;

      if (userBorrow) {
        const myBorrowUsd = new BigNumber(userBorrow.borrowedAmountUsd);
        // Cost is Interest - Rewards. (If rewards > interest, cost is negative = income)
        const myAnnualCost = myBorrowUsd.times(netBorrowApr).div(100);
        totalAnnualCostUsd = totalAnnualCostUsd.plus(myAnnualCost);
      }

      console.log(`    Borrow APR: ${netBorrowApr.toFixed(2)}%`);
      console.log(`      Interest: ${borrowApr.toFixed(2)}%`);
      if (borrowRewards.totalRewardApy > 0) {
        borrowRewards.rewardsDetails.forEach((r) => {
          const match = r.match(/\+ Reward \((.+)\): (.+)%/);
          if (match) {
            console.log(`      Rewards in ${match[1]} (${match[2]}%)`);
          }
        });
      }

      if (userBorrow) {
        console.log(
          `    [My Borrow]:  $${userBorrow.borrowedAmountUsd.toFixed(2)}`,
        );
        printEarnedRewards(userBorrow.userRewardManager, reserve, false);
      }
    }
  });

  // Calculate Net APY on Equity
  // Net APY = (Total Annual Income - Total Annual Cost) / Net Value
  if (netValue.gt(0)) {
    const netAnnualEarnings = totalAnnualIncomeUsd.minus(totalAnnualCostUsd);
    const netApy = netAnnualEarnings.div(netValue).times(100);

    console.log(`\n📊 Account Summary:`);
    console.log(`   Net Value (Equity): $${netValue.toFixed(2)}`);
    console.log(`   Net APY (on Equity): ${netApy.toFixed(2)}%`);
    console.log(
      `     (Approx. Annual Net Earnings: $${netAnnualEarnings.toFixed(2)})`,
    );
    console.log(
      `   Note: Net APY reflects the annualized return on your equity, factoring in all interest and rewards.`,
    );
  }

  // D. Liquidation Price Estimation
  console.log("\n💥 Liquidation Price Estimation:");
  console.log(
    "   (Estimates price of collateral at which HF becomes 1.0, assuming other assets constant)",
  );

  if (parsedObligation.deposits.length === 0) {
    console.log("   No deposits found.");
  } else if (totalBorrow.eq(0)) {
    console.log("   No debt, cannot be liquidated.");
  } else {
    parsedObligation.deposits.forEach((deposit) => {
      const amountBig = new BigNumber(deposit.depositedAmount);
      const liqPrice = calculateLiquidationPrice(
        deposit.reserve.coinType,
        amountBig,
        deposit.reserve.config.closeLtvPct / 100,
        parsedObligation,
      );

      if (!liqPrice) {
        console.log(
          `   ${deposit.reserve.token.symbol}: Safe from liquidation even if price drops to 0 (covered by other assets).`,
        );
      } else {
        const currentPrice = deposit.reserve.price;
        const dropToLiq = currentPrice
          .minus(liqPrice)
          .div(currentPrice)
          .times(100);

        console.log(
          `   ${deposit.reserve.token.symbol} Liq Price: ~$${liqPrice.toFixed(
            4,
          )} (-${dropToLiq.toFixed(2)}%)`,
        );
      }
    });
  }
}

main().catch(console.error);
