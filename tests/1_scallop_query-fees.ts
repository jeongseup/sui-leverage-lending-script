import "dotenv/config";
import { Scallop } from "@scallop-io/sui-scallop-sdk";

async function queryFees() {
  console.log("Querying Flash Loan Fees...");

  const secretKey = process.env.SECRET_KEY;

  try {
    const scallopSDK = new Scallop({
      secretKey: secretKey,
      networkType: "mainnet",
    });

    await scallopSDK.init();
    const query = await scallopSDK.createScallopQuery();
    const fees = await query.getFlashLoanFees();

    console.log("Flash Loan Fees:", JSON.stringify(fees, null, 2));

    // Formatting nicely for console
    console.log("\n--- Formatted Fees ---");
    Object.entries(fees).forEach(([coin, fee]) => {
      console.log(
        `${coin.toUpperCase()}: ${((fee as number) * 100).toFixed(4)}%`
      );
    });
  } catch (error) {
    console.error("Failed to query fees:", error);
  }
}

queryFees();
