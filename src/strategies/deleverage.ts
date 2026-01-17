/**
 * DeFi Dash SDK - Deleverage Strategy Builder
 *
 * Builds deleverage transactions to close leveraged positions
 */

import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import { ILendingProtocol } from "../protocols/interface";
import { ScallopFlashLoanClient } from "../lib/scallop";
import { normalizeCoinType, formatUnits } from "../lib/utils";
import { getReserveByCoinType } from "../lib/suilend/const";
import { USDC_COIN_TYPE, PositionInfo } from "../types";

export interface DeleverageBuildParams {
  protocol: ILendingProtocol;
  flashLoanClient: ScallopFlashLoanClient;
  swapClient: MetaAg;
  suiClient: SuiClient;
  userAddress: string;
  position: PositionInfo;
}

export interface DeleverageEstimate {
  flashLoanUsdc: bigint;
  flashLoanFee: bigint;
  totalRepayment: bigint;
  swapAmount: bigint;
  keepCollateral: bigint;
  estimatedUsdcProfit: bigint;
  totalProfitUsd: number;
}

/**
 * Calculate deleverage estimates
 */
export async function calculateDeleverageEstimate(
  params: DeleverageBuildParams,
): Promise<DeleverageEstimate> {
  const { swapClient, position } = params;

  const borrowAmount = position.debt.amount;
  const supplyAmount = position.collateral.amount;
  const supplyCoinType = position.collateral.coinType;
  const supplyDecimals = position.collateral.decimals;

  // Flash loan with 0.5% buffer
  const flashLoanUsdc = (borrowAmount * 1005n) / 1000n;
  const flashLoanFee = ScallopFlashLoanClient.calculateFee(flashLoanUsdc);
  const totalRepayment = flashLoanUsdc + flashLoanFee;

  // Get swap rate - use full collateral amount
  const withdrawAmount = supplyAmount; // Withdraw ALL collateral
  const fullSwapQuotes = await swapClient.quote({
    amountIn: withdrawAmount.toString(),
    coinTypeIn: supplyCoinType,
    coinTypeOut: USDC_COIN_TYPE,
  });

  if (fullSwapQuotes.length === 0) {
    throw new Error(
      `No swap quotes found for ${position.collateral.symbol} → USDC`,
    );
  }

  const fullQuote = fullSwapQuotes.sort(
    (a, b) => Number(b.amountOut) - Number(a.amountOut),
  )[0];

  const fullSwapOut = BigInt(fullQuote.amountOut);
  const fullSwapIn = BigInt(fullQuote.amountIn);

  // Calculate optimal swap amount (with 2% buffer)
  const targetUsdcOut = (totalRepayment * 102n) / 100n;
  const requiredSwapIn = (targetUsdcOut * fullSwapIn) / fullSwapOut;
  const actualSwapIn =
    requiredSwapIn > withdrawAmount ? withdrawAmount : requiredSwapIn;

  const keepCollateral = withdrawAmount - actualSwapIn;
  const estimatedUsdcProfit =
    fullSwapOut > totalRepayment
      ? (actualSwapIn * fullSwapOut) / fullSwapIn - totalRepayment
      : 0n;

  const supplyPrice = await getTokenPrice(supplyCoinType);
  const totalProfitUsd =
    (Number(keepCollateral) / Math.pow(10, supplyDecimals)) * supplyPrice +
    Number(estimatedUsdcProfit) / 1e6;

  return {
    flashLoanUsdc,
    flashLoanFee,
    totalRepayment,
    swapAmount: actualSwapIn,
    keepCollateral,
    estimatedUsdcProfit,
    totalProfitUsd,
  };
}

/**
 * Build deleverage transaction
 *
 * Flow:
 * 1. Flash loan USDC (to repay debt)
 * 2. Refresh oracles
 * 3. Repay debt using flash loan
 * 4. Withdraw all collateral
 * 5. Swap partial collateral → USDC
 * 6. Repay flash loan
 * 7. Transfer remaining to user
 */
export async function buildDeleverageTransaction(
  tx: Transaction,
  params: DeleverageBuildParams,
): Promise<void> {
  const {
    protocol,
    flashLoanClient,
    swapClient,
    suiClient,
    userAddress,
    position,
  } = params;

  const supplyCoinType = position.collateral.coinType;
  const supplyDecimals = position.collateral.decimals;
  const supplyAmount = position.collateral.amount;

  // Calculate estimates
  const estimate = await calculateDeleverageEstimate(params);

  // 1. Flash loan USDC
  const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(
    tx,
    estimate.flashLoanUsdc,
    "usdc",
  );

  // 2. Refresh oracles
  await protocol.refreshOracles(
    tx,
    [supplyCoinType, USDC_COIN_TYPE],
    userAddress,
  );

  // 3. Repay debt using flash loan
  await protocol.repay(tx, USDC_COIN_TYPE, loanCoin, userAddress);

  // 4. Withdraw ALL collateral
  const withdrawAmount = supplyAmount;
  const withdrawnCoin = await protocol.withdraw(
    tx,
    supplyCoinType,
    withdrawAmount.toString(),
    userAddress,
  );

  // 5. Get swap quote and swap
  const swapQuotes = await swapClient.quote({
    amountIn: estimate.swapAmount.toString(),
    coinTypeIn: supplyCoinType,
    coinTypeOut: USDC_COIN_TYPE,
  });

  if (swapQuotes.length === 0) {
    throw new Error(`No swap quotes for ${position.collateral.symbol} → USDC`);
  }

  const bestQuote = swapQuotes.sort(
    (a, b) => Number(b.amountOut) - Number(a.amountOut),
  )[0];

  // Split coin for swap
  const [coinToSwap] = tx.splitCoins(withdrawnCoin, [estimate.swapAmount]);

  const swappedUsdc = await swapClient.swap(
    {
      quote: bestQuote,
      signer: userAddress,
      coinIn: coinToSwap,
      tx: tx,
    },
    100,
  );

  // 6. Repay flash loan
  const [flashRepayment] = tx.splitCoins(swappedUsdc as any, [
    estimate.totalRepayment,
  ]);
  flashLoanClient.repayFlashLoan(tx, flashRepayment as any, receipt, "usdc");

  // 7. Transfer remaining to user
  // Note: loanCoin must be transferred after repay() per Suilend SDK pattern
  tx.transferObjects(
    [withdrawnCoin as any, swappedUsdc as any, loanCoin as any],
    userAddress,
  );
}
