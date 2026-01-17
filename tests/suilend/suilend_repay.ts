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
import { getReserveByCoinType, COIN_TYPES } from "../../src/lib/suilend/const";

// Config from .env.public
const SUI_COIN_TYPE = "0x2::sui::SUI";
const REPAY_COIN_TYPE = process.env.REPAY_COIN_TYPE || COIN_TYPES.USDC;
const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

// Suilend uses WAD (10^18) for internal precision
const WAD = 10n ** 18n;

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
  console.log("  💸 Suilend Repay Script");
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

  // 2. Show relevant balances
  const balances = await suiClient.getAllBalances({ owner: userAddress });
  const normalizedRepayCoin = normalizeCoinType(REPAY_COIN_TYPE);
  const reserve = getReserveByCoinType(normalizedRepayCoin);
  const decimals = reserve?.decimals || 6;
  const symbol = reserve?.symbol || "USDC";

  console.log(`\n💰 Balances:`);
  let userRepayBalance = 0n;
  balances.forEach((b) => {
    const normalizedB = normalizeCoinType(b.coinType);
    if (normalizedB === normalizedRepayCoin) {
      userRepayBalance = BigInt(b.totalBalance);
      console.log(
        `  • ${symbol}: ${formatUnits(b.totalBalance, decimals)} (Raw: ${
          b.totalBalance
        })`
      );
    } else if (b.coinType === SUI_COIN_TYPE) {
      console.log(`  • SUI: ${formatUnits(b.totalBalance, 9)}`);
    }
  });

  try {
    // 3. Check Obligation
    const obligationOwnerCaps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      suiClient
    );

    if (obligationOwnerCaps.length === 0) {
      console.log(`\n⚠️  No obligation found. Nothing to repay.`);
      return;
    }

    const obligationOwnerCap = obligationOwnerCaps[0];
    const obligationId = obligationOwnerCap.obligationId;
    console.log(`\n📋 Obligation: ${obligationId.slice(0, 20)}...`);

    // 4. Check existing borrows
    const obligation = await SuilendClient.getObligation(
      obligationId,
      [LENDING_MARKET_TYPE],
      suiClient
    );

    if (obligation.borrows.length === 0) {
      console.log(`\n⚠️  No borrows found. Nothing to repay.`);
      return;
    }

    console.log(`\n📊 Current Borrows:`);
    obligation.borrows.forEach((b: any) => {
      const coinName = b.coinType.name.split("::").pop();
      const rawAmount = BigInt(b.borrowedAmount.value);
      const amount = rawAmount / WAD;
      console.log(
        `  • ${coinName}: ${formatUnits(amount, 6)} (Raw: ${amount})`
      );
    });

    // Find the borrow to repay
    const existingBorrow = obligation.borrows.find((b: any) => {
      return normalizeCoinType(b.coinType.name) === normalizedRepayCoin;
    });

    if (!existingBorrow) {
      console.log(`\n⚠️  No ${symbol} borrow found. Nothing to repay.`);
      return;
    }

    const borrowedRaw = BigInt(existingBorrow.borrowedAmount.value);
    const borrowedAmount = borrowedRaw / WAD;

    // Get asset price
    const assetPrice = await getTokenPrice(normalizedRepayCoin);
    const humanBorrowed = Number(borrowedAmount) / Math.pow(10, decimals);
    const usdValue = humanBorrowed * assetPrice;

    console.log(`\n📊 Repay Info:`);
    console.log(`─`.repeat(45));
    console.log(`  Asset:       ${symbol}`);
    console.log(
      `  Debt:        ${formatUnits(borrowedAmount, decimals)} ${symbol}`
    );
    console.log(`  USD Value:   ~$${usdValue.toFixed(2)}`);
    console.log(
      `  User Balance: ${formatUnits(userRepayBalance, decimals)} ${symbol}`
    );
    console.log(`─`.repeat(45));

    // 5. Determine repay amount with buffer (following Suilend SDK pattern)
    // Buffer accounts for interest accrued between calculation and execution
    // < $0.1 → $0.1 fixed, < $1 → 10% buffer, < $10 → 1% buffer, >= $10 → 0.1% buffer
    let repayWithBuffer: bigint;
    if (usdValue < 0.1) {
      // Fixed minimum of $0.1 worth
      repayWithBuffer = BigInt(
        Math.ceil((0.1 / assetPrice) * Math.pow(10, decimals))
      );
    } else if (usdValue < 1) {
      // 10% buffer for small debts
      repayWithBuffer = (borrowedAmount * BigInt(110)) / BigInt(100);
    } else if (usdValue < 10) {
      // 1% buffer for medium debts
      repayWithBuffer = (borrowedAmount * BigInt(101)) / BigInt(100);
    } else {
      // 0.1% buffer for larger debts
      repayWithBuffer = (borrowedAmount * BigInt(1001)) / BigInt(1000);
    }

    // Use the minimum of user balance or repay with buffer
    const repayAmount =
      userRepayBalance < repayWithBuffer ? userRepayBalance : repayWithBuffer;

    if (repayAmount === 0n) {
      console.log(`\n⚠️  No ${symbol} balance to repay with.`);
      return;
    }

    console.log(
      `\n🔄 Repaying ${formatUnits(
        repayAmount,
        decimals
      )} ${symbol} (with buffer for interest)...`
    );

    // 6. Build repay transaction
    const tx = new Transaction();
    tx.setSender(userAddress);

    // Get user's USDC coins
    const userCoins = await suiClient.getCoins({
      owner: userAddress,
      coinType: normalizedRepayCoin,
    });

    console.log(`\nUser coins: ${userCoins.data.length}`);

    if (userCoins.data.length === 0) {
      console.log(`\n⚠️  No ${symbol} coins found in wallet.`);
      return;
    }

    // Merge coins if necessary
    const primaryCoin = tx.object(userCoins.data[0].coinObjectId);
    if (userCoins.data.length > 1) {
      const otherCoins = userCoins.data
        .slice(1)
        .map((c) => tx.object(c.coinObjectId));
      tx.mergeCoins(primaryCoin, otherCoins);
    }

    // Split exact repay amount
    const [repayCoin] = tx.splitCoins(primaryCoin, [repayAmount]);

    // Refresh oracles first
    await suilendClient.refreshAll(tx, obligation);

    // Repay - following SDK pattern from repayIntoObligation:
    // repay() returns a result, and the input sendCoin should be transferred back
    suilendClient.repay(obligationId, normalizedRepayCoin, repayCoin, tx);

    // Transfer coins back to user (repayCoin may have remaining balance after repay)
    tx.transferObjects([primaryCoin, repayCoin], userAddress);

    // 7. Execute transaction
    console.log(`\n🚀 Executing transaction...`);
    const result = await suiClient.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showEffects: true },
    });

    if (result.effects?.status.status === "success") {
      console.log(`\n✅ Repay successful!`);
      console.log(`📋 Digest: ${result.digest}`);
      console.log(
        `💵 Repaid: ${formatUnits(repayAmount, decimals)} ${symbol} (~$${(
          (Number(repayAmount) / Math.pow(10, decimals)) *
          assetPrice
        ).toFixed(2)})`
      );
    } else {
      console.error(`\n❌ Transaction failed:`, result.effects?.status.error);
    }

    console.log(`\n` + "─".repeat(50));
    console.log(`  ✨ Done!`);
    console.log("─".repeat(50));
  } catch (e: any) {
    console.error(`\n❌ ERROR: ${e.message || e}`);
    if (e.stack) {
      console.error(e.stack);
    }
  }
}

main();
