import * as dotenv from "dotenv";
dotenv.config(); // Load SECRET_KEY from .env
dotenv.config({ path: ".env.public" }); // Load other configs from .env.public
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import { getReserveByCoinType } from "../../src/lib/suilend/const";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");
const client = new SuiClient({ url: SUI_FULLNODE_URL });

function normalizeCoinType(coinType: string) {
  const parts = coinType.split("::");
  if (parts.length !== 3) return coinType;
  let pkg = parts[0].replace("0x", "");
  pkg = pkg.padStart(64, "0");
  return `0x${pkg}::${parts[1]}::${parts[2]}`;
}

function formatUnits(
  amount: string | number | bigint,
  decimals: number
): string {
  const s = amount.toString();
  if (decimals === 0) return s;
  const pad = s.padStart(decimals + 1, "0");
  const transition = pad.length - decimals;
  return (
    `${pad.slice(0, transition)}.${pad.slice(transition)}`.replace(
      /\.?0+$/,
      ""
    ) || "0"
  );
}

async function main() {
  console.log("─".repeat(50));
  console.log("  🔄 7k Swap Script (Dry Run)");
  console.log("─".repeat(50));

  // 1. Setup
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error("❌ Error: SECRET_KEY not found in .env file.");
    return;
  }

  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  const userAddress = keypair.getPublicKey().toSuiAddress();
  console.log(`\n👤 Wallet: ${userAddress}`);

  // 2. Initialize 7k-SDK
  const metaAg = new MetaAg({
    partner:
      "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf",
  });

  // 3. Swap Parameters from .env.public
  const coinTypeIn =
    process.env.SWAP_INPUT_COIN_TYPE ||
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
  const coinTypeOut =
    process.env.SWAP_OUTPUT_COIN_TYPE ||
    "0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC";
  const amountIn = process.env.SWAP_AMOUNT || "500000";

  // Get asset info from const.ts
  const normalizedIn = normalizeCoinType(coinTypeIn);
  const normalizedOut = normalizeCoinType(coinTypeOut);
  const reserveIn = getReserveByCoinType(normalizedIn);
  const reserveOut = getReserveByCoinType(normalizedOut);

  const decimalsIn = reserveIn?.decimals ?? 6;
  const decimalsOut = reserveOut?.decimals ?? 8;
  const symbolIn = reserveIn?.symbol ?? "USDC";
  const symbolOut = reserveOut?.symbol ?? "LBTC";

  // Get prices
  const priceIn = await getTokenPrice(normalizedIn);
  const priceOut = await getTokenPrice(normalizedOut);
  const humanAmountIn = Number(amountIn) / Math.pow(10, decimalsIn);
  const usdValueIn = humanAmountIn * priceIn;

  console.log(`\n📊 Swap Info:`);
  console.log(`─`.repeat(45));
  console.log(
    `  From:        ${formatUnits(
      amountIn,
      decimalsIn
    )} ${symbolIn} (Raw: ${amountIn})`
  );
  console.log(`  To:          ${symbolOut}`);
  console.log(`  ${symbolIn} Price:   $${priceIn.toFixed(4)}`);
  console.log(`  ${symbolOut} Price:  $${priceOut.toLocaleString()}`);
  console.log(`  USD Value:   ~$${usdValueIn.toFixed(2)}`);
  console.log(`─`.repeat(45));

  try {
    // 4. Get Quotes
    console.log(`\n🔍 Fetching quotes...`);
    const quotes = await metaAg.quote(
      { amountIn, coinTypeIn, coinTypeOut },
      { sender: userAddress }
    );

    if (quotes.length === 0) {
      throw new Error("No quotes found for the specified pair.");
    }

    const quote = quotes.sort(
      (a, b) =>
        Number(b.simulatedAmountOut || b.amountOut) -
        Number(a.simulatedAmountOut || a.amountOut)
    )[0];

    const rawOut = quote.simulatedAmountOut || quote.amountOut;
    const humanOut = Number(rawOut) / Math.pow(10, decimalsOut);
    const usdValueOut = humanOut * priceOut;

    console.log(`\n📈 Best Quote:`);
    console.log(`─`.repeat(45));
    console.log(
      `  Output:      ${formatUnits(
        rawOut,
        decimalsOut
      )} ${symbolOut} (Raw: ${rawOut})`
    );
    console.log(`  USD Value:   ~$${usdValueOut.toFixed(2)}`);
    console.log(`─`.repeat(45));

    // 5. Build Swap Transaction
    const tx = new Transaction();
    const coinOut = await metaAg.swap(
      {
        quote,
        signer: userAddress,
        coinIn: coinWithBalance({
          balance: BigInt(amountIn),
          type: coinTypeIn,
        }),
        tx,
      },
      100 // 1% slippage
    );
    tx.transferObjects([coinOut], userAddress);

    // 6. Dry Run
    console.log(`\n🧪 Running dry-run...`);
    const res = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: userAddress,
    });

    if (res.effects.status.status === "failure") {
      console.error(`❌ Dry-run failed:`, res.effects.status.error);
    } else {
      console.log(`✅ Dry-run successful!`);
      console.log(`\n💡 To execute real swap, use: npm run test:swap-exec`);
    }

    console.log(`\n` + "─".repeat(50));
    console.log(`  ✨ Done!`);
    console.log("─".repeat(50));
  } catch (error: any) {
    console.error(`\n❌ ERROR: ${error.message || error}`);
  }
}

main();
