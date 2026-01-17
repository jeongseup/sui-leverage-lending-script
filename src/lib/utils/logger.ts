/**
 * DeFi Dash SDK - Logging Utilities
 *
 * Common logging functions for test scripts
 */

import { PositionInfo, LeveragePreview, StrategyResult } from "../../types";

const DIVIDER = "─".repeat(55);

// ============================================================================
// Basic Formatters
// ============================================================================

export function formatAmount(
  amount: bigint | number,
  decimals: number,
): string {
  const num = Number(amount) / Math.pow(10, decimals);
  return num.toFixed(Math.min(decimals, 8)); // Show up to 8 decimals
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatGas(gasUsed: bigint): string {
  return `${(Number(gasUsed) / 1e9).toFixed(6)} SUI`;
}

// ============================================================================
// Section Loggers
// ============================================================================

export function logHeader(title: string): void {
  console.log(DIVIDER);
  console.log(`  ${title}`);
  console.log(DIVIDER);
}

export function logSection(title: string): void {
  console.log(`\n${title}`);
  console.log(DIVIDER);
}

export function logDivider(): void {
  console.log(DIVIDER);
}

export function logFooter(message: string = "✨ Done!"): void {
  console.log("\n" + DIVIDER);
  console.log(`  ${message}`);
  console.log(DIVIDER);
}

// ============================================================================
// Position Logging
// ============================================================================

export function logPosition(
  position: PositionInfo | null,
  protocol: string,
): void {
  console.log(`\n📊 Checking current position on ${protocol}...`);

  if (!position) {
    console.log("   ⚠️ No position found");
    return;
  }

  const { collateral, debt, netValueUsd } = position;

  console.log(`\n📋 Current Position:`);
  console.log(DIVIDER);
  console.log(
    `   Collateral: ${formatAmount(collateral.amount, collateral.decimals)} ${collateral.symbol}`,
  );
  console.log(`   Value:      ${formatUsd(collateral.valueUsd)}`);
  console.log(
    `   Debt:       ${formatAmount(debt.amount, debt.decimals)} ${debt.symbol}`,
  );
  console.log(`   Value:      ${formatUsd(debt.valueUsd)}`);
  console.log(`   Net Value:  ${formatUsd(netValueUsd)}`);
  console.log(DIVIDER);
}

// ============================================================================
// Leverage Preview Logging
// ============================================================================

export function logLeverageParams(params: {
  protocol: string;
  depositAsset: string;
  depositAmount: string;
  multiplier: number;
}): void {
  console.log("\n📈 Leverage Preview:");
  console.log(DIVIDER);
  console.log(`   Protocol:       ${params.protocol}`);
  console.log(`   Deposit Asset:  ${params.depositAsset}`);
  console.log(`   Deposit Amount: ${params.depositAmount}`);
  console.log(`   Multiplier:     ${params.multiplier}x`);
}

export function logLeveragePreview(preview: LeveragePreview): void {
  console.log(DIVIDER);
  console.log(`   Initial Equity:    ${formatUsd(preview.initialEquityUsd)}`);
  console.log(
    `   Flash Loan:        ${(Number(preview.flashLoanUsdc) / 1e6).toFixed(2)} USDC`,
  );
  console.log(`   Total Position:    ${formatUsd(preview.totalPositionUsd)}`);
  console.log(`   Total Debt:        ${formatUsd(preview.debtUsd)}`);
  console.log(`   Position LTV:      ${preview.ltvPercent.toFixed(1)}%`);
  console.log(
    `   Liquidation Price: $${preview.liquidationPrice.toLocaleString()}`,
  );
  console.log(`   Price Drop Buffer: ${preview.priceDropBuffer.toFixed(1)}%`);
  console.log(DIVIDER);
}

// ============================================================================
// Strategy Result Logging
// ============================================================================

export function logStrategyResult(
  result: StrategyResult,
  strategyName: string,
  isDryRun: boolean = true,
): void {
  const mode = isDryRun ? "DRY RUN" : "EXECUTION";
  console.log(`\n🔧 Executing ${strategyName} strategy (${mode})...`);

  if (result.success) {
    console.log(
      "   ✅ " + (isDryRun ? "Dry run successful!" : "Execution successful!"),
    );

    if (result.txDigest) {
      console.log(`   📝 TX: ${result.txDigest}`);
    }

    if (result.gasUsed) {
      console.log(`   ⛽ Gas: ${formatGas(result.gasUsed)}`);
    }

    if (isDryRun) {
      console.log("\n   💡 To execute for real, set dryRun: false");
    }
  } else {
    console.error(`   ❌ ${mode} failed: ${result.error}`);
  }
}

// ============================================================================
// Wallet Logging
// ============================================================================

export function logWallet(address: string): void {
  console.log(`\n👤 Wallet: ${address}`);
}

export function logBalances(
  balances: Array<{ symbol: string; balance: string; decimals?: number }>,
): void {
  console.log("\n💰 Wallet Balances:");
  for (const b of balances) {
    const decimals = b.decimals || 9;
    const formatted = formatAmount(BigInt(b.balance), decimals);
    console.log(`   ${b.symbol}: ${formatted}`);
  }
}

// ============================================================================
// SDK Status
// ============================================================================

export function logSDKInit(success: boolean = true): void {
  console.log("\n📦 Initializing DefiDash SDK...");
  if (success) {
    console.log("   ✅ SDK initialized");
  }
}
