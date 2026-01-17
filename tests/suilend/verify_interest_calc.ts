import * as dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.public" });
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuilendClient } from "@suilend/sdk/client";
import { LENDING_MARKET_ID, LENDING_MARKET_TYPE } from "@suilend/sdk/client";
import { parseReserve } from "@suilend/sdk/parsers/reserve";
import { parseObligation } from "@suilend/sdk/parsers/obligation";
import { refreshReservePrice } from "@suilend/sdk/utils/simulate";
import { normalizeStructTag } from "@mysten/sui/utils";
import { CoinMetadata } from "@mysten/sui/client";
import BigNumber from "bignumber.js";

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

import { calculateCompoundedBorrow } from "../../src/lib/suilend";
import { WAD } from "@suilend/sdk/lib/constants";

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

async function main() {
  const userAddress = keypair.getPublicKey().toSuiAddress();
  console.log(`👤 User: ${userAddress}`);

  const suilendClient = await SuilendClient.initialize(
    LENDING_MARKET_ID,
    LENDING_MARKET_TYPE,
    client
  );

  const obligations = await SuilendClient.getObligationOwnerCaps(
    userAddress,
    suilendClient.lendingMarket.$typeArgs,
    client
  );

  if (obligations.length === 0) {
    console.log("❌ No obligation found.");
    return;
  }

  const obligationOwnerCap = obligations[0];
  const obligationId = obligationOwnerCap.obligationId;
  console.log(`📝 Obligation ID: ${obligationId}`);

  // Fetch Raw Obligation
  const obligation = await suilendClient.getObligation(obligationId);

  // Fetch and Refresh Reserves (to get Current Cumulative Rate)
  const reserves = suilendClient.lendingMarket.reserves;
  const refreshedReserves = await refreshReservePrice(
    reserves,
    suilendClient.pythConnection
  );

  // Parse Reserves and Metadata
  const parsedReserveMap: Record<string, any> = {};
  const coinMetadataMap: Record<string, CoinMetadata> = {};

  // 1. Collect all coin types first
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

  // 2. Fetch real metadata
  const uniqueCoinTypes = Array.from(allCoinTypes);
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

  // 3. Populate mocks for missing and Parse
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

  // Use SDK parseObligation to get the "Official" result
  const parsedObligation = parseObligation(obligation, parsedReserveMap);

  console.log("\n🔎 Comparing Manual Calculation vs SDK:");

  for (const borrow of obligation.borrows) {
    const coinType = normalizeStructTag(borrow.coinType.name);
    const reserve = refreshedReserves.find(
      (r) => normalizeStructTag(r.coinType.name) === coinType
    );

    if (!reserve) continue;

    const symbol = coinType.split("::").pop();
    console.log(`\n📌 Asset: ${symbol}`);

    // 1. Raw Data Extraction
    const rawBorrowAmnt = new BigNumber(borrow.borrowedAmount.value);
    const initRate = new BigNumber(borrow.cumulativeBorrowRate.value);
    const currentRate = new BigNumber(reserve.cumulativeBorrowRate.value);

    console.log(`   [Raw Data - WAD]`);
    console.log(`   - Raw Borrowed:   ${rawBorrowAmnt.toFixed()}`);
    console.log(`   - Initial Rate:   ${initRate.toFixed()}`);
    console.log(`   - Current Rate:   ${currentRate.toFixed()}`);

    // 2. Manual Calculation
    const calculatedWad = calculateCompoundedBorrow(
      rawBorrowAmnt,
      initRate,
      currentRate
    );

    // Convert WAD to Integer units (divide by 1e18)
    const calculatedInteger = calculatedWad.div(WAD);

    // 3. SDK Result
    const parsedBorrow = parsedObligation.borrows.find(
      (b) => b.coinType === coinType
    );

    if (!parsedBorrow) {
      console.log("   ❌ Could not find parsed borrow in SDK output");
      continue;
    }

    const meta = coinMetadataMap[coinType];
    const decimals = meta?.decimals || 9;

    // Explicitly log this to debug mismatched units
    console.log(`   - Decimals: ${decimals}`);

    const calculatedHuman = calculatedInteger.div(
      new BigNumber(10).pow(decimals)
    );

    console.log(`\n   [Comparison]`);
    console.log(`   - Manual Calc  (Human): ${calculatedHuman.toFixed(10)}`);
    // parsedBorrow.borrowedAmount is already formatted to human readable in Suilend SDK Parser
    console.log(
      `   - SDK Parsed   (Human): ${parsedBorrow.borrowedAmount.toFixed(10)}`
    );

    const diff = calculatedHuman.minus(parsedBorrow.borrowedAmount).abs();
    if (diff.lt(1e-9)) {
      console.log(`\n   ✅ MATCH! (Difference < 1e-9)`);
    } else {
      console.log(`\n   ⚠️ MISMATCH! Diff: ${diff.toFixed(10)}`);
    }
  }
}

main().catch(console.error);
