# Suilend Liquidation & Metrics Mechanics

This document outlines how key metrics (Liquidation Price, Rates, Health Factor, Looping) are calculated in the Suilend protocol, based on analysis of the `@suilend/sdk` source code.

## 1. SDK Source Code Map

We rely on the official SDK logic to ensure our calculations match the on-chain reality. Below is the mapping of where we found specific formulas and logic.

| Metric / Concept          | Source File (in `@suilend/sdk`)      | Function / Logic                                                                                       |
| :------------------------ | :----------------------------------- | :----------------------------------------------------------------------------------------------------- |
| **Health Factor**         | `parsers/obligation.ts`              | The ratio of `unhealthyBorrowValueUsd` to `weightedBorrowsUsd`.                                        |
| **Liquidation Price**     | Derived from `parsers/obligation.ts` | Logic reverse-engineered from how `unhealthyBorrowValueUsd` is calculated (Amount _ Price _ CloseLTV). |
| **Borrow APR**            | `utils/simulate.ts`                  | `calculateBorrowAprPercent(reserve)`: Interpolates interest rate curve based on utilization.           |
| **Supply APR**            | `utils/simulate.ts`                  | `calculateDepositAprPercent(reserve)`: `BorrowAPR * Utilization * (1 - SpreadFee)`.                    |
| **Weighted Borrows**      | `parsers/obligation.ts`              | `weightedBorrowsUsd`: Sum of (Amount _ Price _ BorrowWeight).                                          |
| **Liquidation Threshold** | `parsers/obligation.ts`              | `unhealthyBorrowValueUsd`: Sum of (Deposit _ Price _ CloseLTV).                                        |
| **Utilization Rate**      | `utils/simulate.ts`                  | `calculateUtilizationPercent(reserve)`: `(Borrows / Deposits) * 100`.                                  |
| **Price Data**            | `parsers/reserve.ts`                 | `parseReserve`: Parses raw `PriceIdentifier` and scales raw price values.                              |

### Why use `parseObligation`?

We use `parseObligation` (from `parsers/obligation.ts`) instead of manually calculating values because:

1.  **Complexity**: It handles the iteration over all deposits and borrows, applying the correct decimal scaling (10^18 for WAD, token decimals, etc.).
2.  **Accuracy**: It applies the correct **Borrow Weights** and **Close LTV** factors for every asset, which are critical for the Health Factor.
3.  **Maintenance**: If Suilend changes their formula (e.g., adds a new fee or weight), the SDK update will handle it.

---

## 2. Liquidation Mechanics

Liquidation in Suilend is determined by comparing the **Weighted Borrows** against the **Unhealthy Borrow Value** (Liquidation Threshold).

### Core Formulas

- **Weighted Borrows USD (`weightedBorrowsUsd`)**:
  The sum of all borrowed assets' values, adjusted by their borrow weights.
  $$ \text{WeightedBorrows} = \sum (\text{BorrowAmount}\_i \times \text{Price}\_i \times \text{BorrowWeight}\_i) $$

- **Unhealthy Borrow Value USD (`unhealthyBorrowValueUsd`)**:
  The sum of all deposited assets' values, discounted by their liquidation threshold (Close LTV).
  $$ \text{UnhealthyBorrowlimit} = \sum (\text{DepositAmount}\_j \times \text{Price}\_j \times \text{CloseLTV}\_j) $$

- **Liquidation Condition**:
  If $\text{WeightedBorrows} > \text{UnhealthyBorrowLimit}$, the obligation is eligible for liquidation.

### Liquidation Price Calculation

For a simplified scenario with a single Collateral (C) and single Debt (D):

$$
\text{Debt} \times \text{Price}_D \times \text{Weight}_D > \text{Collateral} \times \text{Price}_C \times \text{CloseLTV}_C
$$

$$
\text{Liquidation Price}_C = \frac{\text{Debt} \times \text{Price}_D \times \text{Weight}_D}{\text{Collateral} \times \text{CloseLTV}_C}
$$

If multiple assets are involved, this becomes an approximation or requires solving for the specific asset's price while holding others constant.

## 3. Health Factor

The Health Factor (HF) is a ratio indicating safety against liquidation.

$$ \text{Health Factor} = \frac{\text{UnhealthyBorrowLimit}}{\text{WeightedBorrows}} $$

- **HF > 1**: Safe.
- **HF < 1**: Liquidatable.
- **HF < 1.05**: Dangerous (close to liquidation).

## 4. Lending & Borrow Rates

Rates are dynamic and depend on the **Utilization Rate** of the pool.

- **Utilization Rate (`U`)**:
  $$ U = \frac{\text{Total Borrows}}{\text{Total Deposits}} $$
  (Note: `calculateUtilizationPercent` in SDK uses Mint Decimals and available amounts properly).

- **Borrow APR**:
  Derived from the interest rate curve configured in the Reserve. It uses linear interpolation between configured utilization points.
  `simulate.calculateBorrowAprPercent(reserve)`

- **Supply (Deposit) APR**:
  Derived from Borrow APR, Utilization, and Spread Fee.
  $$ \text{SupplyAPR} = \text{BorrowAPR} \times U \times (1 - \text{SpreadFee}) $$
  `simulate.calculateDepositAprPercent(reserve)`

## 5. Looping Multiplier

Looping involves borrowing against collateral to buy more collateral, repeating the process.

- **Maximum Theoretical Multiplier**:
  Based on Loan-To-Value (LTV) ratio (Open LTV).
  $$ \text{Max Multiplier} = \frac{1}{1 - \text{LTV}} $$

- **Current Effective Multiplier (Leverage)**:
  $$ \text{Actual Multiplier} = \frac{\text{Total Assets Value}}{\text{User Equity Value}} = \frac{\text{Total Collateral}}{\text{Total Collateral} - \text{Total Debt}} $$

## 6. Implementation Steps

To calculate these in a script:

1.  **Initialize `SuilendClient`**.
2.  **Fetch `Obligation`**: `suilendClient.getObligation(...)`.
3.  **Fetch Reserves**: `suilendClient.lendingMarket.reserves` (needs refresh).
4.  **Parse Reserves**: Convert raw fields to useful numbers using `parseReserve` from `@suilend/sdk/parsers/reserve`.
5.  **Parse Obligation**: Use `parseObligation` from `@suilend/sdk/parsers/obligation` with the parsed reserve map.

The `parseObligation` function returns an object containing `unhealthyBorrowValueUsd`, `weightedBorrowsUsd`, `borrowLimitUsd`, etc., which makes calculating HF and net value trivial.
