// Regression: `hw-app-eth` returned an already-0x-prefixed address, we prefixed it
// again, and the tile failed with viem's `0x0xA4A8…` checksum error. The device
// boundary must accept either form, because the SDKs also disagree on case.
import { describe, expect, it } from 'bun:test';
import { deviceAddress } from '../../src/lib/signers/hardware';

const CHECKSUMMED = '0xA4A8a4a61bD1a69bB98400CBd4e40a6Be426C5bF';

describe('deviceAddress', () => {
  it('does not double a prefix the device already sent', () => {
    expect(deviceAddress(CHECKSUMMED)).toBe(CHECKSUMMED);
  });

  it('accepts bare hex, which is the other shape the SDKs return', () => {
    expect(deviceAddress(CHECKSUMMED.slice(2))).toBe(CHECKSUMMED);
  });

  it('checksums lowercase input rather than rejecting it', () => {
    expect(deviceAddress(CHECKSUMMED.toLowerCase())).toBe(CHECKSUMMED);
  });
});
