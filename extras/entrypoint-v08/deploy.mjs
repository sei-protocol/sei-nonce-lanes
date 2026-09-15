import { readFile } from 'node:fs/promises';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  http,
  isAddressEqual,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  assertEntryPointRuntimeShape,
  CREATE2_PROXY,
  CREATE2_PROXY_DEPLOYER,
  CREATE2_PROXY_DEPLOYMENT_COST,
  CREATE2_PROXY_DEPLOYMENT_HASH,
  CREATE2_PROXY_DEPLOYMENT_TRANSACTION,
  CREATE2_PROXY_RUNTIME,
  entryPointDeploymentData,
  ENTRY_POINT,
  parseEntryPointArtifact,
  SENDER_CREATOR,
} from './lib.mjs';

const ARTIFACT_URL = new URL(
  '../../lib/account-abstraction/deployments/ethereum/EntryPoint.json',
  import.meta.url,
);
const CANCUN_TSTORE_PROBE_INIT_CODE = '0x600060005d60006000f3';
const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;
const CHECK_ABI = [
  {
    type: 'function',
    name: 'senderCreator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'eip712Domain',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'fields', type: 'bytes1' },
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
      { name: 'salt', type: 'bytes32' },
      { name: 'extensions', type: 'uint256[]' },
    ],
  },
  {
    type: 'function',
    name: 'supportsInterface',
    stateMutability: 'view',
    inputs: [{ name: 'interfaceId', type: 'bytes4' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'handleOps',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'ops',
        type: 'tuple[]',
        components: [
          { name: 'sender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'initCode', type: 'bytes' },
          { name: 'callData', type: 'bytes' },
          { name: 'accountGasLimits', type: 'bytes32' },
          { name: 'preVerificationGas', type: 'uint256' },
          { name: 'gasFees', type: 'bytes32' },
          { name: 'paymasterAndData', type: 'bytes' },
          { name: 'signature', type: 'bytes' },
        ],
      },
      { name: 'beneficiary', type: 'address' },
    ],
    outputs: [],
  },
];

async function main() {
  const rpcUrl = readRpcUrl(process.env.RPC_URL);
  const expectedChainId = readChainId(process.env.CHAIN_ID);
  const publicClient = createPublicClient({
    transport: http(rpcUrl),
    pollingInterval: 250,
  });
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== expectedChainId) {
    throw new Error(
      `RPC chain ID ${actualChainId} does not match CHAIN_ID=${expectedChainId}; refusing to deploy`,
    );
  }

  const artifact = parseEntryPointArtifact(
    JSON.parse(await readFile(ARTIFACT_URL, 'utf8')),
  );
  console.log(`chain              ${actualChainId}`);
  console.log(`rpc                ${displayRpcUrl(rpcUrl)}`);
  console.log(`EntryPoint v0.8    ${ENTRY_POINT}`);

  const existingCode = await publicClient.getCode({ address: ENTRY_POINT });
  if (existingCode) {
    await verifyEntryPoint(existingCode);
    console.log('status             already deployed and verified');
    return;
  }

  const deployer = readDeployer(process.env.DEPLOYER_PRIVATE_KEY);
  await assertCancunSupport(deployer.address);
  const chain = defineChain({
    id: actualChainId,
    name: `testnet ${actualChainId}`,
    nativeCurrency: { name: 'Native token', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    testnet: true,
  });
  const wallet = createWalletClient({
    account: deployer,
    chain,
    transport: http(rpcUrl),
  });

  console.log(`deployer           ${deployer.address}`);
  console.log(
    `deployer balance   ${formatEther(await publicClient.getBalance({ address: deployer.address }))}`,
  );

  await ensureCreate2Proxy();

  const deploymentData = entryPointDeploymentData(artifact.bytecode);
  const estimatedGas = await publicClient.estimateGas({
    account: deployer.address,
    to: CREATE2_PROXY,
    data: deploymentData,
  });
  const gas = estimatedGas + estimatedGas / 5n;
  console.log(`deploying          pinned v0.8 init code (${estimatedGas} estimated gas)`);
  const deploymentHash = await wallet.sendTransaction({
    to: CREATE2_PROXY,
    data: deploymentData,
    gas,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
  if (receipt.status !== 'success') {
    throw new Error(`EntryPoint deployment reverted: ${deploymentHash}`);
  }

  const deployedCode = await publicClient.getCode({ address: ENTRY_POINT });
  if (!deployedCode) throw new Error(`Deployment succeeded but ${ENTRY_POINT} has no code`);
  await verifyEntryPoint(deployedCode);

  console.log(`transaction        ${deploymentHash}`);
  console.log(`gas used           ${receipt.gasUsed}`);
  console.log('status             deployed and verified');
  console.log('note               EIP-7702 support is still required by the nonce-lanes demo');

  async function ensureCreate2Proxy() {
    let code = await publicClient.getCode({ address: CREATE2_PROXY });
    if (code) {
      assertCreate2Proxy(code);
      console.log(`CREATE2 proxy      ${CREATE2_PROXY} verified`);
      return;
    }

    const [nonce, block] = await Promise.all([
      publicClient.getTransactionCount({
        address: CREATE2_PROXY_DEPLOYER,
        blockTag: 'latest',
      }),
      publicClient.getBlock(),
    ]);
    if (nonce !== 0) {
      throw new Error(
        `CREATE2 proxy is missing, but one-time deployer ${CREATE2_PROXY_DEPLOYER} ` +
          `already has nonce ${nonce}. The testnet operator must install the proxy at genesis.`,
      );
    }
    if (block.baseFeePerGas && block.baseFeePerGas > 100_000_000_000n) {
      throw new Error(
        'The current base fee exceeds the canonical proxy transaction gas price of 100 gwei. ' +
          'Wait for it to fall or ask the testnet operator to install the proxy.',
      );
    }

    const balance = await publicClient.getBalance({ address: CREATE2_PROXY_DEPLOYER });
    if (balance < CREATE2_PROXY_DEPLOYMENT_COST) {
      const topUp = CREATE2_PROXY_DEPLOYMENT_COST - balance;
      console.log(
        `factory bootstrap  funding one-time deployer with ${formatEther(topUp)} native token`,
      );
      const fundingHash = await wallet.sendTransaction({
        to: CREATE2_PROXY_DEPLOYER,
        value: topUp,
      });
      const fundingReceipt = await publicClient.waitForTransactionReceipt({
        hash: fundingHash,
      });
      if (fundingReceipt.status !== 'success') {
        throw new Error(`Funding the CREATE2 proxy deployer reverted: ${fundingHash}`);
      }
    }

    console.log(`factory bootstrap  publishing ${CREATE2_PROXY_DEPLOYMENT_HASH}`);
    let factoryHash = CREATE2_PROXY_DEPLOYMENT_HASH;
    try {
      factoryHash = await publicClient.sendRawTransaction({
        serializedTransaction: CREATE2_PROXY_DEPLOYMENT_TRANSACTION,
      });
    } catch (error) {
      const transactionKnown = await publicClient
        .getTransaction({ hash: CREATE2_PROXY_DEPLOYMENT_HASH })
        .then(() => true)
        .catch(() => false);
      if (!transactionKnown) {
        throw new Error(
          'The RPC rejected the canonical unprotected CREATE2-proxy transaction. ' +
            `Ask the testnet operator to install the Arachnid proxy at ${CREATE2_PROXY}. ` +
            `RPC error: ${errorMessage(error)}`,
        );
      }
    }
    if (factoryHash.toLowerCase() !== CREATE2_PROXY_DEPLOYMENT_HASH.toLowerCase()) {
      throw new Error(`RPC returned an unexpected factory transaction hash: ${factoryHash}`);
    }

    const factoryReceipt = await publicClient.waitForTransactionReceipt({ hash: factoryHash });
    if (factoryReceipt.status !== 'success') {
      throw new Error(`CREATE2 proxy deployment reverted: ${factoryHash}`);
    }
    code = await publicClient.getCode({ address: CREATE2_PROXY });
    if (!code) throw new Error(`Factory transaction succeeded but ${CREATE2_PROXY} has no code`);
    assertCreate2Proxy(code);
    console.log(`CREATE2 proxy      ${CREATE2_PROXY} deployed and verified`);
  }

  async function verifyEntryPoint(code) {
    assertEntryPointRuntimeShape(code, artifact.deployedBytecode);
    const [senderCreator, domain, supportsErc165] = await Promise.all([
      publicClient.readContract({
        address: ENTRY_POINT,
        abi: CHECK_ABI,
        functionName: 'senderCreator',
      }),
      publicClient.readContract({
        address: ENTRY_POINT,
        abi: CHECK_ABI,
        functionName: 'eip712Domain',
      }),
      publicClient.readContract({
        address: ENTRY_POINT,
        abi: CHECK_ABI,
        functionName: 'supportsInterface',
        args: ['0x01ffc9a7'],
      }),
    ]);
    const [fields, name, version, domainChainId, verifyingContract, salt, extensions] =
      domain;
    if (
      !isAddressEqual(senderCreator, SENDER_CREATOR) ||
      fields !== '0x0f' ||
      name !== 'ERC4337' ||
      version !== '1' ||
      domainChainId !== BigInt(actualChainId) ||
      !isAddressEqual(verifyingContract, ENTRY_POINT) ||
      salt !== ZERO_BYTES32 ||
      extensions.length !== 0 ||
      !supportsErc165
    ) {
      throw new Error(`Contract at ${ENTRY_POINT} failed EntryPoint v0.8 identity checks`);
    }

    await publicClient.call({
      to: ENTRY_POINT,
      data: encodeFunctionData({
        abi: CHECK_ABI,
        functionName: 'handleOps',
        args: [[], CREATE2_PROXY_DEPLOYER],
      }),
    });
  }

  async function assertCancunSupport(account) {
    try {
      await publicClient.call({ account, data: CANCUN_TSTORE_PROBE_INIT_CODE });
    } catch (error) {
      throw new Error(
        'This chain or RPC cannot execute Cancun TSTORE, which EntryPoint v0.8 requires. ' +
          `Refusing an irreversible deployment. RPC error: ${errorMessage(error)}`,
      );
    }
  }
}

function assertCreate2Proxy(code) {
  if (code.toLowerCase() !== CREATE2_PROXY_RUNTIME.toLowerCase()) {
    throw new Error(`Unexpected code at canonical CREATE2 proxy ${CREATE2_PROXY}`);
  }
}

function readRpcUrl(value) {
  if (!value) throw new Error('Missing RPC_URL');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('RPC_URL must be a valid HTTP or HTTPS URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('RPC_URL must use http or https');
  }
  return value;
}

function readChainId(value) {
  const chainId = Number(value);
  if (!value || !Number.isSafeInteger(chainId) || chainId < 1) {
    throw new Error('CHAIN_ID must be a positive integer');
  }
  return chainId;
}

function readDeployer(value) {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value)) {
    throw new Error('DEPLOYER_PRIVATE_KEY must be a non-zero 32-byte hex private key');
  }
  return privateKeyToAccount(value);
}

function displayRpcUrl(value) {
  const parsed = new URL(value);
  return parsed.pathname === '/' && !parsed.search ? parsed.origin : `${parsed.origin}/…`;
}

function errorMessage(error) {
  if (error && typeof error === 'object' && 'shortMessage' in error) {
    return String(error.shortMessage);
  }
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
