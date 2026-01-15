import * as dotenv from "dotenv";
dotenv.config(); // Load SECRET_KEY from .env
dotenv.config({ path: ".env.public" }); // Load other configs from .env.public
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  SuilendClient,
  LENDING_MARKET_ID,
  LENDING_MARKET_TYPE,
} from "@suilend/sdk";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import { ScallopFlashLoanClient } from "../src/lib/scallop";
import { getReserveByCoinType, COIN_TYPES } from "../src/lib/const";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");
const USDC_COIN_TYPE = COIN_TYPES.USDC;

function normalizeCoinType(coinType: string) {
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
  console.log("  📈 Leverage Strategy (Dry Run)");
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
  const suilendClient = await SuilendClient.initialize(
    LENDING_MARKET_ID,
    LENDING_MARKET_TYPE,
    suiClient
  );
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
  const reserve = getReserveByCoinType(normalizedDepositCoin);
  const decimals = reserve?.decimals || 8;
  const symbol = reserve?.symbol || "LBTC";

  // 3. Calculate values using getTokenPrice
  const depositPrice = await getTokenPrice(normalizedDepositCoin);
  const usdcPrice = await getTokenPrice(normalizeCoinType(USDC_COIN_TYPE));

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
  const LTV = 0.6; // LBTC LTV
  const maxMultiplier = 1 / (1 - LTV);
  const liquidationPrice = debtUsd / (depositAmountHuman * MULTIPLIER) / LTV;

  console.log(`\n📊 Leverage Position Preview:`);
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
    // 4. Get swap quote: USDC -> Deposit Asset
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
    console.log(
      `  Expected:     ${formatUnits(expectedOutput, decimals)} ${symbol}`
    );

    // 5. Build Transaction
    console.log(`\n🔧 Building transaction...`);
    const tx = new Transaction();
    tx.setSender(userAddress);

    // A. Flash loan USDC
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

    // C. Get or create obligation
    const obligationOwnerCaps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      suiClient
    );
    const existingCap = obligationOwnerCaps[0];
    let obligationOwnerCap: any;
    let obligationId: string;
    let isNewObligation = false;

    if (existingCap) {
      obligationOwnerCap = existingCap.id;
      obligationId = existingCap.obligationId;
      console.log(`  Step 3: Using existing obligation`);
    } else {
      console.log(`  Step 3: Creating new obligation`);
      obligationOwnerCap = suilendClient.createObligation(tx);
      obligationId = "";
      isNewObligation = true;
    }

    // D. Handle deposit coin based on type (SUI vs non-SUI)
    const isSui = normalizedDepositCoin.endsWith("::sui::SUI");
    let depositCoin: any;

    if (isSui) {
      // For SUI: split user's deposit amount from gas, then merge with swapped SUI
      console.log(
        `  Step 4: Split user's SUI from gas and merge with swapped SUI`
      );
      // Split only user's initial deposit amount (not including expected swap output)
      const [userDeposit] = tx.splitCoins(tx.gas, [BigInt(DEPOSIT_AMOUNT)]);
      // Merge swapped SUI into user's deposit
      tx.mergeCoins(userDeposit, [swappedAsset]);
      depositCoin = userDeposit;
    } else {
      // For non-SUI: merge user's coins with swapped asset
      console.log(`  Step 4: Merge user's ${symbol} with swapped ${symbol}`);
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

    // E. Refresh oracles BEFORE deposit (required for both new and existing obligations)
    console.log(`  Step 5: Refresh oracles`);
    if (existingCap) {
      const obligation = await SuilendClient.getObligation(
        obligationId,
        [LENDING_MARKET_TYPE],
        suiClient
      );
      // Include both deposit coin and USDC in refresh
      await suilendClient.refreshAll(tx, obligation, [
        normalizedDepositCoin,
        USDC_COIN_TYPE,
      ]);
    } else {
      // For new obligations, refresh the reserve prices directly
      await suilendClient.refreshAll(tx, undefined, [
        normalizedDepositCoin,
        USDC_COIN_TYPE,
      ]);
    }

    // F. Deposit merged coins (user's + swapped)
    console.log(`  Step 6: Deposit all ${symbol} as collateral`);
    suilendClient.deposit(
      depositCoin,
      normalizedDepositCoin,
      obligationOwnerCap,
      tx
    );

    // G. Calculate repayment amount (flash loan + fee)
    const flashLoanFee = ScallopFlashLoanClient.calculateFee(BigInt(flashLoanUsdc));
    const repaymentAmount = BigInt(flashLoanUsdc) + flashLoanFee;

    // Borrow USDC to repay flash loan (no refresh - already done above)
    console.log(`  Step 7: Borrow ${formatUnits(repaymentAmount, 6)} USDC (includes flash loan fee)`);
    const borrowedUsdc = await suilendClient.borrow(
      obligationOwnerCap,
      obligationId || "0x0",
      USDC_COIN_TYPE,
      repaymentAmount.toString(),
      tx,
      false // Already did refreshAll above
    );

    // H. Repay flash loan with borrowed USDC
    console.log(`  Step 8: Repay flash loan`);
    flashLoanClient.repayFlashLoan(tx, borrowedUsdc[0] as any, receipt, "usdc");

    // I. If new obligation was created, transfer the cap to user
    if (isNewObligation) {
      console.log(`  Step 9: Transfer new ObligationOwnerCap to user`);
      tx.transferObjects([obligationOwnerCap], userAddress);
    }

    // 6. Dry Run
    console.log(`\n🧪 Running dry-run...`);
    const dryRunResult = await suiClient.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client: suiClient }),
    });

    if (dryRunResult.effects.status.status === "success") {
      console.log(`✅ Dry-run successful!`);
      console.log(`\n💡 To execute, use: npm run test:leverage-exec`);
    } else {
      console.error(`❌ Dry-run failed:`, dryRunResult.effects.status.error);
    }

    console.log(`\n` + "─".repeat(55));
    console.log(`  ✨ Done!`);
    console.log("─".repeat(55));
  } catch (error: any) {
    console.error(`\n❌ ERROR: ${error.message || error}`);
  }
}

main();
