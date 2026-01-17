import * as dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.public" });

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  fetchNaviPoolData,
  fetchNaviUserData,
  fetchNaviAccountSummary,
  calculateLeverageMultiplier,
} from "../../src/lib/navi_calculations";

async function main() {
  console.log("─".repeat(55));
  console.log("  🧪 Testing navi_calculations.ts");
  console.log("─".repeat(55));

  // Get user address
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey) {
    console.error("❌ SECRET_KEY not found");
    return;
  }
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  const userAddress = keypair.getPublicKey().toSuiAddress();
  console.log(`\n👤 Wallet: ${userAddress}`);

  try {
    // Test 1: fetchNaviPoolData
    console.log(`\n📊 Test 1: fetchNaviPoolData()`);
    console.log("─".repeat(55));
    const poolMap = await fetchNaviPoolData();
    console.log(`  Total pools: ${poolMap.size}`);

    // Show some pool info
    const suiPool = poolMap.get(
      "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
    );
    if (suiPool) {
      console.log(`\n  SUI Pool:`);
      console.log(`    Symbol: ${suiPool.symbol}`);
      console.log(`    Supply APY: ${suiPool.supplyApy.toFixed(2)}%`);
      console.log(`    Borrow APY: ${suiPool.borrowApy.toFixed(2)}%`);
      console.log(
        `    Liquidation Threshold: ${(suiPool.liquidationThreshold * 100).toFixed(0)}%`
      );
      console.log(`    LTV: ${(suiPool.ltv * 100).toFixed(0)}%`);

      // Test leverage calculation
      const leverage = calculateLeverageMultiplier(suiPool);
      console.log(`    Max Leverage: ${leverage.maxLeverage}x`);
      console.log(`    Safe Leverage: ${leverage.safeLeverage}x`);
    }

    // Test 2: fetchNaviUserData
    console.log(`\n📊 Test 2: fetchNaviUserData()`);
    console.log("─".repeat(55));
    const positions = await fetchNaviUserData(userAddress, poolMap);
    console.log(`  Active positions: ${positions.length}`);

    for (const pos of positions) {
      console.log(`\n  ${pos.symbol}:`);
      console.log(`    Price: $${pos.price.toFixed(4)}`);
      console.log(
        `    Supply: ${pos.supplyAmount.toFixed(6)} ($${pos.supplyValueUsd.toFixed(2)})`
      );
      console.log(
        `    Borrow: ${pos.borrowAmount.toFixed(6)} ($${pos.borrowValueUsd.toFixed(2)})`
      );
      console.log(`    Supply APY: ${pos.supplyApy.toFixed(2)}%`);
      console.log(`    Borrow APY: ${pos.borrowApy.toFixed(2)}%`);
      console.log(
        `    Liquidation Threshold: ${(pos.liquidationThreshold * 100).toFixed(0)}%`
      );
      console.log(`    Liquidation Price: $${pos.liquidationPrice.toFixed(4)}`);
    }

    // Test 3: fetchNaviAccountSummary
    console.log(`\n📊 Test 3: fetchNaviAccountSummary()`);
    console.log("─".repeat(55));
    const summary = await fetchNaviAccountSummary(userAddress, poolMap);

    console.log(`\n  Account Summary:`);
    console.log(
      `    Total Supply:     $${summary.totalSupplyValueUsd.toFixed(2)}`
    );
    console.log(
      `    Total Borrow:     $${summary.totalBorrowValueUsd.toFixed(2)}`
    );
    console.log(
      `    Total Collateral: $${summary.totalCollateralValueUsd.toFixed(2)} (risk-adjusted)`
    );
    console.log(`    Net Worth:        $${summary.netWorthUsd.toFixed(2)}`);
    console.log(`    Health Factor:    ${summary.healthFactor.toFixed(2)}`);
    console.log(
      `    Weighted Supply APY: ${summary.weightedSupplyApy.toFixed(2)}%`
    );
    console.log(
      `    Weighted Borrow APY: ${summary.weightedBorrowApy.toFixed(2)}%`
    );
    console.log(`    Net APY:          ${summary.netApy.toFixed(2)}%`);

    console.log(`\n` + "─".repeat(55));
    console.log(`  ✅ All tests passed!`);
    console.log("─".repeat(55));
  } catch (error: any) {
    console.error(`\n❌ ERROR: ${error.message || error}`);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

main();
