import * as dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.public" });
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  SuilendClient,
  LENDING_MARKET_ID,
  LENDING_MARKET_TYPE,
} from "@suilend/sdk";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import { ScallopFlashLoanClient } from "../../src/lib/scallop";
import { getReserveByCoinType, COIN_TYPES } from "../../src/lib/suilend/const";

/**
 * Suilend Deleverage Strategy - Close leveraged position (Dry Run)
 *
 * Flow:
 * 1. Flash loan USDC from Scallop (to repay Suilend debt)
 * 2. Repay all USDC debt on Suilend
 * 3. Withdraw all collateral from Suilend
 * 4. Swap withdrawn asset → USDC using 7k
 * 5. Repay Scallop flash loan
 * 6. Transfer remaining funds to user
 */

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");
const USDC_COIN_TYPE = COIN_TYPES.USDC;

// Suilend uses WAD (10^18) for internal precision
const WAD = 10n ** 18n;

function normalizeCoinType(coinType: string): string {
  const parts = coinType.split("::");
  if (parts.length !== 3) return coinType;
  let pkg = parts[0].replace("0x", "");
  pkg = pkg.padStart(64, "0");
  return `0x${pkg}::${parts[1]}::${parts[2]}`;
}

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
  console.log("  📉 Suilend Deleverage Strategy (Dry Run)");
  console.log("  ℹ️  This will simulate the transaction without executing");
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
  const suilendClient = await SuilendClient.initialize(
    LENDING_MARKET_ID,
    LENDING_MARKET_TYPE,
    suiClient
  );
  const metaAg = new MetaAg({
    partner:
      "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf",
  });

  // 2. Get current Suilend position
  console.log(`\n📊 Fetching current Suilend position...`);

  const obligationOwnerCaps = await SuilendClient.getObligationOwnerCaps(
    userAddress,
    [LENDING_MARKET_TYPE],
    suiClient
  );

  if (obligationOwnerCaps.length === 0) {
    console.log(`\n⚠️  No obligations found on Suilend`);
    return;
  }

  const existingCap = obligationOwnerCaps[0];
  const obligationId = existingCap.obligationId;

  const obligation = await SuilendClient.getObligation(
    obligationId,
    [LENDING_MARKET_TYPE],
    suiClient
  );

  if (!obligation) {
    console.log(`\n⚠️  Could not fetch obligation details`);
    return;
  }

  // Parse deposits and borrows from obligation
  const deposits = obligation.deposits || [];
  const borrows = obligation.borrows || [];

  if (deposits.length === 0 && borrows.length === 0) {
    console.log(`\n⚠️  No active positions found on Suilend`);
    return;
  }

  console.log(`\n📋 Active Positions:`);
  console.log(`─`.repeat(55));

  const normalizedUsdcCoin = normalizeCoinType(USDC_COIN_TYPE);

  // Find supply position (collateral) and borrow position (debt)
  let supplyDeposit: any = null;
  let borrowPosition: any = null;
  let supplyCoinType: string = "";
  let borrowCoinType: string = "";

  for (const deposit of deposits as any[]) {
    // Suilend SDK uses coinType.name for the coin type string
    const coinType = normalizeCoinType(deposit.coinType.name);
    const reserveInfo = getReserveByCoinType(coinType);
    const symbol = reserveInfo?.symbol || coinType.split("::").pop() || "???";
    const decimals = reserveInfo?.decimals || 9;
    // depositedCtokenAmount is already a number/bigint (not Decimal)
    const amount = BigInt(deposit.depositedCtokenAmount);

    console.log(`  Supply:  ${formatUnits(amount, decimals)} ${symbol}`);
    supplyDeposit = deposit;
    supplyCoinType = coinType;
  }

  for (const borrow of borrows as any[]) {
    // Suilend SDK uses coinType.name for the coin type string
    const coinType = normalizeCoinType(borrow.coinType.name);
    const reserveInfo = getReserveByCoinType(coinType);
    const symbol = reserveInfo?.symbol || coinType.split("::").pop() || "???";
    const decimals = reserveInfo?.decimals || 6;
    // borrowedAmount is a Decimal-like object with .value property, need WAD division
    const rawAmount = BigInt(borrow.borrowedAmount.value);
    const amount = rawAmount / WAD;

    console.log(`  Borrow:  ${formatUnits(amount, decimals)} ${symbol}`);
    borrowPosition = borrow;
    borrowCoinType = coinType;
  }
  console.log(`─`.repeat(55));

  if (!supplyDeposit || !supplyCoinType) {
    console.log(`\n⚠️  No supply position found to withdraw`);
    return;
  }

  if (!borrowPosition || !borrowCoinType) {
    console.log(`\n⚠️  No borrow position found - nothing to deleverage`);
    console.log(`   Use a simple withdraw instead.`);
    return;
  }

  const supplyReserveInfo = getReserveByCoinType(supplyCoinType);
  const borrowReserveInfo = getReserveByCoinType(borrowCoinType);

  const supplySymbol = supplyReserveInfo?.symbol || "???";
  const borrowSymbol = borrowReserveInfo?.symbol || "USDC";
  const supplyDecimals = supplyReserveInfo?.decimals || 9;
  const borrowDecimals = borrowReserveInfo?.decimals || 6;

  const supplyAmount = BigInt(supplyDeposit.depositedCtokenAmount);
  const borrowAmount = BigInt(borrowPosition.borrowedAmount.value) / WAD;

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
    `  Collateral: ${formatUnits(
      supplyAmount,
      supplyDecimals
    )} ${supplySymbol} (~$${supplyValueUsd.toFixed(2)})`
  );
  console.log(
    `  Debt:       ${formatUnits(
      borrowAmount,
      borrowDecimals
    )} ${borrowSymbol} (~$${borrowValueUsd.toFixed(2)})`
  );
  console.log(`  Net Value:  ~$${netValueUsd.toFixed(2)}`);
  console.log(`─`.repeat(55));

  try {
    // 3. Calculate flash loan amount (borrow amount + buffer for fees)
    const flashLoanBuffer = (borrowAmount * BigInt(1005)) / BigInt(1000); // 0.5% buffer
    const flashLoanUsdc = flashLoanBuffer;
    const flashLoanFee = ScallopFlashLoanClient.calculateFee(flashLoanUsdc);
    const totalRepayment = flashLoanUsdc + flashLoanFee;

    console.log(`\n🔍 Flash Loan Details:`);
    console.log(
      `  Flash Loan: ${formatUnits(flashLoanUsdc, 6)} USDC (debt + 0.5% buffer)`
    );
    console.log(`  Flash Fee:  ${formatUnits(flashLoanFee, 6)} USDC`);

    // 4. Calculate optimal swap amount using reverse calculation
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
      console.log(
        `   Required to repay: ${formatUnits(totalRepayment, 6)} USDC`
      );
      console.log(
        `   Shortfall:         ${formatUnits(
          totalRepayment - fullSwapOut,
          6
        )} USDC`
      );
      console.log(`\n   Position may be underwater.`);
      return;
    }

    // Calculate how much collateral we need to swap to get exactly totalRepayment USDC
    const targetUsdcOut = (totalRepayment * BigInt(102)) / BigInt(100); // 2% buffer

    // Calculate required input based on exchange rate from full quote
    const requiredSwapIn = (targetUsdcOut * fullSwapIn) / fullSwapOut;

    // Cap at withdrawal amount
    const actualSwapIn =
      requiredSwapIn > withdrawAmountForQuote
        ? withdrawAmountForQuote
        : requiredSwapIn;

    console.log(`  Full swap would yield: ${formatUnits(fullSwapOut, 6)} USDC`);
    console.log(
      `  Flash loan repayment:  ${formatUnits(totalRepayment, 6)} USDC`
    );
    console.log(
      `  Target swap output:    ${formatUnits(
        targetUsdcOut,
        6
      )} USDC (with 2% buffer)`
    );
    console.log(
      `  Required ${supplySymbol} input:   ${formatUnits(
        actualSwapIn,
        supplyDecimals
      )} ${supplySymbol}`
    );

    // Get actual quote for the calculated amount
    console.log(
      `\n🔍 Fetching optimized swap quote: ${supplySymbol} → USDC...`
    );
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

    console.log(
      `  Swap:     ${formatUnits(
        actualSwapIn,
        supplyDecimals
      )} ${supplySymbol} → ${formatUnits(expectedUsdcOut, 6)} USDC`
    );
    console.log(
      `  Keep:     ${formatUnits(
        keepCollateral,
        supplyDecimals
      )} ${supplySymbol} (~$${(
        (Number(keepCollateral) / Math.pow(10, supplyDecimals)) *
        supplyPrice
      ).toFixed(2)})`
    );

    // Verify swap output covers flash loan repayment
    if (expectedUsdcOut < totalRepayment) {
      console.log(
        `\n⚠️  Warning: Swap output may not cover flash loan, using full swap instead`
      );
    }

    const estimatedUsdcProfit = expectedUsdcOut - totalRepayment;
    const totalProfitUsd =
      (Number(keepCollateral) / Math.pow(10, supplyDecimals)) * supplyPrice +
      Number(estimatedUsdcProfit) / 1e6;
    console.log(`\n📊 Estimated Returns:`);
    console.log(
      `  ${supplySymbol} kept:      ${formatUnits(
        keepCollateral,
        supplyDecimals
      )} ${supplySymbol}`
    );
    console.log(
      `  USDC remaining: ${formatUnits(estimatedUsdcProfit, 6)} USDC`
    );
    console.log(`  Total value:    ~$${totalProfitUsd.toFixed(2)}`);

    // 5. Build Transaction
    console.log(`\n🔧 Building transaction...`);
    const tx = new Transaction();
    tx.setSender(userAddress);
    tx.setGasBudget(100_000_000);

    // A. Flash loan USDC from Scallop
    console.log(`  Step 1: Flash loan ${formatUnits(flashLoanUsdc, 6)} USDC`);
    const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(
      tx,
      flashLoanUsdc,
      "usdc"
    );

    // B. Refresh oracles before repay
    console.log(`  Step 2: Refresh oracles`);
    await suilendClient.refreshAll(tx, obligation, [
      supplyCoinType,
      USDC_COIN_TYPE,
    ]);

    // C. Repay USDC debt on Suilend (using obligationId, not cap.id)
    // Following SDK pattern: repay() + transferObjects([sendCoin])
    console.log(`  Step 3: Repay USDC debt on Suilend (using flash loan)`);
    suilendClient.repay(obligationId, USDC_COIN_TYPE, loanCoin, tx);

    // D. Withdraw all collateral from Suilend
    const withdrawAmount = withdrawAmountForQuote;
    console.log(
      `  Step 4: Withdraw ${formatUnits(
        withdrawAmount,
        supplyDecimals
      )} ${supplySymbol} from Suilend`
    );
    const withdrawnCoinResult = await suilendClient.withdraw(
      existingCap.id,
      obligationId,
      supplyCoinType,
      withdrawAmount.toString(),
      tx,
      false // Already refreshed above
    );

    // E. Split: only swap what we need, keep the rest
    console.log(
      `  Step 5: Split ${supplySymbol} - swap only ${formatUnits(
        actualSwapIn,
        supplyDecimals
      )} ${supplySymbol}`
    );
    const [coinToSwap] = tx.splitCoins(withdrawnCoinResult[0] as any, [
      actualSwapIn,
    ]);

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
    const [flashRepayment] = tx.splitCoins(swappedUsdc as any, [
      totalRepayment,
    ]);
    flashLoanClient.repayFlashLoan(tx, flashRepayment as any, receipt, "usdc");

    // H. Transfer remaining assets to user
    // Following SDK repay pattern: loanCoin must be transferred after repay()
    console.log(`  Step 8: Transfer remaining assets to user`);
    tx.transferObjects(
      [withdrawnCoinResult[0] as any, swappedUsdc as any, loanCoin as any],
      userAddress
    );

    // 6. Dry Run Transaction
    console.log(`\n🧪 Executing dry run...`);
    const dryRunResult = await suiClient.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client: suiClient }),
    });

    if (dryRunResult.effects?.status.status === "success") {
      console.log(`\n✅ Dry run successful!`);
      console.log(`\n📊 Expected Result:`);
      console.log(`─`.repeat(55));
      console.log(`  Position would be closed successfully`);
      console.log(`  You would receive:`);
      console.log(
        `    • ${formatUnits(
          keepCollateral,
          supplyDecimals
        )} ${supplySymbol} (~$${(
          (Number(keepCollateral) / Math.pow(10, supplyDecimals)) *
          supplyPrice
        ).toFixed(2)})`
      );
      console.log(
        `    • ${formatUnits(estimatedUsdcProfit, 6)} USDC (~$${(
          Number(estimatedUsdcProfit) / 1e6
        ).toFixed(2)})`
      );
      console.log(`  Total value: ~$${totalProfitUsd.toFixed(2)}`);
      console.log(`─`.repeat(55));

      console.log(
        `\nEstimated gas: ${dryRunResult.effects.gasUsed.computationCost}`
      );
    } else {
      console.error(`\n❌ Dry run failed:`, dryRunResult.effects?.status.error);
    }

    console.log(`\n` + "─".repeat(55));
    console.log(`  ✨ Dry run complete!`);
    console.log(`  Run the exec version to execute for real.`);
    console.log("─".repeat(55));
  } catch (error: any) {
    console.error(`\n❌ ERROR: ${error.message || error}`);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

main();
