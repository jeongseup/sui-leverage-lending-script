import * as dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.public" });
import fs from "fs";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { SuilendClient } from "@suilend/sdk/client";
import { LENDING_MARKET_ID, LENDING_MARKET_TYPE } from "@suilend/sdk/client";
import { parseReserve } from "@suilend/sdk/parsers/reserve";
import { parseObligation } from "@suilend/sdk/parsers/obligation";
import { refreshReservePrice } from "@suilend/sdk/utils/simulate";
import { CoinMetadata } from "@mysten/sui/client";
import { normalizeStructTag } from "@mysten/sui/utils";

// Setup
const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");
const secretKey = process.env.SECRET_KEY;

if (!secretKey) {
  console.error("Please set SECRET_KEY in .env");
  process.exit(1);
}

const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
const client = new SuiClient({ url: SUI_FULLNODE_URL });

// Helper to fix coin type format (ensure 0x prefix)
const formatCoinType = (type: string) => {
  if (!type.startsWith("0x") && !type.includes("::")) {
  }
  try {
    const normalized = normalizeStructTag(type);
    if (!normalized.startsWith("0x")) {
      return `0x${normalized}`;
    }
    return normalized;
  } catch (e) {
    if (type.includes("::") && !type.startsWith("0x")) {
      return `0x${type}`;
    }
    return type;
  }
};

// Helper to serialize BigInt for JSON.stringify
// BigInt cannot be natively serialized, so we convert to string
const jsonReplacer = (key: string, value: any) => {
  if (typeof value === "bigint") {
    return value.toString();
  }
  // Also handle BigNumber (bignumber.js) if necessary, usually it serializes to string/number well but let's be safe
  // If Suilend SDK returns specific objects we might want to simplify them
  return value;
};

async function main() {
  const userAddress = keypair.getPublicKey().toSuiAddress();
  console.log(`👤 User: ${userAddress}`);

  console.log("🔄 Connecting to Suilend...");
  const suilendClient = await SuilendClient.initialize(
    LENDING_MARKET_ID,
    LENDING_MARKET_TYPE,
    client
  );

  console.log("🔍 Fetching obligation...");
  const obligations = await SuilendClient.getObligationOwnerCaps(
    userAddress,
    suilendClient.lendingMarket.$typeArgs,
    client
  );

  if (obligations.length === 0) {
    console.log("❌ No obligation found for this account.");
    return;
  }

  const obligationOwnerCap = obligations[0];
  const obligationId = obligationOwnerCap.obligationId;
  console.log(`📝 Obligation ID: ${obligationId}`);

  // Refresh Obligation
  // const tx = new Transaction();
  // try {
  //   const ob = await suilendClient.getObligation(obligationId);
  //   await suilendClient.refreshAll(tx, ob);
  // } catch (e) {
  //   console.warn("Refresh warning:", e);
  // }

  const obligation = await suilendClient.getObligation(obligationId);
  const rawFilename = "obligation_raw.json";
  fs.writeFileSync(rawFilename, JSON.stringify(obligation));
  console.log(`\n✅ Obligation data saved to ${rawFilename}`);
  // Fetch and Parse Reserves
  console.log("📊 Fetching and parsing reserves...");
  const reserves = suilendClient.lendingMarket.reserves;

  const refreshedReserves = await refreshReservePrice(
    reserves,
    suilendClient.pythConnection
  );

  // Collect Coin Types for Metadata
  const allCoinTypes = new Set<string>();
  refreshedReserves.forEach((r) => {
    allCoinTypes.add(r.coinType.name as string);
    r.depositsPoolRewardManager.poolRewards.forEach((pr) => {
      if (pr) allCoinTypes.add(pr.coinType.name as string);
    });
    r.borrowsPoolRewardManager.poolRewards.forEach((pr) => {
      if (pr) allCoinTypes.add(pr.coinType.name as string);
    });
  });

  const uniqueCoinTypes = Array.from(allCoinTypes);
  const coinMetadataMap: Record<string, CoinMetadata> = {};

  await Promise.all(
    uniqueCoinTypes.map(async (ct) => {
      try {
        const fixedType = formatCoinType(ct);
        const metadata = await client.getCoinMetadata({ coinType: fixedType });
        if (metadata) {
          coinMetadataMap[normalizeStructTag(ct)] = metadata;
        }
      } catch (e) {
        console.warn(`⚠️ Failed to fetch metadata for ${ct}. Continuing...`);
      }
    })
  );

  const parsedReserveMap: Record<string, any> = {};
  refreshedReserves.forEach((r) => {
    [
      r.coinType.name,
      ...r.depositsPoolRewardManager.poolRewards.map((pr) => pr?.coinType.name),
      ...r.borrowsPoolRewardManager.poolRewards.map((pr) => pr?.coinType.name),
    ]
      .filter(Boolean)
      .forEach((rawType) => {
        const ct = normalizeStructTag(rawType as string);
        if (!coinMetadataMap[ct]) {
          const parts = rawType!.split("::");
          const symbol = parts.length > 2 ? parts[2] : "UNKNOWN";
          coinMetadataMap[ct] = {
            decimals: 9,
            name: rawType!,
            symbol: symbol,
            description: "Mocked Metadata",
            iconUrl: "",
            id: "",
          } as CoinMetadata;
        }
      });

    const parsed = parseReserve(r, coinMetadataMap);
    parsedReserveMap[parsed.coinType] = parsed;
  });

  const parsedObligation = parseObligation(obligation, parsedReserveMap);

  // Clean up circular references if any (usually reserves might reference something)
  // But standard JSON.stringify with a replacer handling BigInt should suffice for these data structures

  const output = {
    userAddress,
    obligationId,
    rawObligation: obligation,
    parsedObligation: parsedObligation,
    timestamp: new Date().toISOString(),
  };

  const filename = "obligation_dump.json";
  fs.writeFileSync(filename, JSON.stringify(output, jsonReplacer, 2));
  console.log(`\n✅ Obligation data saved to ${filename}`);
}

main().catch(console.error);
