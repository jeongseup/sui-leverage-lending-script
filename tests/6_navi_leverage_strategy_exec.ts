import * as dotenv from "dotenv";
dotenv.config(); // Load SECRET_KEY from .env
dotenv.config({ path: ".env.public" }); // Load other configs from .env.public
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  depositCoinPTB,
  borrowCoinPTB,
  getPools,
  updateOraclePricesPTB,
  getPriceFeeds,
  normalizeCoinType,
} from "@naviprotocol/lending";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import { ScallopFlashLoanClient } from "../src/lib/scallop";
import { getReserveByCoinType, COIN_TYPES } from "../src/lib/const";

/**
 * Navi Leverage Strategy with Scallop Flash Loan + 7k Swap (Execute)
 *
 * Flow:
 * 1. Flash loan USDC from Scallop
 * 2. Swap USDC to deposit asset using 7k aggregator
 * 3. Deposit swapped asset + user's asset to Navi
 * 4. Borrow USDC from Navi
 * 5. Repay Scallop flash loan
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
  console.log("  📈 Navi Leverage Strategy (Execute)");
  console.log("  ⚠️  WARNING: This will execute a REAL transaction!");
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
  const flashLoanClient = new ScallopFlashLoanClient();
  const metaAg = new MetaAg({
    partner:
      "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf",
  });

  // Log wallet balances
  console.log(`\n💰 Wallet Balances:`);
  const allBalances = await suiClient.getAllBalances({ owner: userAddress });
  for (const b of allBalances) {
    const sym = b.coinType.split("::").pop();
    if (Number(b.totalBalance) > 0) {
      console.log(`   ${sym}: ${b.totalBalance}`);
    }
  }
  const suiCoins = await suiClient.getCoins({
    owner: userAddress,
    coinType: "0x2::sui::SUI",
  });
  console.log(`   SUI Coins Count: ${suiCoins.data.length}`);

  // 2. Get config from .env.public
  const DEPOSIT_COIN_TYPE =
    process.env.LEVERAGE_DEPOSIT_COIN_TYPE || COIN_TYPES.LBTC;
  const DEPOSIT_AMOUNT = process.env.LEVERAGE_DEPOSIT_AMOUNT || "1101";
  const MULTIPLIER = parseFloat(process.env.LEVERAGE_MULTIPLIER || "1.5");

  const normalizedDepositCoin = normalizeCoinType(DEPOSIT_COIN_TYPE);
  const normalizedUsdcCoin = normalizeCoinType(USDC_COIN_TYPE);
  const reserve = getReserveByCoinType(normalizedDepositCoin);
  const decimals = reserve?.decimals || 8;
  const symbol = reserve?.symbol || "LBTC";

  // 3. Calculate values using getTokenPrice
  const depositPrice = await getTokenPrice(normalizedDepositCoin);

  const depositAmountHuman = Number(DEPOSIT_AMOUNT) / Math.pow(10, decimals);
  const initialEquityUsd = depositAmountHuman * depositPrice;

  // Flash loan amount = Initial Equity * (Multiplier - 1)
  const flashLoanUsd = initialEquityUsd * (MULTIPLIER - 1);
  const flashLoanUsdc = Math.ceil(flashLoanUsd * 1e6 * 1.02); // 6 decimals + 2% buffer

  // Total position after leverage
  const totalPositionUsd = initialEquityUsd * MULTIPLIER;
  const debtUsd = flashLoanUsd;
  const netWorthUsd = totalPositionUsd - debtUsd;
  const actualLtv = debtUsd / totalPositionUsd;

  // LTV and liquidation calculation
  const LTV = 0.6; // Assume 60% LTV
  const maxMultiplier = 1 / (1 - LTV);
  const liquidationPrice = debtUsd / (depositAmountHuman * MULTIPLIER) / LTV;

  console.log(`\n📊 Leverage Position Preview (Navi):`);
  console.log(`─`.repeat(55));
  console.log(`  Asset:              ${symbol}`);
  console.log(
    `  Initial Deposit:    ${formatUnits(
      DEPOSIT_AMOUNT,
      decimals
    )} ${symbol} (Raw: ${DEPOSIT_AMOUNT})`
  );
  console.log(`  ${symbol} Price:         $${depositPrice.toLocaleString()}`);
  console.log(`  Initial Equity:     ~$${initialEquityUsd.toFixed(2)}`);
  console.log(`─`.repeat(55));
  console.log(
    `  Multiplier:         ${MULTIPLIER}x (Max: ${maxMultiplier.toFixed(2)}x)`
  );
  console.log(
    `  Flash Loan:         ${formatUnits(
      flashLoanUsdc,
      6
    )} USDC (~$${flashLoanUsd.toFixed(2)})`
  );
  console.log(`─`.repeat(55));
  console.log(
    `  Total Collateral:   ~$${totalPositionUsd.toFixed(2)} ${symbol}`
  );
  console.log(`  Total Debt:         ~$${debtUsd.toFixed(2)} USDC`);
  console.log(`  Net Worth:          ~$${netWorthUsd.toFixed(2)}`);
  console.log(`  Position LTV:       ${(actualLtv * 100).toFixed(1)}%`);
  console.log(
    `  Liquidation Price:  $${liquidationPrice.toLocaleString(undefined, {
      maximumFractionDigits: 0,
    })}`
  );
  console.log(
    `  Price Drop Buffer:  ${(
      (1 - liquidationPrice / depositPrice) *
      100
    ).toFixed(1)}%`
  );
  console.log(`─`.repeat(55));

  if (MULTIPLIER > maxMultiplier) {
    console.error(
      `\n❌ Multiplier ${MULTIPLIER}x exceeds max ${maxMultiplier.toFixed(2)}x!`
    );
    return;
  }

  try {
    // 4. Fetch Navi pools
    console.log(`\nFetching Navi pools...`);
    const pools = await getPools({ env: "prod" });
    const poolsArray: any[] = Array.isArray(pools) ? pools : Object.values(pools);

    // Find deposit asset pool and USDC pool
    const depositPool = poolsArray.find((p) => {
      const ct = normalizeCoinType(p.coinType ?? p.suiCoinType ?? "");
      return ct === normalizedDepositCoin;
    });

    const usdcPool = poolsArray.find((p) => {
      const ct = normalizeCoinType(p.coinType ?? p.suiCoinType ?? "");
      return ct === normalizedUsdcCoin;
    });

    if (!depositPool) {
      console.error(`❌ ${symbol} pool not found in Navi`);
      return;
    }
    if (!usdcPool) {
      console.error(`❌ USDC pool not found in Navi`);
      return;
    }

    console.log(`  Found ${symbol} pool: ${depositPool.coinType}`);
    console.log(`  Found USDC pool: ${usdcPool.coinType}`);

    // 5. Fetch price feeds for oracle update
    const priceFeeds = await getPriceFeeds({ env: "prod" });
    const depositFeed = priceFeeds.find(
      (f: any) =>
        normalizeCoinType(f.coinType) === normalizeCoinType(depositPool.coinType)
    );
    const usdcFeed = priceFeeds.find(
      (f: any) =>
        normalizeCoinType(f.coinType) === normalizeCoinType(usdcPool.coinType)
    );

    // 6. Get swap quote: USDC -> Deposit Asset
    console.log(`\n🔍 Fetching swap quote: USDC → ${symbol}...`);
    const swapQuotes = await metaAg.quote({
      amountIn: flashLoanUsdc.toString(),
      coinTypeIn: USDC_COIN_TYPE,
      coinTypeOut: normalizedDepositCoin,
    });

    if (swapQuotes.length === 0) {
      console.log(`\n⚠️  No swap quotes found for USDC → ${symbol}`);
      return;
    }

    const bestQuote = swapQuotes.sort(
      (a, b) => Number(b.amountOut) - Number(a.amountOut)
    )[0];

    const expectedOutput = Number(bestQuote.amountOut);
    const totalDepositAmount = BigInt(DEPOSIT_AMOUNT) + BigInt(bestQuote.amountOut);
    console.log(
      `  Expected from swap: ${formatUnits(expectedOutput, decimals)} ${symbol}`
    );
    console.log(
      `  Total to deposit:   ${formatUnits(totalDepositAmount, decimals)} ${symbol}`
    );

    // 7. Build Transaction
    console.log(`\n🔧 Building transaction...`);
    const tx = new Transaction();
    tx.setSender(userAddress);
    tx.setGasBudget(100_000_000);

    // A. Flash loan USDC from Scallop
    console.log(`  Step 1: Flash loan ${formatUnits(flashLoanUsdc, 6)} USDC`);
    const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(
      tx,
      BigInt(flashLoanUsdc),
      "usdc"
    );

    // B. Swap USDC to deposit asset
    console.log(`  Step 2: Swap USDC → ${symbol}`);
    const swappedAsset = await metaAg.swap(
      {
        quote: bestQuote,
        signer: userAddress,
        coinIn: loanCoin,
        tx: tx,
      },
      100
    );

    // C. Handle deposit coin based on type (SUI vs non-SUI)
    const isSui = normalizedDepositCoin.endsWith("::sui::SUI");
    let depositCoin: any;

    if (isSui) {
      // For SUI: split user's deposit amount from gas, then merge with swapped SUI
      console.log(
        `  Step 3: Split user's SUI from gas and merge with swapped SUI`
      );
      const [userDeposit] = tx.splitCoins(tx.gas, [BigInt(DEPOSIT_AMOUNT)]);
      tx.mergeCoins(userDeposit, [swappedAsset]);
      depositCoin = userDeposit;
    } else {
      // For non-SUI: merge user's coins with swapped asset
      console.log(`  Step 3: Merge user's ${symbol} with swapped ${symbol}`);
      const userCoins = await suiClient.getCoins({
        owner: userAddress,
        coinType: normalizedDepositCoin,
      });

      if (userCoins.data.length === 0) {
        console.log(`\n⚠️  No ${symbol} coins found in wallet!`);
        return;
      }

      const primaryCoin = tx.object(userCoins.data[0].coinObjectId);
      if (userCoins.data.length > 1) {
        const otherCoins = userCoins.data
          .slice(1)
          .map((c) => tx.object(c.coinObjectId));
        tx.mergeCoins(primaryCoin, otherCoins);
      }
      tx.mergeCoins(primaryCoin, [swappedAsset]);
      depositCoin = primaryCoin;
    }

    // D. Update oracle prices (required before deposit/borrow)
    const feedsToUpdate = [depositFeed, usdcFeed].filter(Boolean);
    if (feedsToUpdate.length > 0) {
      console.log(`  Step 4: Update oracle prices`);
      await updateOraclePricesPTB(tx as any, feedsToUpdate, {
        env: "prod",
        updatePythPriceFeeds: true,
      });
    }

    // E. Deposit merged coins to Navi
    console.log(
      `  Step 5: Deposit ${formatUnits(totalDepositAmount, decimals)} ${symbol} to Navi`
    );
    await depositCoinPTB(tx as any, depositPool, depositCoin, {
      amount: Number(totalDepositAmount),
      env: "prod",
    });

    // F. Calculate repayment amount (flash loan + fee)
    const flashLoanFee = ScallopFlashLoanClient.calculateFee(BigInt(flashLoanUsdc));
    const repaymentAmount = BigInt(flashLoanUsdc) + flashLoanFee;

    // G. Borrow USDC from Navi to repay flash loan
    console.log(
      `  Step 6: Borrow ${formatUnits(repaymentAmount, 6)} USDC from Navi`
    );
    const borrowedUsdc = await borrowCoinPTB(
      tx as any,
      usdcPool,
      Number(repaymentAmount),
      { env: "prod" }
    );

    // H. Repay flash loan with borrowed USDC
    console.log(`  Step 7: Repay flash loan`);
    flashLoanClient.repayFlashLoan(tx, borrowedUsdc as any, receipt, "usdc");

    // 8. Execute Transaction
    console.log(`\n🚀 Executing transaction...`);
    const result = await suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });

    if (result.effects?.status.status === "success") {
      console.log(`\n✅ Leverage position created successfully!`);
      console.log(`📋 Digest: ${result.digest}`);
      console.log(`\n📊 Final Position:`);
      console.log(`─`.repeat(55));
      console.log(
        `  Collateral: ${formatUnits(totalDepositAmount, decimals)} ${symbol} (~$${totalPositionUsd.toFixed(2)})`
      );
      console.log(
        `  Debt:       ${formatUnits(repaymentAmount, 6)} USDC (~$${debtUsd.toFixed(2)})`
      );
      console.log(`  Leverage:   ${MULTIPLIER}x`);
      console.log(`─`.repeat(55));
    } else {
      console.error(`❌ Transaction failed:`, result.effects?.status.error);
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
