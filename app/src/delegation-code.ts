import { getAddress, type Address, type Hex } from 'viem';

/** The EVM prefix for an EIP-7702 delegation designator. */
export const DELEGATION_PREFIX = '0xef0100';
const DELEGATION_DESIGNATOR_HEX_LENGTH = 2 + 2 * (3 + 20);

/** Parse exactly `0xef0100 || address`; reject contracts that merely share the prefix. */
export function parseDelegationDesignator(code: Hex | undefined): Address | undefined {
  if (
    !code ||
    code.length !== DELEGATION_DESIGNATOR_HEX_LENGTH ||
    !code.startsWith(DELEGATION_PREFIX)
  ) {
    return undefined;
  }
  return getAddress(`0x${code.slice(DELEGATION_PREFIX.length)}`);
}
