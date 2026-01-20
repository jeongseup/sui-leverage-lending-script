import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { DefiDashSDK } from "../src/index";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey) {
    console.error("❌ Error: SECRET_KEY not found in .env file.");
    console.log(
      "Please create a .env file with SECRET_KEY=your_suiprivkey_...",
    );
    return;
  }

  // Handle both suiprivkey... and raw 32-byte hex/base64 if needed, but SDK usually expects suiprivkey or raw bytes
  let keypair;
  try {
    if (secretKey.startsWith("suiprivkey")) {
      const decoded = decodeSuiPrivateKey(secretKey);
      keypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
    } else {
      // Fallback for raw
      keypair = Ed25519Keypair.fromSecretKey(Buffer.from(secretKey, "base64")); // Simplified assumption or let user handle it
      // Actually, let's assume suiprivkey standard or standard Ed25519 keypair construction
    }
  } catch (e) {
    console.error(
      "Failed to parse keypair. Ensure SECRET_KEY is valid suiprivkey or compatible format.",
    );
    throw e;
  }

  const address = keypair.getPublicKey().toSuiAddress();
  console.log(`Using Wallet: ${address}`);

  const client = new SuiClient({ url: getFullnodeUrl("mainnet") });
  const sdk = new DefiDashSDK();
  // We can pass keypair directly to initialize if we want to enable signing,
  // but for queries, address string is enough.
  // Let's pass keypair to show full capability.
  await sdk.initialize(client, keypair);

  console.log(`\nFetching aggregated portfolio...\n`);

  const portfolios = await sdk.getAggregatedPortfolio();

  console.log("--- Aggregated Portfolio ---");
  for (const p of portfolios) {
    if (p.protocol === "navi") continue; // Skip Navi for now as requested
    console.log(`\nProtocol: ${p.protocol}`);
    console.log(`Health Factor: ${p.healthFactor}`);
    console.log(`Net Value: $${p.netValueUsd.toFixed(2)}`);
    console.log(`Deposited (Supply): $${p.totalDepositedUsd?.toFixed(2)}`);
    console.log(`Debt (Actual): $${p.totalDebtUsd.toFixed(2)}`);
    console.log(`Weighted Borrows: $${p.weightedBorrowsUsd?.toFixed(2)}`);
    console.log(`Borrow Limit: $${p.borrowLimitUsd?.toFixed(2)}`);
    console.log(`Liq Threshold: $${p.liquidationThresholdUsd?.toFixed(2)}`);

    if (p.netApy !== undefined) {
      console.log(`Net APY (Equity): ${p.netApy.toFixed(2)}%`);
      console.log(
        `Annual Net Earnings: $${p.totalAnnualNetEarningsUsd?.toFixed(2)}`,
      );
    }

    if (p.positions.length > 0) {
      console.table(
        p.positions.map((pos) => ({
          Symbol: pos.symbol,
          Side: pos.side,
          Amount: pos.amount,
          // AmountRaw: pos.amountRaw,
          ValueUSD: pos.valueUsd.toFixed(2),
          APY: (pos.apy * 100).toFixed(2) + "%",
          Rewards:
            pos.rewards
              ?.map((r) => `${r.amount.toFixed(6)} ${r.symbol}`)
              .join(", ") || "",
          EstLiq: pos.estimatedLiquidationPrice
            ? `$${pos.estimatedLiquidationPrice.toFixed(2)}`
            : "-",
        })),
      );
    } else {
      console.log("No active positions.");
    }
  }
}

main().catch(console.error);
