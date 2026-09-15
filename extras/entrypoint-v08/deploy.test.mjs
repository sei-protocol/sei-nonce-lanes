import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertEntryPointRuntimeShape,
  CREATE2_PROXY,
  CREATE2_PROXY_DEPLOYMENT_HASH,
  entryPointAddress,
  entryPointDeploymentData,
  ENTRY_POINT,
  ENTRY_POINT_SALT,
  parseEntryPointArtifact,
  solidityMetadataTrailer,
} from './lib.mjs';

const artifactUrl = new URL(
  '../../lib/account-abstraction/deployments/ethereum/EntryPoint.json',
  import.meta.url,
);

test('pinned v0.8 artifact resolves to the canonical CREATE2 address', async () => {
  const artifact = parseEntryPointArtifact(
    JSON.parse(await readFile(artifactUrl, 'utf8')),
  );

  assert.equal(entryPointAddress(artifact.bytecode), ENTRY_POINT);
  assert.equal(
    entryPointDeploymentData(artifact.bytecode),
    `${ENTRY_POINT_SALT}${artifact.bytecode.slice(2)}`,
  );
  assert.equal(CREATE2_PROXY, '0x4e59b44847b379578588920cA78FbF26c0B4956C');
});

test('factory bootstrap transaction is the published Arachnid transaction', () => {
  assert.equal(
    CREATE2_PROXY_DEPLOYMENT_HASH,
    '0xeddf9e61fb9d8f5111840daef55e5fde0041f5702856532cdbb5a02998033d26',
  );
});

test('runtime shape permits immutable differences but rejects wrong builds', () => {
  const artifactRuntime = '0x6001aabb0002';
  const sameBuildDifferentImmutable = '0x60ffaabb0002';

  assert.equal(solidityMetadataTrailer(artifactRuntime), '0xaabb0002');
  assert.doesNotThrow(() =>
    assertEntryPointRuntimeShape(sameBuildDifferentImmutable, artifactRuntime),
  );
  assert.throws(
    () => assertEntryPointRuntimeShape('0x60ffaacc0002', artifactRuntime),
    /compiler metadata/,
  );
  assert.throws(
    () => assertEntryPointRuntimeShape('0x60ff00aabb0002', artifactRuntime),
    /pinned v0.8 runtime/,
  );
});
