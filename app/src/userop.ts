import { encodeFunctionData, hashTypedData, toHex, type Address, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { accountAbi } from './abi.js';

export type UserOp = {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

/**
 * An ERC-4337 nonce is `(uint192 key << 64) | uint64 seq`. The EntryPoint keeps one
 * `seq` counter per key, so two ops with different keys are mutually independent:
 * neither can strand the other, in any order, whether the other lands, reverts, or
 * is never submitted at all.
 */
export function laneNonce(lane: bigint, seq: bigint): bigint {
  if (lane <= 0n || lane > (1n << 192n) - 1n) throw new Error(`lane out of range: ${lane}`);
  if (seq < 0n || seq > (1n << 64n) - 1n) throw new Error(`seq out of range: ${seq}`);
  return (lane << 64n) | seq;
}

export function decodeLaneNonce(nonce: bigint): { lane: bigint; seq: bigint } {
  return { lane: nonce >> 64n, seq: nonce & ((1n << 64n) - 1n) };
}

/** Two uint128 values packed into one bytes32, high bits first. */
export function packPair(high: bigint, low: bigint): Hex {
  const maxUint128 = (1n << 128n) - 1n;
  if (high < 0n || high > maxUint128) throw new Error(`high value out of uint128 range: ${high}`);
  if (low < 0n || low > maxUint128) throw new Error(`low value out of uint128 range: ${low}`);
  return toHex((high << 128n) | low, { size: 32 });
}

/**
 * EIP-712 type used by EntryPoint v0.8's `getUserOpHash`. Must match
 * `UserOperationLib.PACKED_USEROP_TYPEHASH` field for field, including order.
 */
export const USER_OP_TYPES = {
  PackedUserOperation: [
    { name: 'sender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'initCode', type: 'bytes' },
    { name: 'callData', type: 'bytes' },
    { name: 'accountGasLimits', type: 'bytes32' },
    { name: 'preVerificationGas', type: 'uint256' },
    { name: 'gasFees', type: 'bytes32' },
    { name: 'paymasterAndData', type: 'bytes' },
  ],
} as const;

export function userOpDomain(chainId: number, entryPoint: Address) {
  return { name: 'ERC4337', version: '1', chainId, verifyingContract: entryPoint } as const;
}

function typedDataMessage(op: UserOp) {
  return {
    sender: op.sender,
    nonce: op.nonce,
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: op.preVerificationGas,
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
  };
}

/** Local recomputation of `EntryPoint.getUserOpHash`, no RPC round-trip. */
export function userOpHash(op: UserOp, chainId: number, entryPoint: Address): Hex {
  return hashTypedData({
    domain: userOpDomain(chainId, entryPoint),
    types: USER_OP_TYPES,
    primaryType: 'PackedUserOperation',
    message: typedDataMessage(op),
  });
}

/**
 * `Simple7702Account` validates with `ECDSA.recover(userOpHash, sig) == address(this)`,
 * so the EIP-712 digest is signed directly with no EIP-191 prefix. viem's
 * `signTypedData` produces exactly that.
 */
export async function signUserOp(
  account: PrivateKeyAccount,
  op: UserOp,
  chainId: number,
  entryPoint: Address,
): Promise<UserOp> {
  const signature = await account.signTypedData({
    domain: userOpDomain(chainId, entryPoint),
    types: USER_OP_TYPES,
    primaryType: 'PackedUserOperation',
    message: typedDataMessage(op),
  });
  return { ...op, signature };
}

export type BuildOpArgs = {
  sender: Address;
  lane: bigint;
  seq: bigint;
  target: Address;
  data: Hex;
  value?: bigint;
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export function buildOp(args: BuildOpArgs): UserOp {
  return {
    sender: args.sender,
    nonce: laneNonce(args.lane, args.seq),
    // Empty. The EOA is already delegated, so it already has code and there is
    // nothing for the EntryPoint to deploy. The `0x7702` initCode marker is only
    // needed when the authorization tuple rides along in the same bundle.
    initCode: '0x',
    callData: encodeFunctionData({
      abi: accountAbi,
      functionName: 'execute',
      args: [args.target, args.value ?? 0n, args.data],
    }),
    accountGasLimits: packPair(args.verificationGasLimit, args.callGasLimit),
    preVerificationGas: args.preVerificationGas,
    gasFees: packPair(args.maxPriorityFeePerGas, args.maxFeePerGas),
    paymasterAndData: '0x',
    signature: '0x',
  };
}
