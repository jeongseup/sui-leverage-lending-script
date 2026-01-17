import { normalizeStructTag } from "@mysten/sui/utils";

/**
 * Normalizes a Sui coin type address to ensure consistent formatting.
 * Pads the package address to 64 characters and ensures 0x prefix.
 *
 * @param coinType - The coin type string (e.g., "0x2::sui::SUI")
 * @returns The normalized coin type with padded address
 *
 * @example
 * normalizeCoinType("0x2::sui::SUI")
 * // "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
 */
export function normalizeCoinType(coinType: string): string {
  const parts = coinType.split("::");
  if (parts.length !== 3) return coinType;
  let pkg = parts[0].replace("0x", "");
  pkg = pkg.padStart(64, "0");
  return `0x${pkg}::${parts[1]}::${parts[2]}`;
}

/**
 * Formats a coin type using normalizeStructTag with fallback.
 * Ensures the result always has 0x prefix.
 *
 * @param type - The coin type string
 * @returns The normalized coin type with 0x prefix
 */
export function formatCoinType(type: string): string {
  if (!type.startsWith("0x") && !type.includes("::")) {
    // Likely invalid, but let normalizeStructTag handle
  }
  try {
    const normalized = normalizeStructTag(type);
    if (!normalized.startsWith("0x")) {
      return `0x${normalized}`;
    }
    return normalized;
  } catch (e) {
    if (type.includes("::") && !type.startsWith("0x")) {
      return `0x${type}`;
    }
    return type;
  }
}
