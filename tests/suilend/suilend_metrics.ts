import * as dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.public" });

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
    client
  );

  // 2. Fetch Obligation ID
  console.log("🔍 Fetching obligation...");
  const obligations = await SuilendClient.getObligationOwnerCaps(
    userAddress,
    suilendClient.lendingMarket.$typeArgs,
    client
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
  const reserves = suilendClient.lendingMarket.reserves;

  // Refresh price feeds first to get accurate USD values
  const refreshedReserves = await refreshReservePrice(
    reserves,
    suilendClient.pythConnection
  );

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
    })
  );

  const parsedReserveMap: Record<string, any> = {};
  refreshedReserves.forEach((r) => {
    // Ensure we have metadata or fallback for ALL related tokens
    [
      r.coinType.name,
      ...r.depositsPoolRewardManager.poolRewards.map((pr) => pr?.coinType.name),
      ...r.borrowsPoolRewardManager.poolRewards.map((pr) => pr?.coinType.name),
    ]
      .filter(Boolean)
      .forEach((rawType) => {
        const ct = normalizeStructTag(rawType as string);
        if (!coinMetadataMap[ct]) {
          // Mock fallback
          const parts = rawType!.split("::");
          const symbol = parts.length > 2 ? parts[2] : "UNKNOWN";
          coinMetadataMap[ct] = {
            decimals: 9,
            name: rawType!,
            symbol: symbol,
            description: "Mocked Metadata",
            iconUrl: "",
            id: "",
          } as CoinMetadata;
        }
      });

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
    }`
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
        weight.times(d.reserve.config.openLtvPct / 100)
      );
    });
  }

  const currentLtv = weightedOpenLtv.toNumber();
  const maxLeverage = 1 / (1 - currentLtv);

  console.log(`\n🔄 Looping Multiplier (Leverage):`);
  console.log(`   Current Effective: ${effectiveLeverage.toFixed(2)}x`);
  console.log(
    `   Max Theoretical:   ~${maxLeverage.toFixed(
      2
    )}x (based on weighted Open LTV: ${(currentLtv * 100).toFixed(1)}%)`
  );

  // C. Interest Rates (APY)
  console.log("\n📉 Interest Rates (APY):");
  Object.values(parsedReserveMap).forEach((reserve: any) => {
    // Check if user has deposit or borrow in this asset
    const userDeposit = parsedObligation.deposits.find(
      (d) => d.coinType === reserve.coinType
    );
    const userBorrow = parsedObligation.borrows.find(
      (b) => b.coinType === reserve.coinType
    );

    if (userDeposit || userBorrow) {
      console.log(`  ${reserve.token.symbol}:`);
      console.log(`    Supply APY: ${reserve.depositAprPercent.toFixed(2)}%`);
      console.log(`    Borrow APY: ${reserve.borrowAprPercent.toFixed(2)}%`);
      // console.log(`    Utilization: ${reserve.utilizationPercent.toFixed(2)}%`);
      if (userDeposit)
        console.log(
          `    [My Deposit]: $${userDeposit.depositedAmountUsd.toFixed(2)}`
        );
      if (userBorrow)
        console.log(
          `    [My Borrow]:  $${userBorrow.borrowedAmountUsd.toFixed(2)}`
        );
    }
  });

  // D. Liquidation Price Estimation
  console.log("\n💥 Liquidation Price Estimation:");
  console.log(
    "   (Estimates price of collateral at which HF becomes 1.0, assuming other assets constant)"
  );

  if (parsedObligation.deposits.length === 0) {
    console.log("   No deposits found.");
  } else if (totalBorrow.eq(0)) {
    console.log("   No debt, cannot be liquidated.");
  } else {
    parsedObligation.deposits.forEach((deposit) => {
      const closeLtv = deposit.reserve.config.closeLtvPct / 100;

      // Current Contribution of this deposit to Unhealthy Limit = Amount * Price * CloseLTV
      const currentContribution = deposit.depositedAmountUsd.times(closeLtv);

      // Limit from OTHER collaterals
      const otherCollateralLimit =
        liquidationThreshold.minus(currentContribution);

      // We need: WeightedBorrow <= NewContribution + OtherLimit
      // NewContribution >= WeightedBorrow - OtherLimit
      // Amount * NewPrice * CloseLTV >= WeightedBorrow - OtherLimit
      // NewPrice >= (WeightedBorrow - OtherLimit) / (Amount * CloseLTV)

      const numerator = totalBorrow.minus(otherCollateralLimit);

      if (numerator.lte(0)) {
        console.log(
          `   ${deposit.reserve.token.symbol}: Safe from liquidation even if price drops to 0 (covered by other assets).`
        );
      } else {
        const liqPrice = numerator.div(deposit.depositedAmount.times(closeLtv));
        const currentPrice = deposit.reserve.price;
        const dropToLiq = currentPrice
          .minus(liqPrice)
          .div(currentPrice)
          .times(100);

        console.log(
          `   ${deposit.reserve.token.symbol} Liq Price: ~$${liqPrice.toFixed(
            4
          )} (-${dropToLiq.toFixed(2)}%)`
        );
      }
    });
  }
}

main().catch(console.error);
