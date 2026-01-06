import "dotenv/config";
import {
  SuilendClient,
  LENDING_MARKET_ID,
  LENDING_MARKET_TYPE,
  numberToDecimal,
  decimalToBigNumber,
} from "@suilend/sdk";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

// Mainnet Coin Types
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

async function main() {
  console.log("--- Suilend Borrow Script ---");

  // 1. Setup User Address
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error("Error: SECRET_KEY not found in .env file.");
    return;
  }

  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  const userAddress = keypair.getPublicKey().toSuiAddress();
  console.log(`Using Wallet Address: ${userAddress}`);

  // 2. Initialize Clients
  const suiClient = new SuiClient({ url: SUI_FULLNODE_URL });
  console.log("Initializing Suilend Client...");
  const suilendClient = await SuilendClient.initialize(
    LENDING_MARKET_ID,
    LENDING_MARKET_TYPE,
    suiClient
  );
  console.log("Suilend Client initialized.");

  const obligationOwnerCaps = await SuilendClient.getObligationOwnerCaps(
    userAddress,
    [LENDING_MARKET_TYPE],
    suiClient
  );

  let obligationOwnerCap = obligationOwnerCaps[0];
  let obligationId = obligationOwnerCap?.obligationId;

  const obligationDetails = await SuilendClient.getObligation(
    obligationId,
    [LENDING_MARKET_TYPE],
    suiClient
  );

  if (obligationDetails.borrows.length > 0) {
    console.log("Current Borrows:");
    obligationDetails.borrows.forEach((b: any) => {
      const coinType = b.coinType.name;
      const coinName = coinType.split("::").pop(); // Get last part (e.g., USDT)
      const borrowedAmountDecimal = BigInt(b.borrowedAmount.value);
      // Decimal is 1e18 based.
      const WAD = 10n ** 18n;
      const rawAmount = borrowedAmountDecimal / WAD;

      console.log(`- ${coinName} (${coinType})`);
      console.log(`  Borrowed Amount (Raw): ${rawAmount.toString()}`);
      console.log(
        `  Borrowed Amount (Decimal Value): ${borrowedAmountDecimal.toString()}`
      );
    });
  } else {
    console.log("No current borrows.");
  }

  const transaction = new Transaction();

  try {
    // Step 1: Get your obligation
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
    console.log(`Found Obligation ID: ${obligationOwnerCap.obligationId}`);

    // Step 2: Refresh the obligation state
    // Inspect reserves to find correct index if needed, but trying default refresh first as per example
    // Step 3: Check existing borrows and Borrow
    const BORROW_AMOUNT = process.env.BORROW_AMOUNT || "100000";
    const BORROW_THRESHOLD = Number(process.env.BORROW_THRESHOLD) || 100000;

    const existingBorrow = obligation.borrows.find((b: any) => {
      return (
        normalizeCoinType(b.coinType.name) ===
        normalizeCoinType(BORROW_COIN_TYPE)
      );
    });

    let borrowedAmount = 0n;
    if (existingBorrow) {
      const WAD = 10n ** 18n;
      borrowedAmount = BigInt(existingBorrow.borrowedAmount.value) / WAD;
    }

    if (Number(borrowedAmount) >= BORROW_THRESHOLD) {
      console.log(
        `Existing borrow found: ${borrowedAmount.toString()}. Skipping borrow (Threshold: ${BORROW_THRESHOLD}).`
      );
    } else {
      console.log(`Borrowing ${BORROW_AMOUNT} units...`);
      // Refresh obligation before borrow
      await suilendClient.refreshAll(transaction, obligation);

      const borrowResult = await suilendClient.borrow(
        obligationOwnerCap.id,
        obligationOwnerCap.obligationId,
        BORROW_COIN_TYPE,
        BORROW_AMOUNT,
        transaction
      );

      // Step 4: Send borrowed tokens to yourself
      transaction.transferObjects([borrowResult], userAddress);

      const result = await suiClient.signAndExecuteTransaction({
        signer: keypair,
        transaction: transaction,
        options: { showEffects: true },
      });
      console.log("Borrow successful. Digest:", result.digest);
    }

    console.log("\nDone!");
  } catch (error: any) {
    console.error("Borrow failed:", error.message || error);
  }
}

main();
