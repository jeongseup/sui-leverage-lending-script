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
import { normalizeCoinType, formatUnits } from "../../src/lib/utils";

// Config from .env.public
const SUI_COIN_TYPE = "0x2::sui::SUI";
const DEPOSIT_COIN_TYPE =
  process.env.DEPOSIT_COIN_TYPE ||
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

async function main() {
  console.log("─".repeat(50));
  console.log("  📦 Suilend Deposit Script");
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
  const normalizedDepositCoin = normalizeCoinType(DEPOSIT_COIN_TYPE);
  const reserve = getReserveByCoinType(normalizedDepositCoin);
  const decimals = reserve?.decimals || 6;
  const symbol = reserve?.symbol || "Token";

  console.log(`\n💰 Balances:`);
  balances.forEach((b) => {
    const normalizedB = normalizeCoinType(b.coinType);
    if (normalizedB === normalizedDepositCoin) {
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

    let obligationOwnerCap = obligationOwnerCaps[0];
    let obligationId = obligationOwnerCap?.obligationId;

    if (!obligationOwnerCap) {
      console.log(`\n📝 Creating new obligation...`);
      const createTx = new Transaction();
      const newObligationCap = suilendClient.createObligation(createTx);
      createTx.transferObjects([newObligationCap], userAddress);

      const result = await suiClient.signAndExecuteTransaction({
        signer: keypair,
        transaction: createTx,
        options: { showEffects: true },
      });
      console.log(`  ✅ Created! Digest: ${result.digest}`);

      await new Promise((resolve) => setTimeout(resolve, 3000));
      const newCaps = await SuilendClient.getObligationOwnerCaps(
        userAddress,
        [LENDING_MARKET_TYPE],
        suiClient
      );
      obligationOwnerCap = newCaps[0];
      obligationId = obligationOwnerCap.obligationId;
    } else {
      console.log(`\n📋 Obligation: ${obligationId?.slice(0, 20)}...`);
    }

    if (!obligationId) {
      throw new Error("Failed to retrieve Obligation ID.");
    }

    // 4. Check existing deposits
    const obligationDetails = await SuilendClient.getObligation(
      obligationId,
      [LENDING_MARKET_TYPE],
      suiClient
    );

    const existingDeposit = obligationDetails.deposits.find((d: any) => {
      return normalizeCoinType(d.coinType.name) === normalizedDepositCoin;
    });

    const DEPOSIT_THRESHOLD = Number(process.env.DEPOSIT_THRESHOLD) || 100000;
    const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT || "100000";
    const depositValue = existingDeposit?.depositedCtokenAmount || 0;

    // Get asset price
    const assetPrice = await getTokenPrice(normalizedDepositCoin);
    const humanAmount = Number(DEPOSIT_AMOUNT) / Math.pow(10, decimals);
    const usdValue = humanAmount * assetPrice;

    // Show deposit info
    console.log(`\n📊 Deposit Info:`);
    console.log(`─`.repeat(45));
    console.log(`  Asset:       ${symbol}`);
    console.log(
      `  Amount:      ${formatUnits(
        DEPOSIT_AMOUNT,
        decimals
      )} ${symbol} (Raw: ${DEPOSIT_AMOUNT})`
    );
    console.log(`  Price:       $${assetPrice.toLocaleString()}`);
    console.log(`  USD Value:   ~$${usdValue.toFixed(2)}`);
    if (existingDeposit) {
      console.log(`  Existing:    ${depositValue} cTokens`);
    }
    console.log(`─`.repeat(45));

    // 5. Deposit if needed
    if (Number(depositValue) > DEPOSIT_THRESHOLD) {
      console.log(
        `\n⏭️  Skipping deposit (existing > threshold: ${DEPOSIT_THRESHOLD})`
      );
    } else {
      console.log(
        `\n🔄 Depositing ${formatUnits(DEPOSIT_AMOUNT, decimals)} ${symbol}...`
      );

      const depositTx = new Transaction();
      await suilendClient.depositIntoObligation(
        userAddress,
        DEPOSIT_COIN_TYPE,
        DEPOSIT_AMOUNT,
        depositTx,
        obligationOwnerCap.id
      );

      const depositResult = await suiClient.signAndExecuteTransaction({
        signer: keypair,
        transaction: depositTx,
        options: { showEffects: true },
      });

      console.log(`\n✅ Deposit successful!`);
      console.log(`📋 Digest: ${depositResult.digest}`);
    }

    console.log(`\n` + "─".repeat(50));
    console.log(`  ✨ Done!`);
    console.log("─".repeat(50));
  } catch (e: any) {
    console.error(`\n❌ ERROR: ${e.message || e}`);
  }
}

main();
