# Suilend Liquidation Process

This document explains the liquidation process in Suilend, detailed from both the perspective of the user (how you get liquidated) and the liquidator (how they execute it).

## 1. When do you get Liquidated?

You are eligible for liquidation when your **Health Factor** drops below **1.0**.

- **Liquidation Threshold**: Each asset you deposit has a "Close LTV" (e.g., 80% for SUI). This determines the maximum value of debt you can hold against it before risking liquidation.
- **Weighted Borrows**: Your debt is also weighted. Some assets might count more heavily against your limit.

**Condition:**
$$ \text{Weighted Borrows} > \text{Total Liquidation Threshold (Collateral Value} \times \text{Close LTV)} $$

## 2. What happens during Liquidation?

Suilend uses a **Partial Liquidation** model to prevent total loss of user funds during minor market dips.

### Key Parameters

- **Close Factor (20%)**: Liquidators can only repay up to **20%** of your outstanding debt in a single transaction. This means you are not wiped out instantly; instead, your position is "deleverage" step-by-step until it is healthy again.
- **Liquidation Bonus (5%)**: To incentivize liquidators, they receive a **5% bonus** in the form of your collateral. This implies you lose 5% value on the amount liquidated.

### The Flow

1.  **Trigger**: Your account becomes unhealthy (Health < 1.0).
2.  **Action**: A liquidator bot detects this and calls the `liquidate` function.
3.  **Repayment**: The liquidator pays back a portion of your debt (e.g., pays back 20% of your USDC loan).
4.  **Seizure**: The protocol takes an equivalent value of your collateral **PLUS the 5% bonus** and gives it to the liquidator.
5.  **Result**: Your debt decreases, but your collateral decreases by a slightly larger percentage (due to the bonus). However, since debt is removed, your Health Factor usually improves.

## 3. The Liquidator Bot (`liquidator.ts`)

The reference liquidator bot (`liquidator.ts`) works as follows:

### A. Monitoring (`updatePositions`)

- **Polls Obligations**: Constantly fetches all user obligations from the chain.
- **Refreshes Prices**: Updates oracle prices to get the latest values.
- **Checks Health**: Calculates the fresh Health Factor using `refreshObligation`.
- **Enqueues**: If an obligation is unhealthy, it adds it to a Redis queue for processing.

### B. Execution (`LiquidationWorker`)

- **Selects Debt to Repay**: It looks for the largest debt or specifically USDC to repay.
- **Selects Collateral to Seize**: It chooses which collateral to claim (usually the one with the most value).
- **Swaps (if needed)**: If the liquidator holds USDC but needs to repay SUI, it performs a swap logic (though usually, they repay generic assets).
- **Transaction**: Calls `suilendClient.liquidateAndRedeem`.
  - **Inputs**: `obligation`, `repayCoinType`, `withdrawCoinType`.
  - **Logic**: It instructs the contract to repay the debt using the liquidator's funds and withdraw the seized collateral to the liquidator's wallet.

### Code Reference

- **Close Factor**: Defined as `const LIQUIDATION_CLOSE_FACTOR = 0.2;` in `liquidator.ts`.
- **Trigger**: `if (shouldAttemptLiquidations(refreshedObligation))` checks if `unhealthyBorrowValueUsd < weightedBorrowsUsd`.

## 4. How to Avoid Liquidation?

1.  **Monitor Health Factor**: Keep it well above 1.0 (e.g., > 1.2 is safer).
2.  **Repay Debt**: If market drops, repay some loans to reduce Weighted Borrows.
3.  **Deposit Collateral**: Add more collateral to increase your Liquidation Threshold.
4.  **Watch "Close LTV"**: Be aware that different assets have different risk parameters.
