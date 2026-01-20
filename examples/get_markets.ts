import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { DefiDashSDK } from "../src/index";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  // Address is optional for markets, but SDK init requires it.
  // We can just use a dummy address if no env is present, OR enforce env for consistency.
  // Let's try to load from env, fallback to dummy if missing (markets are public).
  let address =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

  const secretKey = process.env.SECRET_KEY;
  if (secretKey) {
    try {
      let keypair;
      if (secretKey.startsWith("suiprivkey")) {
        const decoded = decodeSuiPrivateKey(secretKey);
        keypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
      } else {
        // assume base64 if not suiprivkey, or fail
        keypair = Ed25519Keypair.fromSecretKey(
          Buffer.from(secretKey, "base64"),
        );
      }
      address = keypair.getPublicKey().toSuiAddress();
      console.log(`Using Wallet: ${address}`);
    } catch (e) {
      console.warn("Invalid SECRET_KEY, using dummy address for public data.");
    }
  } else {
    console.log(
      "No SECRET_KEY found. Using dummy address for public market data.",
    );
  }

  const client = new SuiClient({ url: getFullnodeUrl("mainnet") });

  const sdk = new DefiDashSDK();
  await sdk.initialize(client, address);

  console.log("\nFetching aggregated market data...");
  const markets = await sdk.getAggregatedMarkets();

  console.log("\n--- Market Data ---");
  for (const [protocol, assets] of Object.entries(markets)) {
    console.log(`\nProtocol: ${protocol}`);
    // Limit to top 5 to avoid spam
    console.table(
      assets.slice(0, 5).map((a) => ({
        Symbol: a.symbol,
        Price: `$${a.price.toFixed(4)}`,
        SupplyAPY: (a.supplyApy * 100).toFixed(2) + "%",
        BorrowAPY: (a.borrowApy * 100).toFixed(2) + "%",
      })),
    );
    if (assets.length > 5)
      console.log(`... and ${assets.length - 5} more assets.`);
  }
}

main().catch(console.error);
