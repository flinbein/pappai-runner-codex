import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseVersion, publicationTag, alreadyPublished } from '../scripts/publish.mjs';

test('each push gets its own version and a retry keeps its version', () => {
  assert.equal(releaseVersion('0.1.0', '1'), '0.1.0');
  assert.equal(releaseVersion('0.1.0', '12'), '0.1.11');
  assert.throws(() => releaseVersion('0.1.0', '0'));
});

test('verify tarball integrity on retries and preserve latest on out-of-order releases', () => {
  assert.equal(alreadyPublished(undefined, 'digest'), false);
  assert.equal(alreadyPublished({ dist: { integrity: 'digest' } }, 'digest'), true);
  assert.throws(() => alreadyPublished({ dist: { integrity: 'other' } }, 'digest'));
  assert.equal(publicationTag('0.1.9', '0.1.10'), 'backfill');
  assert.equal(publicationTag('0.1.10', '0.1.9'), 'latest');
});
