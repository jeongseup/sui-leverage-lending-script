/**
 * DefiDash SDK - Deleverage Test
 *
 * Tests the SDK deleverage functionality
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { DefiDashSDK, LendingProtocol } from "../src";
import {
  logHeader,
  logFooter,
  logWallet,
  logSDKInit,
  logPosition,
  logStrategyResult,
} from "../src/lib/utils/logger";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

async function main() {
  logHeader("🧪 DefiDash SDK - Deleverage Test");

  // Setup
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error("❌ Error: SECRET_KEY not found in .env.test file.");
    return;
  }

  const txMode = process.env.TX_MODE || "dryrun";
  const dryRun = txMode === "dryrun";
  if (!dryRun) {
    console.log("\n   ⚠️ Dry run mode disabled");
  }

  const suiClient = new SuiClient({ url: SUI_FULLNODE_URL });
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  logWallet(keypair.getPublicKey().toSuiAddress());

  // Initialize SDK
  const sdk = new DefiDashSDK();
  await sdk.initialize(suiClient, keypair);
  logSDKInit(true);

  // Config
  const protocol =
    process.env.LEVERAGE_PROTOCOL === "navi"
      ? LendingProtocol.Navi
      : LendingProtocol.Suilend;

  // Check position
  const position = await sdk.getPosition(protocol);
  logPosition(position, protocol);

  if (!position) {
    console.log("   Run the leverage test first");
    return;
  }

  if (position.debt.amount === 0n) {
    console.log("\n   ⚠️ No debt to repay - use withdraw instead");
    return;
  }

  // Execute
  const result = await sdk.deleverage({
    protocol,
    dryRun,
  });
  logStrategyResult(result, "deleverage", dryRun);

  logFooter("Test complete!");
}

main().catch(console.error);
