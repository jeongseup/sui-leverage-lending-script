import * as dotenv from "dotenv";
dotenv.config(); // Load SECRET_KEY from .env
dotenv.config({ path: ".env.public" }); // Load other configs from .env.public
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";

// Flash loan fees are stored in a separate on-chain table
const FLASHLOAN_FEES_TABLE_ID =
  "0x00481a93b819d744a7d79ecdc6c62c74f2f7cb4779316c4df640415817ac61bb";

// Fee rate denominator (from SDK)
const FEE_RATE = 10000;

// Coin type to name mapping
const COIN_TYPE_TO_NAME: Record<string, string> = {
  "0x2::sui::SUI": "sui",
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC":
    "usdc",
  "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN":
    "wusdc",
  "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN":
    "wusdt",
  "0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN":
    "weth",
  "0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN":
    "wbtc",
  "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS":
    "cetus",
  "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI":
    "afsui",
  "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI":
    "hasui",
  "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT":
    "vsui",
  "0x7016aae72cfc67f2fadf55769c0a7dd54291a583b63051a5ed71081cce836ac6::sca::SCA":
    "sca",
};

async function queryFlashLoanFees() {
  console.log("Querying Flash Loan Fees from On-Chain Table...\n");
  console.log("Flash Loan Fees Table ID:", FLASHLOAN_FEES_TABLE_ID);

  const client = new SuiClient({
    url: process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet"),
  });

  try {
    const fees: Record<string, number> = {};

    // Query all dynamic fields from the flash loan fees table
    let cursor: string | null | undefined = null;
    let hasNextPage = false;

    do {
      const resp = await client.getDynamicFields({
        parentId: FLASHLOAN_FEES_TABLE_ID,
        limit: 50,
        cursor,
      });

      console.log(`\nFetched ${resp.data.length} fields...`);

      // Get the dynamic field objects
      for (const field of resp.data) {
        const fieldObject = await client.getDynamicFieldObject({
          parentId: FLASHLOAN_FEES_TABLE_ID,
          name: field.name,
        });

        if (fieldObject.data?.content?.dataType === "moveObject") {
          const fields = (fieldObject.data.content as any).fields;
          // Extract coin type from name.fields.name
          const coinTypeName = fields?.name?.fields?.name;
          const feeNumerator = Number(fields?.value || 0);

          if (coinTypeName) {
            const fullCoinType = `0x${coinTypeName}`;
            const coinName = COIN_TYPE_TO_NAME[fullCoinType] || coinTypeName;
            const feePercent = feeNumerator / FEE_RATE;
            fees[coinName] = feePercent;
          }
        }
      }

      hasNextPage = resp.hasNextPage;
      cursor = resp.nextCursor;
    } while (hasNextPage);

    console.log("\n=== Flash Loan Fees ===");
    Object.entries(fees)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([coin, fee]) => {
        console.log(
          `${coin.toUpperCase().padEnd(10)}: ${(fee * 100).toFixed(4)}%`
        );
      });

    // Return for use in other modules
    return fees;
  } catch (error) {
    console.error("Failed to query fees:", error);
    return {};
  }
}

queryFlashLoanFees();

export { queryFlashLoanFees, FLASHLOAN_FEES_TABLE_ID };
