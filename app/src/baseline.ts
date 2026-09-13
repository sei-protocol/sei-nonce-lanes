import { createWalletClient, http, type Address } from 'viem';
import {
  assertPlainRelayers,
  assertWriteNetwork,
  chain,
  displayRpcUrl,
  publicClient,
  relayerAccounts,
  rpcUrl,
} from './env.js';

/**
 * Measures the constraint being worked around, live on Sei, using a gas-only
 * relayer key so nothing of value is at risk.
 *
 * A single account's EVM nonces are strictly ordered. What is *not* settled is
 * what a node does with nonce n+1 while n is missing: reject it outright, or
 * admit it and hold it until the gap fills. Sei's strict producer path is
 * expected to reject with `bad nonce`, but that is the claim under test here,
 * not an assumption, and the answer decides whether a sender can keep more than
 * one transaction in flight at a time.
 *
 * Both nonce tags are sampled at every stage. `pending` and `latest` disagreeing
 * means either in-flight traffic or a node-specific pending view, and in that
 * case the gap this probe thinks it created may not be a gap at all. Reading one
 * tag only, at both ends, cannot tell the difference.
 */
async function main() {
  await assertWriteNetwork('baseline');
  await assertPlainRelayers('baseline');
  const account = relayerAccounts[0];
  if (!account) throw new Error('No relayer configured');

  const balance = await publicClient.getBalance({ address: account.address });
  if (balance === 0n) throw new Error(`${account.address} has no gas. Run: npm run fund`);

  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  console.log(`chain    ${chain.name} (${chain.id})`);
  console.log(`rpc      ${displayRpcUrl()}`);
  console.log(`account  ${account.address}`);
  console.log(`block    ${await publicClient.getBlockNumber()}\n`);

  const start = await sampleNonces(account.address, 'before');
  if (start.latest !== start.pending) {
    console.log(
      '\nWARNING: pending and latest already disagree, so this account has work in flight\n' +
        '         or this node reports a mempool-derived pending nonce. The gap below may\n' +
        '         not be a gap, and the verdict cannot be attributed to nonce ordering.\n',
    );
  }

  const gapped = start.latest + 1;
  console.log(`\n1. send nonce ${gapped}, deliberately skipping ${start.latest}`);
  let gappedHash: `0x${string}` | undefined;
  try {
    gappedHash = await wallet.sendTransaction({
      to: account.address,
      value: 0n,
      nonce: gapped,
    });
    console.log(`   admitted as ${gappedHash}`);
  } catch (error) {
    // Verbatim, not the first line: the exact string is the finding.
    console.log('   rejected on submission:');
    console.log(indent(error instanceof Error ? error.message : String(error)));
  }

  const afterGapped = await sampleNonces(account.address, 'after gapped send');

  let gappedMinedEarly = false;
  if (gappedHash) {
    console.log('\n   waiting 8s to see whether it can be included above a missing nonce...');
    gappedMinedEarly = await Promise.race([
      publicClient.waitForTransactionReceipt({ hash: gappedHash }).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8_000)),
    ]);
    console.log(
      gappedMinedEarly
        ? '   included with a gap below it, so this node does not enforce strict ordering'
        : '   not included, so it is either queued for later or discarded',
    );
  }

  console.log(`\n2. send nonce ${start.latest} to fill the gap`);
  const fillHash = await wallet.sendTransaction({
    to: account.address,
    value: 0n,
    nonce: start.latest,
  });
  const fillReceipt = await publicClient.waitForTransactionReceipt({ hash: fillHash });
  console.log(`   ${fillHash}`);
  console.log(`   included in block ${fillReceipt.blockNumber}`);

  let gappedLandedLate = false;
  if (gappedHash && !gappedMinedEarly) {
    console.log('\n3. the gap is filled; does the queued transaction land now?');
    gappedLandedLate = await Promise.race([
      publicClient.waitForTransactionReceipt({ hash: gappedHash }).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8_000)),
    ]);
    console.log(
      gappedLandedLate
        ? '   landed, so the node held it and released it when the gap filled'
        : '   still absent, so admitting it did not mean keeping it',
    );
  }

  const end = await sampleNonces(account.address, 'after');

  console.log('\n=== verdict ===');
  if (!gappedHash) {
    console.log('out-of-order submission  REJECTED at admission');
    console.log('in-flight per sender     1; a gap cannot be created, so nothing can queue behind it');
  } else if (gappedMinedEarly) {
    console.log('out-of-order submission  ACCEPTED and included above a gap');
    console.log('in-flight per sender     more than 1, and not strictly ordered on this path');
  } else if (gappedLandedLate) {
    console.log('out-of-order submission  QUEUED, then included once the gap filled');
    console.log('in-flight per sender     more than 1, released in nonce order');
  } else {
    console.log('out-of-order submission  ADMITTED then dropped');
    console.log('in-flight per sender     1 in effect, despite admission succeeding');
  }
  console.log(
    `nonce latest             ${start.latest} -> ${end.latest}` +
      `  (expected ${start.latest + (gappedMinedEarly || gappedLandedLate ? 2 : 1)})`,
  );
  console.log(`nonce pending            ${start.pending} -> ${end.pending}`);
  console.log(
    `tags agreed              before ${start.latest === start.pending ? 'yes' : 'NO'}, ` +
      `mid ${afterGapped.latest === afterGapped.pending ? 'yes' : 'NO'}, ` +
      `after ${end.latest === end.pending ? 'yes' : 'NO'}`,
  );
  console.log(
    '\nOne account, one queue. Compare with `npm run submit`, where 24 operations\n' +
      'from a single account are mutually independent and one failure strands nothing.',
  );
}

/**
 * Both tags, every time. A probe that reads `latest` alone cannot notice that
 * its own starting point was wrong.
 */
async function sampleNonces(
  address: Address,
  label: string,
): Promise<{ latest: number; pending: number }> {
  const [latest, pending] = await Promise.all([
    publicClient.getTransactionCount({ address, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address, blockTag: 'pending' }),
  ]);
  console.log(
    `nonce ${label.padEnd(18)} latest ${latest}  pending ${pending}` +
      (latest === pending ? '' : '  DIFFER'),
  );
  return { latest, pending };
}

function indent(value: string): string {
  return value
    .split('\n')
    .map((line) => `     ${line}`)
    .join('\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
