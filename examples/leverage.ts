/**
 * DefiDash SDK - Leverage Test
 *
 * Tests the SDK leverage functionality
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
  logLeverageParams,
  logLeveragePreview,
  logStrategyResult,
} from "../src/lib/utils/logger";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

async function main() {
  logHeader("🧪 DefiDash SDK - Leverage Test");

  // Setup
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error("❌ Error: SECRET_KEY not found in .env.test file.");
    return;
  }

  const txMode = process.env.TX_MODE || "dryrun";
  const dryRun = txMode === "dryrun";
  if (!dryRun) {
    console.log(
      "\n   ⚠️ EXECUTION MODE - Real transactions will be submitted!",
    );
  }

  const suiClient = new SuiClient({ url: SUI_FULLNODE_URL });
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  logWallet(keypair.getPublicKey().toSuiAddress());

  // Initialize SDK
  const sdk = new DefiDashSDK();
  await sdk.initialize(suiClient, keypair);
  logSDKInit(true);

  // Config
  const depositAsset = process.env.LEVERAGE_DEPOSIT_COIN_TYPE || "LBTC";
  const depositAmount = process.env.LEVERAGE_DEPOSIT_AMOUNT
    ? (Number(process.env.LEVERAGE_DEPOSIT_AMOUNT) / 1e8).toString()
    : "0.00001";
  const multiplier = parseFloat(process.env.LEVERAGE_MULTIPLIER || "1.5");
  const protocol =
    process.env.LEVERAGE_PROTOCOL === "navi"
      ? LendingProtocol.Navi
      : LendingProtocol.Suilend;

  // Check position
  const position = await sdk.getPosition(protocol);
  logPosition(position, protocol);

  // Preview
  logLeverageParams({ protocol, depositAsset, depositAmount, multiplier });

  try {
    const preview = await sdk.previewLeverage({
      depositAsset,
      depositAmount,
      multiplier,
    });
    logLeveragePreview(preview);
  } catch (error: any) {
    console.error(`   ⚠️ Preview error: ${error.message}`);
  }

  // Execute
  const result = await sdk.leverage({
    protocol,
    depositAsset,
    depositAmount,
    multiplier,
    dryRun,
  });
  logStrategyResult(result, "leverage", dryRun);

  logFooter("Test complete!");
}

main().catch(console.error);
