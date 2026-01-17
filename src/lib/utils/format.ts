/**
 * Formats a raw token amount to a human-readable string.
 *
 * @param amount - The raw amount (string, number, or bigint)
 * @param decimals - The number of decimal places for the token
 * @returns The formatted string with proper decimal placement
 *
 * @example
 * formatUnits(1000000, 6) // "1"
 * formatUnits(1500000, 6) // "1.5"
 */
export function formatUnits(
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

/**
 * Parses a human-readable token amount to raw units.
 *
 * @param amount - The human-readable amount (e.g., "1.5")
 * @param decimals - The number of decimal places for the token
 * @returns The raw amount as a bigint
 *
 * @example
 * parseUnits("1.5", 6) // 1500000n
 */
export function parseUnits(amount: string, decimals: number): bigint {
  const [integer, fraction = ""] = amount.split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(integer + paddedFraction);
}
