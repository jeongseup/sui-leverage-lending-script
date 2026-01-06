import "dotenv/config";
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { MetaAg } from "@7kprotocol/sdk-ts";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");
const client = new SuiClient({ url: SUI_FULLNODE_URL });

async function main() {
  console.log("--- 7k-SDK Token Swap Script ---");

  // 1. Setup User Address
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error("Error: SECRET_KEY not found in .env file.");
    return;
  }

  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  const userAddress = keypair.getPublicKey().toSuiAddress();
  console.log(`Using Wallet Address: ${userAddress}`);

  // 2. Initialize 7k-SDK
  const metaAg = new MetaAg({
    partner:
      "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf",
    partnerCommissionBps: 100, // 1% commission
  });

  // 3. Swap Parameters
  const coinTypeIn =
    process.env.INPUT_COIN_TYPE ||
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
  const coinTypeOut = process.env.OUTPUT_COIN_TYPE || "0x2::sui::SUI";
  const amountIn = process.env.SWAP_AMOUNT || "100000";

  console.log(`\nSwapping ${amountIn} units of:`);
  console.log(`- From: ${coinTypeIn}`);
  console.log(`- To: ${coinTypeOut}`);

  try {
    // 4. Get Quotes
    console.log("\nFetching quotes...");
    const quotes = await metaAg.quote(
      {
        amountIn: amountIn,
        coinTypeIn: coinTypeIn,
        coinTypeOut: coinTypeOut,
      },
      { sender: userAddress }
    );

    if (quotes.length === 0) {
      throw new Error("No quotes found for the specified pair.");
    }

    // Sort by best simulated output
    const quote = quotes.sort(
      (a, b) =>
        Number(b.simulatedAmountOut || b.amountOut) -
        Number(a.simulatedAmountOut || a.amountOut)
    )[0];

    console.log(
      `Best Quote found: ${quote.simulatedAmountOut || quote.amountOut} units.`
    );

    // 5. Build Swap Transaction
    const tx = new Transaction();
    const coinOut = await metaAg.swap(
      {
        quote,
        signer: userAddress,
        coinIn: coinWithBalance({
          balance: BigInt(amountIn),
          type: coinTypeIn,
        }),
        tx,
      },
      100 // 1% slippage
    );

    tx.transferObjects([coinOut], userAddress);

    // 6. Dry Run / Inspect
    console.log("\nExecuting dry-run (inspect)...");
    const res = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: userAddress,
    });

    if (res.effects.status.status === "failure") {
      console.error("Dry-run failed:", res.effects.status.error);
    } else {
      console.log("Dry-run successful!");

      // 7. Actually Send Transaction (Commented out by default for safety in test script)
      /*
      console.log("\nSending real transaction...");
      const result = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        options: { showEffects: true },
      });
      console.log("Swap successful! Transaction Digest:", result.digest);
      */
    }

    console.log("\nDone!");
  } catch (error: any) {
    console.error("\nERROR:", error.message || error);
  }
}

main();
