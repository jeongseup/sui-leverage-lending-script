import BigNumber from "bignumber.js";

// WAD constant (10^18)
const WAD = new BigNumber(1e18);

/**
 * Calculates the compounded borrow balance based on the initial and current cumulative borrow rates.
 *
 * Formula: RawAmount * (CurrentRate / InitialRate)
 *
 * Reference: https://github.com/suilend/suilend-fe-public/blob/main/sdk/src/utils/simulate.ts#L47C1-L75C4
 *
 * @param rawBorrowAmount The raw borrowed amount (in WAD or raw units)
 * @param cumulativeBorrowRateInit The cumulative borrow rate at the time of borrowing (in WAD)
 * @param cumulativeBorrowRateCurrent The current cumulative borrow rate from the reserve (in WAD)
 * @returns The compounded borrow amount (BigNumber)
 */
export function calculateCompoundedBorrow(
  rawBorrowAmount: BigNumber | string,
  cumulativeBorrowRateInit: BigNumber | string,
  cumulativeBorrowRateCurrent: BigNumber | string
): BigNumber {
  const rawInfo = new BigNumber(rawBorrowAmount);
  const initRate = new BigNumber(cumulativeBorrowRateInit);
  const currentRate = new BigNumber(cumulativeBorrowRateCurrent);

  if (initRate.eq(0)) return rawInfo;

  // Formula: RawAmount * (CurrentRate / InitialRate)
  const compoundingFactor = currentRate.div(initRate);
  return rawInfo.times(compoundingFactor);
}
