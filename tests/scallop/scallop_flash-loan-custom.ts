import * as dotenv from "dotenv";
dotenv.config(); // Load SECRET_KEY from .env
dotenv.config({ path: ".env.public" }); // Load other configs from .env.public

import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { getTokenPrice } from "@7kprotocol/sdk-ts";
import { ScallopFlashLoanClient } from "../../src/lib/scallop";
import { getReserveByCoinType, COIN_TYPES } from "../../src/lib/suilend/const";

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

async function testFlashLoanWithCustomClient() {
  // 1. Initial Setup
  const secretKey = process.env.SECRET_KEY;
  const SUI_FULLNODE_URL =
    process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

  // Flash loan settings from .env.public
  const FLASH_LOAN_COIN_TYPE =
    process.env.FLASH_LOAN_COIN_TYPE || COIN_TYPES.USDC;
  const FLASH_LOAN_AMOUNT = process.env.FLASH_LOAN_AMOUNT || "1000000"; // Default: 1 USDC (6 decimals)

  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error("Please provide a valid SECRET_KEY in .env file.");
    return;
  }

  let keypair;
  try {
    keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  } catch (e) {
    console.error("Error creating keypair:", e);
    return;
  }

  const sender = keypair.getPublicKey().toSuiAddress();
  console.log("Sender Address:", sender);

  const client = new SuiClient({ url: SUI_FULLNODE_URL });

  // 2. Get asset info from const.ts
  const normalizedCoinType = normalizeCoinType(FLASH_LOAN_COIN_TYPE);
  const reserve = getReserveByCoinType(normalizedCoinType);
  const decimals = reserve?.decimals || 6;
  const symbol = reserve?.symbol || "USDC";

  // Get Scallop coin name (lowercase symbol for Scallop)
  const coinName = symbol.toLowerCase();

  // 3. Get price from 7k
  const assetPrice = await getTokenPrice(normalizedCoinType);
  const loanAmount = BigInt(FLASH_LOAN_AMOUNT);
  const humanAmount = Number(loanAmount) / Math.pow(10, decimals);
  const usdValue = humanAmount * assetPrice;

  console.log(`\n📊 Flash Loan Info:`);
  console.log(`─`.repeat(40));
  console.log(`  Asset:       ${symbol}`);
  console.log(
    `  Amount:      ${formatUnits(
      loanAmount,
      decimals
    )} ${symbol} (Raw: ${loanAmount.toString()})`
  );
  console.log(`  Price:       $${assetPrice.toFixed(4)}`);
  console.log(`  USD Value:   ~$${usdValue.toFixed(2)}`);
  console.log(`─`.repeat(40));

  // 4. Create Custom Flash Loan Client
  const flashLoanClient = new ScallopFlashLoanClient();

  // 5. Create Transaction
  const tx = new Transaction();
  tx.setSender(sender);

  try {
    // 6. Borrow Flash Loan
    console.log(
      `\n🔄 Borrowing ${formatUnits(loanAmount, decimals)} ${symbol}...`
    );
    const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(
      tx,
      loanAmount,
      coinName
    );

    /**
     * [이 지점에 스왑/레버리지 로직 추가 가능]
     * 예: const swappedCoin = await metaAg.swap({ ... tx, coinIn: loanCoin });
     */

    // 7. Repay Flash Loan (바로 상환)
    console.log(
      `💰 Repaying ${formatUnits(loanAmount, decimals)} ${symbol}...`
    );
    flashLoanClient.repayFlashLoan(tx, loanCoin, receipt, coinName);

    // 8. Dry Run first
    console.log("\n🧪 Running dry-run...");
    const dryRunResult = await client.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client }),
    });

    if (dryRunResult.effects.status.status === "failure") {
      console.error("❌ Dry-run failed:", dryRunResult.effects.status.error);
      return;
    }

    console.log("✅ Dry-run successful!");

    // 9. Execute Transaction
    console.log("\n🚀 Executing transaction...");
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });

    if (result.effects?.status.status === "success") {
      console.log(`\n✅ Flash Loan Success!`);
      console.log(`📋 Digest: ${result.digest}`);
      console.log(
        `📊 Borrowed & Repaid: ${formatUnits(
          loanAmount,
          decimals
        )} ${symbol} (~$${usdValue.toFixed(2)})`
      );
    } else {
      console.error("❌ Flash Loan Failed:", result.effects?.status.error);
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

testFlashLoanWithCustomClient().catch((err) => {
  console.error("Unhandled error:", err);
});
