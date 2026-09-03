import { getAddress, type Address } from 'viem';
import { publicClient, trader } from './env.js';

/**
 * The 3-byte prefix the EVM writes into a delegated account's code slot. A delegated
 * EOA's code is exactly `0xef0100 || implementation`, 23 bytes total.
 */
export const DELEGATION_PREFIX = '0xef0100';

/** The implementation an account currently delegates to, or undefined if it is a plain EOA. */
export async function currentDelegation(address: Address = trader.address): Promise<Address | undefined> {
  const code = await publicClient.getCode({ address });
  if (!code || !code.startsWith(DELEGATION_PREFIX)) return undefined;
  return getAddress(`0x${code.slice(DELEGATION_PREFIX.length)}`);
}
