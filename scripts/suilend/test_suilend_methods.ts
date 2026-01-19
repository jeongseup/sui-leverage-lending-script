import * as dotenv from "dotenv";
dotenv.config();

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { SuilendAdapter } from "../../src/protocols/suilend";
import { normalizeCoinType } from "../../src/lib/utils";

// Helpers
function log(msg: string) {
  console.log(msg);
}

async function main() {
  const SUI_FULLNODE_URL =
    process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");
  const TEST_ADDRESS = process.env.TEST_ADDRESS || process.argv[2];

  if (!TEST_ADDRESS) {
    console.error(
      "Usage: npx ts-node scripts/suilend/test_suilend_methods.ts <ADDRESS>",
    );
    process.exit(1);
  }

  log(`Testing SuilendAdapter with address: ${TEST_ADDRESS}`);

  const client = new SuiClient({ url: SUI_FULLNODE_URL });
  const adapter = new SuilendAdapter();
  await adapter.initialize(client);

  // 1. Get Markets
  log("\n--- Markets (Top 3) ---");
  const rawReserves = (adapter.getSuilendClient().lendingMarket as any)
    .reserves;
  if (rawReserves.length > 0) {
    log("DEBUG Raw Reserve 0 keys: " + Object.keys(rawReserves[0]).join(", "));
    log("DEBUG Reserve 0 Price: " + JSON.stringify(rawReserves[0].price));
    log("DEBUG Reserve 0 APY: " + JSON.stringify(rawReserves[0].depositApy));
  }

  const markets = await adapter.getMarkets();
  markets.slice(0, 3).forEach((m) => {
    log(
      `${m.symbol}: Price $${m.price.toFixed(2)}, SupplyAPY ${m.supplyApy.toFixed(2)}%`,
    );
  });

  // 2. Portfolio
  log("\n--- Portfolio ---");
  const portfolio = await adapter.getAccountPortfolio(TEST_ADDRESS);
  log(`Health Factor: ${portfolio.healthFactor}`);
  log(`Net Value: $${portfolio.netValueUsd.toFixed(2)}`);

  portfolio.positions.forEach((p) => {
    log(
      `[${p.side}] ${p.symbol}: ${p.amount.toFixed(4)} ($${p.valueUsd.toFixed(2)})`,
    );
  });

  // 3. Max Borrow/Withdraw
  log("\n--- Limits ---");

  // Find a deposited asset to test withdraw
  const supplyPos = portfolio.positions.find((p) => p.side === "supply");
  if (supplyPos) {
    const maxWithdraw = await adapter.getMaxWithdrawableAmount(
      TEST_ADDRESS,
      supplyPos.coinType,
    );
    log(`Max Withdraw ${supplyPos.symbol}: ${maxWithdraw}`);
  } else {
    log("No supply position found to test Max Withdraw");
  }

  // Find a borrowable asset (USDC) or use SUI
  const usdcCoinType =
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
  try {
    const maxBorrow = await adapter.getMaxBorrowableAmount(
      TEST_ADDRESS,
      usdcCoinType,
    );
    log(`Max Borrow USDC: ${maxBorrow}`);
  } catch (e: any) {
    log(`Max Borrow Error: ${e.message}`);
  }
}

main().catch(console.error);
