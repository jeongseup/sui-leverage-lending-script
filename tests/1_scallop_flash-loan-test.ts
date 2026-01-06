import "dotenv/config";

import { Scallop } from "@scallop-io/sui-scallop-sdk";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getFullnodeUrl } from "@mysten/sui/client";

async function testSimpleFlashLoan() {
  // 1. Initial Setup
  const secretKey = process.env.SECRET_KEY;
  const SUI_FULLNODE_URL =
    process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error(
      "Please provide a valid SECRET_KEY in the script or environment variable."
    );
    return;
  }

  let keypair;
  try {
    keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  } catch (e) {
    console.error("Error creating keypair:", e);
    return;
  }

  const sender = keypair.getPublicKey().toSuiAddress();
  console.log("Sender Address:", sender);

  // 2. Initialize Scallop SDK
  const scallopSDK = new Scallop({
    secretKey: secretKey,
    networkType: "mainnet",
  });
  await scallopSDK.init();

  const builder = await scallopSDK.createScallopBuilder();
  const tx = builder.createTxBlock();

  // 3. 테스트 파라미터 설정
  // const sender = keypair.getPublicKey().toSuiAddress();
  tx.setSender(sender);
  const loanAmount = 1 * 10 ** 9; // 1 SUI (Mist 단위)
  const coinName = "sui"; // 테스트할 코인 이름

  console.log(`Testing Flash Loan for ${loanAmount} Mist...`);

  try {
    // 4. [Step 1] 플래시 론 빌리기
    // 반환값: [빌린 코인 객체, 갚을 때 필요한 영수증 객체]
    const [loanCoin, receipt] = await tx.borrowFlashLoan(loanAmount, coinName);

    /**
     * [이 지점에 나중에 스왑(Swap)이나 레버리지 로직이 들어갑니다]
     * 현재는 단순 테스트를 위해 빌린 코인을 그대로 다시 갚습니다.
     *
     */

    // 5. [Step 2] 플래시 론 갚기
    // 빌린 코인과 영수증을 함께 반납하여 "Hot Potato"를 해소합니다.
    await tx.repayFlashLoan(loanCoin, receipt, coinName);

    // 6. 트랜잭션 전송 및 실행
    const result = await builder.signAndSendTxBlock(tx);
    console.log("Flash Loan Success! Transaction Digest:", result.digest);
  } catch (error) {
    console.error("Flash Loan Failed:", error);
  }
}

testSimpleFlashLoan().catch((err) => {
  console.error("Unhandle error in testSimpleFlashLoan:", err);
});
