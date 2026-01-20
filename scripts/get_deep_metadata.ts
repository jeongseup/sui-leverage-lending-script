import { SuiClient } from "@mysten/sui/client";

const client = new SuiClient({ url: "https://fullnode.mainnet.sui.io:443" });

const DEEP_COIN_TYPE =
  "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP";

async function main() {
  console.log(`Fetching metadata for: ${DEEP_COIN_TYPE}`);
  const metadata = await client.getCoinMetadata({ coinType: DEEP_COIN_TYPE });
  console.log("Metadata:", metadata);
}

main().catch(console.error);
