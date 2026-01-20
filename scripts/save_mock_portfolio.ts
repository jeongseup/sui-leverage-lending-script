import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { DefiDashSDK } from "../src/index";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

async function main() {
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey) {
    console.error("❌ Error: SECRET_KEY not found in .env file.");
    return;
  }

  let keypair;
  try {
    if (secretKey.startsWith("suiprivkey")) {
      const decoded = decodeSuiPrivateKey(secretKey);
      keypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
    } else {
      keypair = Ed25519Keypair.fromSecretKey(Buffer.from(secretKey, "base64"));
    }
  } catch (e) {
    console.error("Failed to parse keypair");
    throw e;
  }

  const address = keypair.getPublicKey().toSuiAddress();
  console.log(`Using Wallet: ${address}`);

  const client = new SuiClient({ url: getFullnodeUrl("mainnet") });
  const sdk = new DefiDashSDK();
  await sdk.initialize(client, keypair);

  console.log(`\nFetching aggregated portfolio...\n`);

  const portfolios = await sdk.getAggregatedPortfolio();

  // Target path: ../frontend/src/data/mockPortfolio.json
  // Assuming this script is run from defi-dash-sdk root or scripts folder
  // We use absolute path based on CWD or resolve relative
  const targetDir = path.resolve(__dirname, "../../frontend/src/data");
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const targetFile = path.join(targetDir, "mockPortfolio.json");

  fs.writeFileSync(targetFile, JSON.stringify(portfolios, null, 2));
  console.log(`✅ Saved mock portfolio data to: ${targetFile}`);
}

main().catch(console.error);
