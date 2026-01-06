import "dotenv/config";
import {
  SuilendClient,
  LENDING_MARKET_ID,
  LENDING_MARKET_TYPE,
} from "@suilend/sdk";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

// Mainnet Coin Types
const SUI_COIN_TYPE = "0x2::sui::SUI";
const DEPOSIT_COIN_TYPE =
  process.env.DEPOSIT_COIN_TYPE ||
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
  console.log("--- Suilend Deposit & Lending Script ---");

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

  const balances = await suiClient.getAllBalances({ owner: userAddress });
  console.log("\nUser Balances:");
  balances.forEach((b) => {
    let coinName = b.coinType;
    if (b.coinType === SUI_COIN_TYPE) coinName = "SUI";
    else if (b.coinType.includes(DEPOSIT_COIN_TYPE)) coinName = "Deposit Token";
    else if (b.coinType.includes("::usdc::USDC")) coinName = "USDC (Native)";
    else {
      const parts = b.coinType.split("::");
      if (parts.length > 0) coinName = parts[parts.length - 1];
    }
    console.log(`- ${coinName}: ${b.totalBalance}`);
  });

  try {
    // 3. Check/Create Obligation
    console.log("\nChecking for existing obligations...");
    const obligationOwnerCaps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      suiClient
    );

    let obligationOwnerCap = obligationOwnerCaps[0];
    let obligationId = obligationOwnerCap?.obligationId;

    if (!obligationOwnerCap) {
      console.log("No existing obligation found. Creating new obligation...");
      const createTx = new Transaction();
      const newObligationCap = suilendClient.createObligation(createTx);

      // Explicitly transfer the cap to the user to avoid UnusedValueWithoutDrop
      createTx.transferObjects([newObligationCap], userAddress);

      const result = await suiClient.signAndExecuteTransaction({
        signer: keypair,
        transaction: createTx,
        options: { showEffects: true },
      });
      console.log("Obligation created. Digest:", result.digest);

      // Wait a bit for indexing? (In a real script, might need retry or wait)
      // For this script, we assume it's available or we might need to fetch it again properly if the return type is just the cap object not the on-chain ID immediately usable without fetching?
      // actually createObligation returns the object argument for the transaction context.
      // After execution, we need to query the caps again to get the ID.
      console.log("Waiting for obligation creation to be indexed...");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const newCaps = await SuilendClient.getObligationOwnerCaps(
        userAddress,
        [LENDING_MARKET_TYPE],
        suiClient
      );
      obligationOwnerCap = newCaps[0];
      obligationId = obligationOwnerCap.obligationId;
    } else {
      console.log(`Found existing Obligation ID: ${obligationId}`);
    }

    if (!obligationId) {
      throw new Error("Failed to retrieve Obligation ID.");
    }

    // 4. Check existing deposit balance
    console.log("\nChecking existing deposits...");
    const obligationDetails = await SuilendClient.getObligation(
      obligationId,
      [LENDING_MARKET_TYPE],
      suiClient
    );

    const existingDeposit = obligationDetails.deposits.find((d: any) => {
      return (
        normalizeCoinType(d.coinType.name) ===
        normalizeCoinType(DEPOSIT_COIN_TYPE)
      );
    });

    if (existingDeposit) {
      console.log(
        `- Existing Deposit: ${existingDeposit.depositedCtokenAmount} cTokens`
      );
    } else {
      console.log("- Existing Deposit: None");
    }

    // Note: Adjust amount as needed.
    // Default threshold from env or fallback to 100,000
    const DEPOSIT_THRESHOLD = Number(process.env.DEPOSIT_THRESHOLD) || 100000;
    const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT || "100000";

    const depositValue = existingDeposit
      ? existingDeposit.depositedCtokenAmount
      : 0;

    if (Number(depositValue) > DEPOSIT_THRESHOLD) {
      console.log(
        `\nExisting deposit found: ${depositValue} cTokens. Skipping deposit (Threshold: ${DEPOSIT_THRESHOLD}).`
      );
    } else {
      console.log(`\nDepositing ${DEPOSIT_AMOUNT} units...`);
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
      console.log("Deposit successful. Digest:", depositResult.digest);
    }

    // 5. Borrow USDC
    // Refresh obligation first
    console.log("\nRefreshing obligation state...");
    let obligation = await SuilendClient.getObligation(
      obligationId,
      [LENDING_MARKET_TYPE],
      suiClient
    );

    // Borrow 0.01 USDC (USDC is 6 decimals, so 10000)
    // BE CAREFUL: Ensure you have enough collateral. 0.1 SUI (~$0.x) should cover 0.01 USDC easily.
    const borrowAmount = "10000"; // 0.01 USDC
    console.log(`\nBorrowing ${borrowAmount} units (0.01 USDC)...`);
    const borrowTx = new Transaction();

    console.log(`\nRefreshing obligation state ...`);
    await suilendClient.refreshAll(borrowTx, obligation);

    const reserves = suilendClient.lendingMarket.reserves;
    console.log("\nMarket Reserves:");
    for (const reserve of reserves) {
      console.log(`- Coin: ${reserve.coinType.name}`);
      console.log(`  ID: ${reserve.id}`);
      console.log(`  Mint Decimals: ${reserve.mintDecimals}`);
    }

    console.log("\nDone!");
  } catch (e: any) {
    console.error("\nERROR:", e.message || e);
  }
}

main();
