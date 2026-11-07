// The publisher's one job beyond building the request: refuse to hand back a link
// unless the receipt proves a blob was actually carried. A wallet that downgrades
// the request still returns a success receipt, and that happened live — a legacy
// 0-value self-send with gasUsed 12000 and no blob produced a link to a blob that
// never existed on Sepolia.

import { beforeEach, describe, expect, it, vi } from 'bun:test';

const sentParams: unknown[] = [];
let sendBehaviour: () => Promise<unknown> = async () => `0x${'11'.repeat(32)}`;
let receipt: Record<string, unknown> = {};

vi.mock('../../src/lib/client', () => ({
  sepoliaPublicClient: {
    getBlobBaseFee: async () => 1_000_000_000n,
    waitForTransactionReceipt: async () => receipt,
  },
}));

vi.mock('../../src/lib/signers/hotWallet', () => ({
  connectInjected: async () => ({
    address: '0x1111111111111111111111111111111111111111',
    label: 'test',
    provider: {
      request: async ({ params }: { params: unknown[] }) => {
        sentParams.push(params[0]);
        return sendBehaviour();
      },
    },
  }),
  requireSepolia: async () => {},
}));

// KZG is expensive and irrelevant here: a commitment of the right length is
// enough for the request to be built and for the versioned hash to be derived.
vi.mock('../../src/lib/kzg', () => ({
  getKzg: async () => ({
    blobToKzgCommitment: () => new Uint8Array(48).fill(7),
    computeBlobKzgProof: () => new Uint8Array(48).fill(9),
  }),
}));

const { publishShareBlob, BlobPublishRejected } = await import('../../src/lib/safe');

const BLOB = `0x${'ab'.repeat(131072)}` as `0x${string}`;

beforeEach(() => {
  sentParams.length = 0;
  sendBehaviour = async () => `0x${'11'.repeat(32)}`;
  receipt = { status: 'success', transactionHash: `0x${'11'.repeat(32)}`, gasUsed: 21000n, blockNumber: 1n, type: 'eip4844', blobGasUsed: 131_072n };
});

describe('publishShareBlob', () => {
  it('returns the versioned hash only when the receipt carried the blob', async () => {
    const result = await publishShareBlob(BLOB);
    expect(result.versionedHash).toMatch(/^0x01[0-9a-f]{62}$/);
    // The request must carry the hashes and sidecars the link depends on.
    const sent = sentParams[0] as Record<string, unknown>;
    expect(sent.type).toBe('0x3');
    expect(sent.blobVersionedHashes).toEqual([result.versionedHash]);
    expect(Array.isArray(sent.sidecars)).toBe(true);
  });

  it('refuses a success receipt that is not a blob transaction', async () => {
    // Exactly the live failure: a legacy self-send, status success, no blob.
    receipt = { status: 'success', transactionHash: `0x${'11'.repeat(32)}`, gasUsed: 12_000n, blockNumber: 1n, type: 'legacy' };
    await expect(publishShareBlob(BLOB)).rejects.toBeInstanceOf(BlobPublishRejected);
  });

  it('does not retry without the blob fields when the wallet rejects them', async () => {
    // A fallback here let a wallet send the payload as calldata for a success
    // receipt with no blob, so the retry must not exist.
    sendBehaviour = async () => {
      const err = new Error('the wallet does not support blob transactions');
      throw Object.assign(err, { code: 4200 });
    };
    await expect(publishShareBlob(BLOB)).rejects.toBeInstanceOf(BlobPublishRejected);
    expect(sentParams).toHaveLength(1);
    const sent = sentParams[0] as Record<string, unknown>;
    expect(sent.blobVersionedHashes).toBeDefined();
    expect(sent.sidecars).toBeDefined();
  });

  it('refuses a blob receipt whose blob gas is not one blob', async () => {
    receipt = { ...receipt, blobGasUsed: 262_144n };
    await expect(publishShareBlob(BLOB)).rejects.toBeInstanceOf(BlobPublishRejected);
  });
});
