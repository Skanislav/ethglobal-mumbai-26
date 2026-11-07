import { describe, expect, it } from 'bun:test';
import { addressRejection, formatEth, formatUsd, humanError } from '../../src/lib/format';

describe('formatEth', () => {
  it('keeps significance for the sub-gwei fees Sepolia actually charges', () => {
    // 1_282_756 gas at 18 wei: a real estimate read from Sepolia this session.
    expect(formatEth(23089608n)).toBe('0.00000000002308');
    expect(formatEth(0n)).toBe('0');
  });

  it('prints whole ETH with the fractional part trimmed', () => {
    expect(formatEth(10n ** 18n)).toBe('1.0');
    expect(formatEth(15n * 10n ** 17n)).toBe('1.5');
    expect(formatEth(1234567890000000000n)).toBe('1.234567');
  });
});

describe('formatUsd', () => {
  it('never rounds a real fee down to a fake $0.00', () => {
    expect(formatUsd(23089608n, 2223.41)).toBe('<$0.01');
    expect(formatUsd(0n, 2223.41)).toBe('$0');
    expect(formatUsd(10n ** 18n, 2223.41)).toBe('$2223.41');
  });
});

describe('addressRejection', () => {
  it('explains ENS and length problems instead of failing silently', () => {
    expect(addressRejection('')).toContain('Enter an address');
    expect(addressRejection('alice.eth')).toContain('ENS names are out of scope');
    expect(addressRejection('0x1234')).toContain('42 characters');
    expect(addressRejection('0xzz')).toContain('hex characters');
  });

  it('accepts a well-formed checksummed address', () => {
    expect(addressRejection('0x1111111111111111111111111111111111111111')).toBeNull();
  });

  it('rejects a bad checksum that is otherwise well-formed', () => {
    // Mixed case with an invalid EIP-55 checksum.
    expect(addressRejection('0xAbCdEf0123456789aBcDeF0123456789AbCdEf01')).not.toBeNull();
  });
});

describe('humanError', () => {
  it('translates the Safe revert codes a user can actually hit', () => {
    expect(humanError(new Error('execution reverted: GS024'))).toContain('rejected a signature (GS024)');
    expect(humanError(new Error('execution reverted: GS026'))).toContain('not an owner (GS026)');
  });

  it('translates the app named errors', () => {
    const rejected = Object.assign(new Error('UserRejected: nope'), { name: 'UserRejected' });
    expect(humanError(rejected)).toContain('rejected the request in your wallet');
    const blocked = Object.assign(new Error('TrezorError: popup closed'), { name: 'TrezorError' });
    expect(humanError(blocked)).toContain('allow popups');
  });

  it('tells a wrong share key apart from a blob that is not a session', () => {
    const wrongKey = Object.assign(new Error('WrongShareKey: nope'), { name: 'WrongShareKey' });
    expect(humanError(wrongKey)).toContain('key does not open that blob');
    const notOurs = Object.assign(new Error('ShareFormatError: not an sso session blob'), {
      name: 'ShareFormatError',
    });
    expect(humanError(notOurs)).toContain('not a readable session');
    const unindexed = Object.assign(new Error('BlobNotIndexed: nope'), { name: 'BlobNotIndexed' });
    expect(humanError(unindexed)).toContain('reopen the link in a minute');
  });
});
