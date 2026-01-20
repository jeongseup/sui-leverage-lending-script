import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { DefiDashSDK, LendingProtocol } from "../src/index";
import * as dotenv from "dotenv";
import { COIN_TYPES } from "../src/lib/suilend/const";

dotenv.config();

const SUI_COIN = "0x2::sui::SUI";

async function main() {
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey) {
    console.error("❌ Error: SECRET_KEY not found in .env file.");
    return;
  }

  let keypair;
  if (secretKey.startsWith("suiprivkey")) {
    const decoded = decodeSuiPrivateKey(secretKey);
    keypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
  } else {
    keypair = Ed25519Keypair.fromSecretKey(Buffer.from(secretKey, "base64"));
  }
  const address = keypair.getPublicKey().toSuiAddress();
  console.log(`Using Wallet: ${address}`);

  const client = new SuiClient({ url: getFullnodeUrl("mainnet") });
  const sdk = new DefiDashSDK();
  await sdk.initialize(client, keypair);

  console.log(`\nChecking limits for ${address} on Suilend...\n`);

  // 1. Max Borrow
  const maxBorrowSui = await sdk.getMaxBorrowable(
    LendingProtocol.Suilend,
    SUI_COIN,
  );
  const maxBorrowUsdc = await sdk.getMaxBorrowable(
    LendingProtocol.Suilend,
    COIN_TYPES.USDC,
  );

  // 2. Max Withdraw
  const maxWithdrawSui = await sdk.getMaxWithdrawable(
    LendingProtocol.Suilend,
    SUI_COIN,
  );
  const maxWithdrawUsdc = await sdk.getMaxWithdrawable(
    LendingProtocol.Suilend,
    COIN_TYPES.USDC,
  );

  console.log("--- Suilend Limits ---");
  console.log(`Max Borrow SUI: ${maxBorrowSui}`);
  console.log(`Max Borrow USDC: ${maxBorrowUsdc}`);
  console.log(`Max Withdraw SUI: ${maxWithdrawSui}`);
  console.log(`Max Withdraw USDC: ${maxWithdrawUsdc}`);
}

main().catch(console.error);
