import "dotenv/config";
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  SuilendClient,
  LENDING_MARKET_ID,
  LENDING_MARKET_TYPE,
} from "@suilend/sdk";
import { MetaAg } from "@7kprotocol/sdk-ts";
import { Scallop, ScallopTxBlock } from "@scallop-io/sui-scallop-sdk";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");
const SUI_COIN_TYPE = "0x2::sui::SUI";
const USDC_COIN_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

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
  console.log("--- Leverage Strategy: long SUI with USDC Flashloan ---");

  // 1. Setup
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error("Error: SECRET_KEY not found in .env file.");
    return;
  }
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  const userAddress = keypair.getPublicKey().toSuiAddress();
  console.log(`Using Wallet Address: ${userAddress}`);

  const suiClient = new SuiClient({ url: SUI_FULLNODE_URL });
  const scallopSDK = new Scallop({ secretKey, networkType: "mainnet" });
  await scallopSDK.init();
  const builder = await scallopSDK.createScallopBuilder();

  const suilendClient = await SuilendClient.initialize(
    LENDING_MARKET_ID,
    LENDING_MARKET_TYPE,
    suiClient
  );
  const metaAg = new MetaAg({
    partner:
      "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf",
  });

  // 2. Parameters
  const initialEquitySui = BigInt(process.env.DEPOSIT_AMOUNT || "500000000"); // 0.5 SUI
  const multiplier = parseFloat(process.env.MULTIPLIER || "1.5");
  const leverageSuiAmount = BigInt(
    Math.floor(Number(initialEquitySui) * (multiplier - 1))
  );

  console.log(`\nParameters:`);
  console.log(`- Initial Equity: ${formatUnits(initialEquitySui, 9)} SUI`);
  console.log(`- Multiplier: ${multiplier}x`);
  console.log(
    `- Target Leverage Amount: ${formatUnits(leverageSuiAmount, 9)} SUI`
  );

  try {
    // 3. Estimate Flashloan Amount (SUI -> USDC)
    console.log("\nEstimating required USDC flashloan...");
    const quotesForLoan = await metaAg.quote({
      amountIn: leverageSuiAmount.toString(),
      coinTypeIn: SUI_COIN_TYPE,
      coinTypeOut: USDC_COIN_TYPE,
    });

    if (quotesForLoan.length === 0)
      throw new Error("No quotes found for SUI -> USDC");
    const quoteForLoan = quotesForLoan.sort(
      (a, b) => Number(b.amountOut) - Number(a.amountOut)
    )[0];

    // We need SLIGHTLY MORE than the quote to ensure we can swap back to the target SUI
    // Adding a 2% buffer for slippage and fees
    const flashloanAmount = BigInt(
      Math.floor(Number(quoteForLoan.amountOut) * 1.02)
    );
    console.log(
      `Estimated USDC needed: ${formatUnits(flashloanAmount, 6)} USDC`
    );

    // 4. Start Transaction
    const tx = builder.createTxBlock();
    tx.setSender(userAddress);
    console.log("Transaction Object Keys:", Object.keys(tx));

    // A. Flash loan USDC from Scallop
    console.log(
      `\nStep 1: Scallop Flashloan ${formatUnits(flashloanAmount, 6)} USDC...`
    );
    const [loanCoin, receipt] = await tx.borrowFlashLoan(
      Number(flashloanAmount),
      "usdc"
    );

    // B. Swap USDC to SUI via 7k-SDK
    console.log("Step 2: 7k-SDK Swap USDC -> SUI...");
    const swapQuotes = await metaAg.quote(
      {
        amountIn: flashloanAmount.toString(),
        coinTypeIn: USDC_COIN_TYPE,
        coinTypeOut: SUI_COIN_TYPE,
      },
      { sender: userAddress }
    );

    const bestSwapQuote = swapQuotes.sort(
      (a, b) =>
        Number(b.simulatedAmountOut || b.amountOut) -
        Number(a.simulatedAmountOut || a.amountOut)
    )[0];

    const swappedSui = await metaAg.swap(
      {
        quote: bestSwapQuote,
        signer: userAddress,
        coinIn: loanCoin,
        tx: tx.txBlock, // Use the underlying Transaction from Scallop
      },
      100
    ); // 1% slippage

    // C. Suilend Operations
    console.log("Step 3: Suilend Deposit & Borrow...");

    // Find existing Obligation
    const obligationOwnerCaps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      suiClient
    );
    const obligationOwnerCap = obligationOwnerCaps[0];

    if (!obligationOwnerCap) {
      throw new Error(
        "No Suilend obligation found. Please create one using 'npm run test:suilend-deposit' first."
      );
    }

    const obligationOwnerCapId = obligationOwnerCap.id;
    const obligationId = obligationOwnerCap.obligationId;
    console.log(`- Using Obligation ID: ${obligationId}`);

    // Get user's existing equity SUI from gas coin using the underlying txBlock
    const suiTxBlock = tx.txBlock;
    const userSui = suiTxBlock.splitCoins(suiTxBlock.gas, [initialEquitySui]);

    // Merge with swapped SUI (both are now from the same txBlock context)
    suiTxBlock.mergeCoins(userSui, [swappedSui]);

    // Calculate total deposit amount
    const totalDepositAmount = initialEquitySui + leverageSuiAmount;
    console.log(
      `- Total SUI to deposit: ~${formatUnits(totalDepositAmount, 9)} SUI`
    );

    // First, deposit liquidity and get cTokens
    // Note: depositIntoObligation expects a string amount and handles coin selection internally.
    // Since we have a coin object from PTB, we need to use a different approach.
    // We'll use depositLiquidityAndGetCTokens with the amount, then manually handle the deposit.
    // However, for now, let's try passing the total amount as string and let SDK handle it.
    // But the SDK selects coins from wallet, not from PTB.
    // Alternative: Skip the SUI from gas and just use the swapped USDC->SUI amount for deposit.

    // For simplicity in this iteration, let's deposit just the swapped SUI (not split from gas)
    // and provide the initialEquitySui as separate collateral in a different manner.
    // Let's simplify: deposit the merged coin using low-level moveCall

    // Get the reserve for SUI to find the correct cToken type
    const suiReserve = suilendClient.lendingMarket.reserves.find((r) =>
      r.coinType.name.includes("sui::SUI")
    );
    if (!suiReserve) throw new Error("SUI reserve not found in Suilend");

    // Use depositLiquidityAndGetCTokens with the coin object
    const cTokens = await suilendClient.depositLiquidityAndGetCTokens(
      userAddress,
      SUI_COIN_TYPE,
      userSui, // Pass the coin object from PTB
      suiTxBlock
    );

    // Deposit cTokens into obligation
    await suilendClient.depositCTokenIntoObligation(
      SUI_COIN_TYPE,
      cTokens,
      suiTxBlock,
      obligationOwnerCapId
    );

    // Refresh State (REQUIRED)
    const obligation = await SuilendClient.getObligation(
      obligationId,
      [LENDING_MARKET_TYPE],
      suiClient
    );
    await suilendClient.refreshAll(tx.txBlock, obligation);

    // Borrow USDC to repay flashloan
    const borrowedUsdc = await suilendClient.borrow(
      obligationOwnerCapId,
      obligationId,
      USDC_COIN_TYPE,
      flashloanAmount.toString(),
      tx.txBlock
    );

    // D. Repay Flashloan
    console.log("Step 4: Repay Scallop Flashloan...");
    await tx.repayFlashLoan(borrowedUsdc, receipt, "usdc");

    // 5. Dry Run using Scallop's inspectTxn
    console.log("\nExecuting dry-run...");
    const res = await builder.suiKit.inspectTxn(tx);

    if (res.effects.status.status === "failure") {
      console.error("❌ Dry-run failed:", res.effects.status.error);
    } else {
      console.log("✅ Dry-run successful!");
      console.log("\nNote: Real execution script is ready. Use with caution.");
    }
  } catch (error: any) {
    console.error("\nERROR:", error.message || error);
    if (error.stack) {
      console.error("Stack Trace:", error.stack);
    }
  }
}

main();
