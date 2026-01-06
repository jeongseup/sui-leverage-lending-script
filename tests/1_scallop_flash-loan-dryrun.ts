import "dotenv/config";
import { Scallop } from "@scallop-io/sui-scallop-sdk";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";

async function testWithDryRun() {
  console.log("Initializing Dry Run Simulation...");

  // 1. 초기 설정
  // 1. Initial Setup
  const secretKey = process.env.SECRET_KEY;
  const SUI_FULLNODE_URL =
    process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.warn(
      "WARNING: Using placeholder key. Dry run might fail if address has no coins for gas validation."
    );
    return;
  }

  // Explicitly create SuiClient for Mainnet
  const client = new SuiClient({ url: SUI_FULLNODE_URL });

  let keypair;
  try {
    keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  } catch (e) {
    console.error("Error creating keypair:", e);
    return;
  }

  // 2. Initialize Scallop SDK
  const scallopSDK = new Scallop({
    secretKey: secretKey,
    networkType: "mainnet",
  });
  await scallopSDK.init();

  const builder = await scallopSDK.createScallopBuilder();
  const tx = builder.createTxBlock();

  // Sender 설정 (Gas Payment를 위해 필수)
  tx.setSender(keypair.getPublicKey().toSuiAddress());

  // 1. PTB 구성 (플래시 론 예시)
  const loanAmount = 1 * 10 ** 9; // 1 SUI
  const coinName = "sui";

  console.log(`Building PTB: Flash Loan ${loanAmount} Mist (${coinName})...`);

  const [loanCoin, receipt] = await tx.borrowFlashLoan(loanAmount, coinName);
  // 단순히 빌리고 바로 갚는 로직
  await tx.repayFlashLoan(loanCoin, receipt, coinName);

  // 2. 트랜잭션 바이트 빌드
  // Pass the explicitly created client which has all necessary methods (getNormalizedMoveFunction, etc.)
  const txBytes = await tx.build({ client });

  // 3. Dry Run 실행
  console.log("Simulating transaction (Dry Run)...");
  const dryRunResult = await client.dryRunTransactionBlock({
    transactionBlock: txBytes,
  });

  // 4. 결과 분석
  const {
    effects,
    balanceChanges,
    objectChanges,
    events,
    input,
    executionErrorSource,
    suggestedGasPrice,
  } = dryRunResult;

  const { status, gasUsed } = effects;

  console.log("\n--- Dry Run Results ---");
  console.log(`Status: ${status.status}`);
  if (status.error) {
    console.error(`Error: ${status.error}`);
  }
  if (executionErrorSource) {
    console.error(
      `Execution Error Source: ${JSON.stringify(executionErrorSource, null, 2)}`
    );
  }

  console.log(`Suggested Gas Price: ${suggestedGasPrice || "N/A"}`);

  if (status.status === "success") {
    console.log("✅ Simulation Success!");

    // 가스비 계산 (Computation + Storage - Rebate)
    const computationCost = BigInt(gasUsed.computationCost);
    const storageCost = BigInt(gasUsed.storageCost);
    const storageRebate = BigInt(gasUsed.storageRebate);
    const totalGas = computationCost + storageCost - storageRebate;

    console.log("\n--- Gas Estimate Details ---");
    console.log(`Computation Cost: ${computationCost} Mist`);
    console.log(`Storage Cost: ${storageCost} Mist`);
    console.log(`Storage Rebate: ${storageRebate} Mist`);
    console.log(`-------------------------------------------`);
    console.log(`Total Estimated Gas Fee: ${totalGas} Mist`);

    console.log("\n--- Transaction Input ---");
    console.log(`Sender: ${input.sender}`);
    console.log(`Gas Budget: ${input.gasData.budget} Mist`);
    console.log(`Gas Price: ${input.gasData.price} Mist`);

    // --- 상세 디버깅 로깅 ---
    console.log("\n--- Balance Changes (토큰 이동) ---");
    if (balanceChanges) {
      balanceChanges.forEach((change) => {
        console.log(`Owner: ${change.owner}`);
        console.log(`Coin: ${change.coinType}, Amount: ${change.amount}`);
      });
    }

    console.log("\n--- Object Changes (객체 변경) ---");
    if (objectChanges) {
      objectChanges.forEach((change) => {
        // Handle different change types
        if (change.type === "published") {
          console.log(`Type: ${change.type}, Package ID: ${change.packageId}`);
        } else if ("objectId" in change) {
          console.log(`Type: ${change.type}, Object ID: ${change.objectId}`);
        }
      });
    }

    console.log("\n--- Events Emitted (이벤트 발생) ---");
    if (events) {
      events.forEach((event) => {
        console.log(`Type: ${event.type}`);
        console.log(`Data:`, JSON.stringify(event.parsedJson, null, 2));
      });
    }
  } else {
    console.error("❌ Simulation Failed:", status.error);
    console.error(JSON.stringify(dryRunResult, null, 2));
  }
}

testWithDryRun();
