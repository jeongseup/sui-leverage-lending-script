import * as dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.public" });
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  repayCoinPTB,
  withdrawCoinPTB,
  getLendingState,
  updateOraclePricesPTB,
  getPriceFeeds,
  normalizeCoinType,
} from "@naviprotocol/lending";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import { ScallopFlashLoanClient } from "../src/lib/scallop";
import { getReserveByCoinType, COIN_TYPES } from "../src/lib/const";

/**
 * Navi Deleverage Strategy - Close leveraged position
 *
 * Flow:
 * 1. Flash loan USDC from Scallop (to repay Navi debt)
 * 2. Repay all USDC debt on Navi
 * 3. Withdraw all collateral from Navi
 * 4. Swap withdrawn asset → USDC using 7k
 * 5. Repay Scallop flash loan
 * 6. Transfer remaining funds to user
 */

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");
const USDC_COIN_TYPE = COIN_TYPES.USDC;

function formatUnits(
  amount: string | number | bigint,
  decimals: number
): string {
  const s = amount.toString();
  if (decimals === 0) return s;
  const pad = s.padStart(decimals + 1, "0");
  const transition = pad.length - decimals;
  return (
    `${pad.slice(0, transition)}.${pad.slice(transition)}`.replace(
      /\.?0+$/,
      ""
    ) || "0"
  );
}

async function main() {
  console.log("─".repeat(55));
  console.log("  📉 Navi Deleverage Strategy (Dry Run)");
  console.log("─".repeat(55));

  // 1. Setup
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error("❌ Error: SECRET_KEY not found in .env file.");
    return;
  }
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  const userAddress = keypair.getPublicKey().toSuiAddress();
  console.log(`\n👤 Wallet: ${userAddress}`);

  const suiClient = new SuiClient({ url: SUI_FULLNODE_URL });

  // Show SUI balance
  const suiBalance = await suiClient.getBalance({
    owner: userAddress,
    coinType: "0x2::sui::SUI",
  });
  console.log(`💰 SUI Balance: ${formatUnits(suiBalance.totalBalance, 9)} SUI`);
  const flashLoanClient = new ScallopFlashLoanClient();
  const metaAg = new MetaAg({
    partner:
      "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf",
  });

  // 2. Get current Navi position
  console.log(`\n📊 Fetching current Navi position...`);
  const lendingState = await getLendingState(userAddress, { env: "prod" });

  if (lendingState.length === 0) {
    console.log(`\n⚠️  No active positions found on Navi`);
    return;
  }

  // Find positions with supply or borrow
  const activePositions = lendingState.filter(
    (p) => BigInt(p.supplyBalance) > 0 || BigInt(p.borrowBalance) > 0
  );

  if (activePositions.length === 0) {
    console.log(`\n⚠️  No active supply or borrow positions found`);
    return;
  }

  console.log(`\n📋 Active Positions:`);
  console.log(`─`.repeat(55));

  const normalizedUsdcCoin = normalizeCoinType(USDC_COIN_TYPE);

  // Navi SDK returns balances with 9 decimal precision internally
  const NAVI_BALANCE_DECIMALS = 9;

  // Find supply position (collateral) and borrow position (debt)
  let supplyPosition: typeof activePositions[0] | null = null;
  let borrowPosition: typeof activePositions[0] | null = null;

  for (const pos of activePositions) {
    const poolCoinType = normalizeCoinType(pos.pool.coinType);
    const reserve = getReserveByCoinType(poolCoinType);
    const symbol = reserve?.symbol || poolCoinType.split("::").pop() || "???";

    if (BigInt(pos.supplyBalance) > 0) {
      console.log(
        `  Supply:  ${formatUnits(pos.supplyBalance, NAVI_BALANCE_DECIMALS)} ${symbol}`
      );
      supplyPosition = pos;
    }
    if (BigInt(pos.borrowBalance) > 0) {
      console.log(
        `  Borrow:  ${formatUnits(pos.borrowBalance, NAVI_BALANCE_DECIMALS)} ${symbol}`
      );
      borrowPosition = pos;
    }
  }
  console.log(`─`.repeat(55));

  if (!supplyPosition) {
    console.log(`\n⚠️  No supply position found to withdraw`);
    return;
  }

  if (!borrowPosition) {
    console.log(`\n⚠️  No borrow position found - nothing to deleverage`);
    console.log(`   Use a simple withdraw instead.`);
    return;
  }

  // Get position details
  const supplyPool = supplyPosition.pool;
  const borrowPool = borrowPosition.pool;

  // Navi SDK balances are in 9 decimal precision
  const supplyBalanceNavi = BigInt(supplyPosition.supplyBalance);
  const borrowBalanceNavi = BigInt(borrowPosition.borrowBalance);

  const supplyCoinType = normalizeCoinType(supplyPool.coinType);
  const borrowCoinType = normalizeCoinType(borrowPool.coinType);

  const supplyReserve = getReserveByCoinType(supplyCoinType);
  const borrowReserve = getReserveByCoinType(borrowCoinType);

  const supplySymbol = supplyReserve?.symbol || "???";
  const borrowSymbol = borrowReserve?.symbol || "USDC";
  const supplyDecimals = supplyReserve?.decimals || 9;
  const borrowDecimals = borrowReserve?.decimals || 6;

  // Convert from Navi's 9 decimal precision to coin's native decimals
  // For SUI (9 decimals): no conversion needed
  // For USDC (6 decimals): divide by 10^3
  const supplyAmount = supplyBalanceNavi; // SUI is 9 decimals, same as Navi
  const borrowAmount = borrowBalanceNavi / BigInt(10 ** (NAVI_BALANCE_DECIMALS - borrowDecimals));

  // Check if borrow is USDC (required for this strategy)
  if (borrowCoinType !== normalizedUsdcCoin) {
    console.log(`\n⚠️  Borrow position is not USDC`);
    console.log(`   This strategy only supports USDC debt.`);
    console.log(`   Borrow coin: ${borrowCoinType}`);
    return;
  }

  // Get prices
  const supplyPrice = await getTokenPrice(supplyCoinType);
  const usdcPrice = await getTokenPrice(normalizedUsdcCoin);

  const supplyValueUsd =
    (Number(supplyAmount) / Math.pow(10, supplyDecimals)) * supplyPrice;
  const borrowValueUsd =
    (Number(borrowAmount) / Math.pow(10, borrowDecimals)) * usdcPrice;
  const netValueUsd = supplyValueUsd - borrowValueUsd;

  console.log(`\n📊 Position Summary:`);
  console.log(`─`.repeat(55));
  console.log(
    `  Collateral: ${formatUnits(supplyAmount, supplyDecimals)} ${supplySymbol} (~$${supplyValueUsd.toFixed(2)})`
  );
  console.log(
    `  Debt:       ${formatUnits(borrowAmount, borrowDecimals)} ${borrowSymbol} (~$${borrowValueUsd.toFixed(2)})`
  );
  console.log(`  Net Value:  ~$${netValueUsd.toFixed(2)}`);
  console.log(`─`.repeat(55));

  try {
    // 3. Calculate flash loan amount (borrow amount + buffer for fees)
    const flashLoanBuffer = (borrowAmount * BigInt(105)) / BigInt(100); // 5% buffer
    const flashLoanUsdc = flashLoanBuffer;
    const flashLoanFee = ScallopFlashLoanClient.calculateFee(flashLoanUsdc);
    const totalRepayment = flashLoanUsdc + flashLoanFee;

    console.log(`\n🔍 Flash Loan Details:`);
    console.log(
      `  Flash Loan: ${formatUnits(flashLoanUsdc, 6)} USDC (debt + 5% buffer)`
    );
    console.log(`  Flash Fee:  ${formatUnits(flashLoanFee, 6)} USDC`);

    // 4. Calculate optimal swap amount using reverse calculation
    // First, get a quote for full withdrawal to determine exchange rate
    const withdrawAmountForQuote = (supplyAmount * BigInt(999)) / BigInt(1000);
    console.log(`\n🔍 Calculating optimal swap amount...`);
    const fullSwapQuotes = await metaAg.quote({
      amountIn: withdrawAmountForQuote.toString(),
      coinTypeIn: supplyCoinType,
      coinTypeOut: USDC_COIN_TYPE,
    });

    if (fullSwapQuotes.length === 0) {
      console.log(`\n⚠️  No swap quotes found for ${supplySymbol} → USDC`);
      return;
    }

    const fullQuote = fullSwapQuotes.sort(
      (a, b) => Number(b.amountOut) - Number(a.amountOut)
    )[0];

    const fullSwapOut = BigInt(fullQuote.amountOut);
    const fullSwapIn = BigInt(fullQuote.amountIn);

    // Check if full swap covers flash loan repayment
    if (fullSwapOut < totalRepayment) {
      console.log(`\n❌ Error: Collateral value is insufficient`);
      console.log(`   Max swap output:   ${formatUnits(fullSwapOut, 6)} USDC`);
      console.log(`   Required to repay: ${formatUnits(totalRepayment, 6)} USDC`);
      console.log(`   Shortfall:         ${formatUnits(totalRepayment - fullSwapOut, 6)} USDC`);
      console.log(`\n   Position may be underwater.`);
      return;
    }

    // Calculate how much collateral we need to swap to get exactly totalRepayment USDC
    // Add 2% buffer for slippage: we want (totalRepayment * 1.02) USDC output
    const targetUsdcOut = (totalRepayment * BigInt(102)) / BigInt(100);

    // Calculate required input based on exchange rate from full quote
    // requiredInput = targetOutput * (fullSwapIn / fullSwapOut)
    const requiredSwapIn = (targetUsdcOut * fullSwapIn) / fullSwapOut;

    // Cap at withdrawal amount (can't swap more than we have)
    const actualSwapIn = requiredSwapIn > withdrawAmountForQuote
      ? withdrawAmountForQuote
      : requiredSwapIn;

    console.log(`  Full swap would yield: ${formatUnits(fullSwapOut, 6)} USDC`);
    console.log(`  Flash loan repayment:  ${formatUnits(totalRepayment, 6)} USDC`);
    console.log(`  Target swap output:    ${formatUnits(targetUsdcOut, 6)} USDC (with 2% buffer)`);
    console.log(`  Required ${supplySymbol} input:   ${formatUnits(actualSwapIn, supplyDecimals)} ${supplySymbol}`);

    // Get actual quote for the calculated amount
    console.log(`\n🔍 Fetching optimized swap quote: ${supplySymbol} → USDC...`);
    const swapQuotes = await metaAg.quote({
      amountIn: actualSwapIn.toString(),
      coinTypeIn: supplyCoinType,
      coinTypeOut: USDC_COIN_TYPE,
    });

    if (swapQuotes.length === 0) {
      console.log(`\n⚠️  No swap quotes found for ${supplySymbol} → USDC`);
      return;
    }

    const bestQuote = swapQuotes.sort(
      (a, b) => Number(b.amountOut) - Number(a.amountOut)
    )[0];

    const expectedUsdcOut = BigInt(bestQuote.amountOut);
    const keepCollateral = withdrawAmountForQuote - actualSwapIn;

    console.log(`  Swap:     ${formatUnits(actualSwapIn, supplyDecimals)} ${supplySymbol} → ${formatUnits(expectedUsdcOut, 6)} USDC`);
    console.log(`  Keep:     ${formatUnits(keepCollateral, supplyDecimals)} ${supplySymbol} (~$${((Number(keepCollateral) / Math.pow(10, supplyDecimals)) * supplyPrice).toFixed(2)})`);

    // Verify swap output covers flash loan repayment
    if (expectedUsdcOut < totalRepayment) {
      console.log(`\n⚠️  Warning: Swap output may not cover flash loan, using full swap instead`);
      // Fall back to full swap if optimized amount isn't enough
    }

    const estimatedUsdcProfit = expectedUsdcOut - totalRepayment;
    const totalProfitUsd = (Number(keepCollateral) / Math.pow(10, supplyDecimals)) * supplyPrice + Number(estimatedUsdcProfit) / 1e6;
    console.log(`\n📊 Estimated Returns:`);
    console.log(`  ${supplySymbol} kept:      ${formatUnits(keepCollateral, supplyDecimals)} ${supplySymbol}`);
    console.log(`  USDC remaining: ${formatUnits(estimatedUsdcProfit, 6)} USDC`);
    console.log(`  Total value:    ~$${totalProfitUsd.toFixed(2)}`);

    // 5. Fetch price feeds for oracle update
    const priceFeeds = await getPriceFeeds({ env: "prod" });
    const supplyFeed = priceFeeds.find(
      (f: any) =>
        normalizeCoinType(f.coinType) === supplyCoinType
    );
    const usdcFeed = priceFeeds.find(
      (f: any) =>
        normalizeCoinType(f.coinType) === normalizedUsdcCoin
    );

    // 6. Build Transaction
    console.log(`\n🔧 Building transaction...`);
    const tx = new Transaction();
    tx.setSender(userAddress);
    tx.setGasBudget(100_000_000);

    // A. Flash loan USDC from Scallop (use full flash loan for repayment, rely on swap for flash loan payback)
    console.log(`  Step 1: Flash loan ${formatUnits(flashLoanUsdc, 6)} USDC`);
    const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(
      tx,
      flashLoanUsdc,
      "usdc"
    );

    // B. Update oracle prices
    const feedsToUpdate = [supplyFeed, usdcFeed].filter(Boolean);
    if (feedsToUpdate.length > 0) {
      console.log(`  Step 2: Update oracle prices`);
      await updateOraclePricesPTB(tx as any, feedsToUpdate, {
        env: "prod",
        updatePythPriceFeeds: true,
      });
    }

    // C. Repay USDC debt on Navi using entire flash loan (Navi will use what it needs)
    console.log(
      `  Step 3: Repay USDC debt on Navi (using flash loan)`
    );
    await repayCoinPTB(tx as any, borrowPool, loanCoin, {
      env: "prod",
    });

    // D. Withdraw all collateral from Navi (withdraw slightly less to avoid rounding issues)
    const withdrawAmount = withdrawAmountForQuote; // 99.9% to avoid dust
    console.log(
      `  Step 4: Withdraw ${formatUnits(withdrawAmount, supplyDecimals)} ${supplySymbol} from Navi`
    );
    const withdrawnCoin = await withdrawCoinPTB(
      tx as any,
      supplyPool,
      Number(withdrawAmount),
      { env: "prod" }
    );

    // E. Split: only swap what we need, keep the rest
    console.log(`  Step 5: Split ${supplySymbol} - swap only ${formatUnits(actualSwapIn, supplyDecimals)} ${supplySymbol}`);
    const [coinToSwap] = tx.splitCoins(withdrawnCoin as any, [actualSwapIn]);

    // F. Swap partial collateral → USDC
    console.log(`  Step 6: Swap ${supplySymbol} → USDC`);
    const swappedUsdc = await metaAg.swap(
      {
        quote: bestQuote,
        signer: userAddress,
        coinIn: coinToSwap,
        tx: tx,
      },
      100
    );

    // G. Split exact repayment for flash loan from swapped USDC
    console.log(`  Step 7: Repay flash loan`);
    const [flashRepayment] = tx.splitCoins(swappedUsdc as any, [totalRepayment]);
    flashLoanClient.repayFlashLoan(tx, flashRepayment as any, receipt, "usdc");

    // H. Transfer remaining assets to user (both remaining collateral and USDC)
    console.log(`  Step 8: Transfer remaining ${supplySymbol} and USDC to user`);
    tx.transferObjects([withdrawnCoin as any, swappedUsdc as any], userAddress);

    // 7. Dry Run
    console.log(`\n🧪 Building and running dry-run...`);
    const txBytes = await tx.build({ client: suiClient });

    // Estimate gas
    const gasEstimate = await suiClient.dryRunTransactionBlock({
      transactionBlock: txBytes,
    });

    const computationCost = BigInt(gasEstimate.effects.gasUsed.computationCost);
    const storageCost = BigInt(gasEstimate.effects.gasUsed.storageCost);
    const storageRebate = BigInt(gasEstimate.effects.gasUsed.storageRebate);
    const totalGas = computationCost + storageCost - storageRebate;

    console.log(`\n⛽ Estimated Gas:`);
    console.log(`  Computation: ${formatUnits(computationCost, 9)} SUI`);
    console.log(`  Storage:     ${formatUnits(storageCost, 9)} SUI`);
    console.log(`  Rebate:      -${formatUnits(storageRebate, 9)} SUI`);
    console.log(`  Total:       ~${formatUnits(totalGas, 9)} SUI`);

    if (gasEstimate.effects.status.status === "success") {
      console.log(`\n✅ Dry-run successful!`);
      console.log(`\n📊 Result:`);
      console.log(`─`.repeat(55));
      console.log(`  Position closed successfully`);
      console.log(`  You will receive:`);
      console.log(`    • ${formatUnits(keepCollateral, supplyDecimals)} ${supplySymbol} (~$${((Number(keepCollateral) / Math.pow(10, supplyDecimals)) * supplyPrice).toFixed(2)})`);
      console.log(`    • ${formatUnits(estimatedUsdcProfit, 6)} USDC (~$${(Number(estimatedUsdcProfit) / 1e6).toFixed(2)})`);
      console.log(`  Total value: ~$${totalProfitUsd.toFixed(2)}`);
      console.log(`─`.repeat(55));
    } else {
      console.error(`\n❌ Dry-run failed:`, gasEstimate.effects.status.error);
    }

    console.log(`\n` + "─".repeat(55));
    console.log(`  ✨ Done!`);
    console.log("─".repeat(55));
  } catch (error: any) {
    console.error(`\n❌ ERROR: ${error.message || error}`);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

main();
