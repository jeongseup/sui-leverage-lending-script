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
const WITHDRAW_COIN_TYPE = process.env.WITHDRAW_COIN_TYPE || SUI_COIN_TYPE;
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
  console.log("  🏦 Suilend Withdraw Script");
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
  const normalizedWithdrawCoin = normalizeCoinType(WITHDRAW_COIN_TYPE);
  const reserve = getReserveByCoinType(normalizedWithdrawCoin);
  const decimals = reserve?.decimals || 9;
  const symbol = reserve?.symbol || "SUI";

  console.log(`\n💰 Wallet Balances:`);
  balances.forEach((b) => {
    const normalizedB = normalizeCoinType(b.coinType);
    if (normalizedB === normalizedWithdrawCoin) {
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
      console.log(`\n⚠️  No obligation found. Nothing to withdraw.`);
      return;
    }

    const obligationOwnerCap = obligationOwnerCaps[0];
    const obligationId = obligationOwnerCap.obligationId;
    console.log(`\n📋 Obligation: ${obligationId.slice(0, 20)}...`);

    // 4. Check existing deposits
    const obligation = await SuilendClient.getObligation(
      obligationId,
      [LENDING_MARKET_TYPE],
      suiClient
    );

    if (obligation.deposits.length === 0) {
      console.log(`\n⚠️  No deposits found. Nothing to withdraw.`);
      return;
    }

    console.log(`\n📊 Current Deposits:`);
    obligation.deposits.forEach((d: any) => {
      const coinType = normalizeCoinType(d.coinType.name);
      const reserveInfo = getReserveByCoinType(coinType);
      const coinSymbol = reserveInfo?.symbol || coinType.split("::").pop();
      const coinDecimals = reserveInfo?.decimals || 9;
      const amount = BigInt(d.depositedCtokenAmount);
      console.log(
        `  • ${coinSymbol}: ${formatUnits(
          amount,
          coinDecimals
        )} (Raw: ${amount})`
      );
    });

    // Check for borrows - can't withdraw if there are borrows
    if (obligation.borrows.length > 0) {
      console.log(`\n⚠️  Warning: You have active borrows!`);
      console.log(`   Withdraw may be limited by collateral requirements.`);
      obligation.borrows.forEach((b: any) => {
        const coinName = b.coinType.name.split("::").pop();
        const WAD = 10n ** 18n;
        const rawAmount = BigInt(b.borrowedAmount.value);
        const amount = rawAmount / WAD;
        console.log(`  • ${coinName}: ${formatUnits(amount, 6)} borrowed`);
      });
    }

    // Find the deposit to withdraw
    const existingDeposit = obligation.deposits.find((d: any) => {
      return normalizeCoinType(d.coinType.name) === normalizedWithdrawCoin;
    });

    if (!existingDeposit) {
      console.log(`\n⚠️  No ${symbol} deposit found. Nothing to withdraw.`);
      return;
    }

    const depositedAmount = BigInt(existingDeposit.depositedCtokenAmount);

    // Get asset price
    const assetPrice = await getTokenPrice(normalizedWithdrawCoin);
    const humanDeposit = Number(depositedAmount) / Math.pow(10, decimals);
    const usdValue = humanDeposit * assetPrice;

    console.log(`\n📊 Withdraw Info:`);
    console.log(`─`.repeat(45));
    console.log(`  Asset:       ${symbol}`);
    console.log(
      `  Deposited:   ${formatUnits(depositedAmount, decimals)} ${symbol}`
    );
    console.log(`  USD Value:   ~$${usdValue.toFixed(2)}`);
    console.log(`─`.repeat(45));

    // 5. Determine withdraw amount
    // Get WITHDRAW_AMOUNT from env or use max (deposited amount)
    const WITHDRAW_AMOUNT =
      process.env.WITHDRAW_AMOUNT || depositedAmount.toString();
    const withdrawAmount =
      BigInt(WITHDRAW_AMOUNT) > depositedAmount
        ? depositedAmount
        : BigInt(WITHDRAW_AMOUNT);

    if (withdrawAmount === 0n) {
      console.log(`\n⚠️  No ${symbol} to withdraw.`);
      return;
    }

    console.log(
      `\n🔄 Withdrawing ${formatUnits(withdrawAmount, decimals)} ${symbol}...`
    );

    // 6. Build withdraw transaction
    const tx = new Transaction();
    tx.setSender(userAddress);

    // withdraw() returns [coin] from redeem()
    // It automatically handles refreshAll if addRefreshCalls is true (default)
    const [withdrawnCoin] = await suilendClient.withdraw(
      obligationOwnerCap.id,
      obligationId,
      normalizedWithdrawCoin,
      withdrawAmount.toString(),
      tx,
      true // addRefreshCalls
    );

    // Transfer withdrawn coin to user
    tx.transferObjects([withdrawnCoin], userAddress);

    // 7. Execute transaction
    console.log(`\n🚀 Executing transaction...`);
    const result = await suiClient.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showEffects: true },
    });

    if (result.effects?.status.status === "success") {
      console.log(`\n✅ Withdraw successful!`);
      console.log(`📋 Digest: ${result.digest}`);
      console.log(
        `💵 Withdrawn: ${formatUnits(withdrawAmount, decimals)} ${symbol} (~$${(
          (Number(withdrawAmount) / Math.pow(10, decimals)) *
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
