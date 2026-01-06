import "dotenv/config";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import {
  SuilendClient,
  LENDING_MARKET_ID,
  LENDING_MARKET_TYPE,
} from "@suilend/sdk";
import { Scallop } from "@scallop-io/sui-scallop-sdk";

// Constants from .env
const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");
const SECRET_KEY = process.env.SECRET_KEY;
const XBTC_COIN_TYPE =
  process.env.XBTC_COIN_TYPE ||
  "0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC";
const USDC_COIN_TYPE =
  process.env.USDC_COIN_TYPE ||
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

async function main() {
  console.log("--- Leverage Lending Script (Suilend + Scallop Flash Loan) ---");

  if (!SECRET_KEY || SECRET_KEY === "YOUR_SECRET_KEY_HERE") {
    console.error("Error: SECRET_KEY not found or invalid in .env file.");
    return;
  }

  // 1. Setup Client and User
  const suiClient = new SuiClient({ url: SUI_FULLNODE_URL });
  const keypair = Ed25519Keypair.fromSecretKey(SECRET_KEY as any);
  const userAddress = keypair.getPublicKey().toSuiAddress();
  console.log(`User Address: ${userAddress}`);

  // 2. Initialize Scallop SDK
  const scallopSDK = new Scallop({
    secretKey: SECRET_KEY,
    networkType: "mainnet",
  });
  await scallopSDK.init();
  const builder = await scallopSDK.createScallopBuilder();

  // 3. Initialize Suilend Client
  console.log("Initializing Suilend...");
  const suilendClient = await SuilendClient.initialize(
    LENDING_MARKET_ID,
    LENDING_MARKET_TYPE,
    suiClient
  );
  console.log("Suilend Initialized.");

  // 4. Construct Transaction
  // We creating a base Transaction from @mysten/sui and passing it to Scallop.
  // This allows us to use the SAME transaction for Suilend calls.
  const tx = new Transaction();
  const scallopTx = builder.createTxBlock(tx);
  tx.setSender(userAddress);

  const FLASH_LOAN_AMOUNT = 1_000_000; // Example: 1 USDC (6 decimals)
  console.log(`Preparing Flash Loan of ${FLASH_LOAN_AMOUNT} USDC...`);

  // --- Step 1: Borrow Flash Loan from Scallop ---
  // Returns [coin, receipt]
  // We use scallopTx wrapper for Scallop commands.
  const [loanCoin, loanReceipt] = await scallopTx.borrowFlashLoan(
    FLASH_LOAN_AMOUNT,
    "usdc"
  );

  // --- Step 2: Swap USDC to xBTC (Placeholder) ---
  console.log("  [Placeholder] Swapping USDC -> xBTC...");
  // FAKE SWAP: rename loanCoin. In reality, you'd swap and get a new Coin object.
  const swappedCoin = loanCoin;

  // --- Step 3: Deposit xBTC into Suilend ---
  console.log("  Depositing xBTC into Suilend...");
  const obligationOwnerCaps = await SuilendClient.getObligationOwnerCaps(
    userAddress,
    [LENDING_MARKET_TYPE],
    suiClient
  );

  let obligationOwnerCapId = obligationOwnerCaps[0]?.id;
  let obligationId = obligationOwnerCaps[0]?.obligationId;

  if (!obligationOwnerCapId) {
    console.log("  No Obligation found, creating one...");
    // createObligation returns the new cap.
    // We need to use it. For simplicity in skeleton, we assume it exists.
    // Or we can create it in the same TX.
    const newObligationCap = suilendClient.createObligation(tx); // Pass 'tx' NOT 'scallopTx'
    tx.transferObjects([newObligationCap], userAddress);
    // NOTE: If we just created it, we don't have its ID easily for subsequent calls in the same block
    // WITHOUT using the object reference directly in those calls.
    // Suilend SDK methods like deposit usually take ID string.
    // But some take ObjectInput. Check if 'obligationOwnerCap' param accepts the object.
    // Type is TransactionObjectInput. So we CAN pass newObligationCap!
    obligationOwnerCapId = newObligationCap as any; // Cast as any if Type mismatch on string vs Object
    // But for robust script:
    throw new Error(
      "Please create an Obligation first (run setup script) or implement inline creation logic with object references."
    );
  }

  // Use 'deposit' to use the specific object (swappedCoin)
  // We use 'tx' (the underlying Transaction) for Suilend calls.
  try {
    suilendClient.deposit(
      swappedCoin,
      XBTC_COIN_TYPE,
      obligationOwnerCapId,
      tx
    );
  } catch (e: any) {
    console.error("Error adding deposit command:", e.message);
    throw e;
  }

  // --- Step 4: Borrow USDC from Suilend ---
  console.log("  Borrowing USDC from Suilend...");

  // We borrow USDC.
  const borrowedUSDC = await suilendClient.borrow(
    obligationOwnerCapId,
    obligationId,
    USDC_COIN_TYPE,
    FLASH_LOAN_AMOUNT.toString(),
    tx
  );

  // --- Step 5: Repay Flash Loan ---
  // Use borrowedUSDC to repay.
  console.log("  Repaying Flash Loan...");
  await scallopTx.repayFlashLoan(borrowedUSDC, loanReceipt, "usdc");

  // 5. Execution
  console.log("Building Transaction...");
  const builtTx = await tx.build({ client: suiClient });
  console.log("Transaction Built Successfully.");

  // To execute:
  // const result = await suiClient.signAndExecuteTransaction({ signer: keypair, transaction: tx });
}

main().catch(console.error);
