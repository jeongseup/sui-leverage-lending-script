import * as dotenv from "dotenv";
dotenv.config(); // Load SECRET_KEY from .env
dotenv.config({ path: ".env.public" }); // Load other configs from .env.public
import {
  SuilendClient,
  LENDING_MARKET_ID,
  LENDING_MARKET_TYPE,
} from "@suilend/sdk";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getTokenPrice } from "@7kprotocol/sdk-ts";
import { getReserveByCoinType } from "../../src/lib/suilend/const";

// Config from .env.public
const BORROW_COIN_TYPE =
  process.env.BORROW_COIN_TYPE ||
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

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
  console.log("─".repeat(50));
  console.log("  💸 Suilend Borrow Script");
  console.log("─".repeat(50));

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
  const suilendClient = await SuilendClient.initialize(
    LENDING_MARKET_ID,
    LENDING_MARKET_TYPE,
    suiClient
  );

  // 2. Get asset info
  const normalizedBorrowCoin = normalizeCoinType(BORROW_COIN_TYPE);
  const reserve = getReserveByCoinType(normalizedBorrowCoin);
  const decimals = reserve?.decimals || 6;
  const symbol = reserve?.symbol || "USDC";

  try {
    // 3. Get obligation
    const obligationOwnerCaps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      suiClient
    );

    if (obligationOwnerCaps.length === 0) {
      throw new Error("No obligations found. Please deposit first.");
    }

    const obligationOwnerCap = obligationOwnerCaps[0];
    const obligation = await SuilendClient.getObligation(
      obligationOwnerCap.obligationId,
      [LENDING_MARKET_TYPE],
      suiClient
    );
    console.log(
      `\n📋 Obligation: ${obligationOwnerCap.obligationId.slice(0, 20)}...`
    );

    // 4. Show current deposits
    if (obligation.deposits.length > 0) {
      console.log(`\n💰 Current Collateral:`);
      obligation.deposits.forEach((d: any) => {
        const coinName = d.coinType.name.split("::").pop();
        console.log(`  • ${coinName}: ${d.depositedCtokenAmount} cTokens`);
      });
    }

    // 5. Show current borrows
    if (obligation.borrows.length > 0) {
      console.log(`\n📊 Current Borrows:`);
      const WAD = 10n ** 18n;
      obligation.borrows.forEach((b: any) => {
        const coinName = b.coinType.name.split("::").pop();
        const borrowedAmount = BigInt(b.borrowedAmount.value) / WAD;
        console.log(`  • ${coinName}: ${borrowedAmount.toString()} (Raw)`);
      });
    } else {
      console.log(`\n📊 Current Borrows: None`);
    }

    // 6. Borrow settings
    const BORROW_AMOUNT = process.env.BORROW_AMOUNT || "500000";
    const BORROW_THRESHOLD = Number(process.env.BORROW_THRESHOLD) || 500000;

    // Get price
    const assetPrice = await getTokenPrice(normalizedBorrowCoin);
    const humanAmount = Number(BORROW_AMOUNT) / Math.pow(10, decimals);
    const usdValue = humanAmount * assetPrice;

    // Check existing borrow
    const existingBorrow = obligation.borrows.find((b: any) => {
      return normalizeCoinType(b.coinType.name) === normalizedBorrowCoin;
    });

    let borrowedAmount = 0n;
    if (existingBorrow) {
      const WAD = 10n ** 18n;
      borrowedAmount = BigInt(existingBorrow.borrowedAmount.value) / WAD;
    }

    console.log(`\n📊 Borrow Info:`);
    console.log(`─`.repeat(45));
    console.log(`  Asset:       ${symbol}`);
    console.log(
      `  Amount:      ${formatUnits(
        BORROW_AMOUNT,
        decimals
      )} ${symbol} (Raw: ${BORROW_AMOUNT})`
    );
    console.log(`  Price:       $${assetPrice.toFixed(4)}`);
    console.log(`  USD Value:   ~$${usdValue.toFixed(2)}`);
    if (existingBorrow) {
      console.log(`  Existing:    ${borrowedAmount.toString()} (Raw)`);
    }
    console.log(`─`.repeat(45));

    // 7. Execute borrow
    if (Number(borrowedAmount) >= BORROW_THRESHOLD) {
      console.log(
        `\n⏭️  Skipping borrow (existing >= threshold: ${BORROW_THRESHOLD})`
      );
    } else {
      console.log(
        `\n🔄 Borrowing ${formatUnits(BORROW_AMOUNT, decimals)} ${symbol}...`
      );

      const transaction = new Transaction();
      await suilendClient.refreshAll(transaction, obligation);

      const borrowResult = await suilendClient.borrow(
        obligationOwnerCap.id,
        obligationOwnerCap.obligationId,
        BORROW_COIN_TYPE,
        BORROW_AMOUNT,
        transaction
      );

      transaction.transferObjects([borrowResult], userAddress);

      const result = await suiClient.signAndExecuteTransaction({
        signer: keypair,
        transaction: transaction,
        options: { showEffects: true },
      });

      console.log(`\n✅ Borrow successful!`);
      console.log(`📋 Digest: ${result.digest}`);
      console.log(
        `💵 Received: ${formatUnits(
          BORROW_AMOUNT,
          decimals
        )} ${symbol} (~$${usdValue.toFixed(2)})`
      );
    }

    console.log(`\n` + "─".repeat(50));
    console.log(`  ✨ Done!`);
    console.log("─".repeat(50));
  } catch (error: any) {
    console.error(`\n❌ ERROR: ${error.message || error}`);
  }
}

main();
