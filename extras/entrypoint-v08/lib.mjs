import {
  concatHex,
  getAddress,
  getContractAddress,
  isAddressEqual,
  keccak256,
} from 'viem';

/** Canonical eth-infinitism/account-abstraction v0.8.0 deployment constants. */
export const ENTRY_POINT = getAddress('0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108');
export const SENDER_CREATOR = getAddress('0x449ED7C3e6Fee6a97311d4b55475DF59C44AdD33');
export const ENTRY_POINT_SALT =
  '0x0a59dbff790c23c976a548690c27297883cc66b4c67024f9117b0238995e35e9';

/** Arachnid's deterministic deployment proxy used by the canonical release. */
export const CREATE2_PROXY = getAddress('0x4e59b44847b379578588920ca78fbf26c0b4956c');
export const CREATE2_PROXY_DEPLOYER = getAddress('0x3fab184622dc19b6109349b94811493bf2a45362');
export const CREATE2_PROXY_DEPLOYMENT_COST = 10_000_000_000_000_000n;
export const CREATE2_PROXY_DEPLOYMENT_TRANSACTION =
  '0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222';
export const CREATE2_PROXY_DEPLOYMENT_HASH = keccak256(
  CREATE2_PROXY_DEPLOYMENT_TRANSACTION,
);
export const CREATE2_PROXY_RUNTIME =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';

export function parseEntryPointArtifact(value) {
  if (!isRecord(value)) throw new Error('EntryPoint deployment artifact must be a JSON object');

  const address = parseAddress(value.address, 'address');
  const bytecode = parseBytecode(value.bytecode, 'bytecode');
  const deployedBytecode = parseBytecode(value.deployedBytecode, 'deployedBytecode');
  if (!isAddressEqual(address, ENTRY_POINT)) {
    throw new Error(`Artifact targets ${address}; expected EntryPoint v0.8 at ${ENTRY_POINT}`);
  }

  const predicted = entryPointAddress(bytecode);
  if (!isAddressEqual(predicted, ENTRY_POINT)) {
    throw new Error(
      `Pinned init code predicts ${predicted}; expected EntryPoint v0.8 at ${ENTRY_POINT}`,
    );
  }
  return { address, bytecode, deployedBytecode };
}

export function entryPointAddress(bytecode) {
  return getContractAddress({
    bytecode,
    from: CREATE2_PROXY,
    opcode: 'CREATE2',
    salt: ENTRY_POINT_SALT,
  });
}

export function entryPointDeploymentData(bytecode) {
  return concatHex([ENTRY_POINT_SALT, bytecode]);
}

/**
 * EntryPoint's EIP-712 immutables make the full runtime differ by chain ID.
 * Length and metadata identify the pinned build; deploy.mjs also verifies its
 * domain, SenderCreator, ERC-165 support, and transient-storage execution.
 */
export function assertEntryPointRuntimeShape(actual, artifactRuntime) {
  if (hexByteLength(actual) !== hexByteLength(artifactRuntime)) {
    throw new Error(
      `Code at ${ENTRY_POINT} is ${hexByteLength(actual)} bytes; ` +
        `the pinned v0.8 runtime is ${hexByteLength(artifactRuntime)} bytes`,
    );
  }
  if (solidityMetadataTrailer(actual) !== solidityMetadataTrailer(artifactRuntime)) {
    throw new Error(`Code at ${ENTRY_POINT} does not match the pinned v0.8 compiler metadata`);
  }
}

export function solidityMetadataTrailer(bytecode) {
  const hex = bytecode.slice(2);
  if (hex.length < 4 || hex.length % 2 !== 0) throw new Error('Invalid EVM bytecode');

  const metadataBytes = Number.parseInt(hex.slice(-4), 16);
  const trailerCharacters = (metadataBytes + 2) * 2;
  if (trailerCharacters > hex.length) throw new Error('Invalid Solidity metadata length');
  return `0x${hex.slice(-trailerCharacters)}`;
}

function hexByteLength(value) {
  return (value.length - 2) / 2;
}

function parseAddress(value, field) {
  if (typeof value !== 'string') throw new Error(`Artifact ${field} is missing`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`Artifact ${field} is not an address`);
  }
}

function parseBytecode(value, field) {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error(`Artifact ${field} is not bytecode`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
