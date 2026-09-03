import type { Address } from 'viem';
import { parseDelegationDesignator } from './delegation-code.js';
import { publicClient, trader } from './env.js';

export { DELEGATION_PREFIX, parseDelegationDesignator } from './delegation-code.js';

/** The implementation an account currently delegates to, or undefined if it is a plain EOA. */
export async function currentDelegation(address: Address = trader.address): Promise<Address | undefined> {
  const code = await publicClient.getCode({ address });
  return parseDelegationDesignator(code);
}
