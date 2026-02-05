/**
 * bootstrap.test.ts
 *
 * Tests for the agent identity bootstrap system.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Keypair, PublicKey } from '@solana/web3.js';

import {
  KeypairManager,
  createKeypairManager,
  publicKeyToDid,
  parseDid,
} from './KeypairManager';

import {
  DevnetFunder,
  createDevnetFunder,
} from './DevnetFunder';

// =============================================================================
// KEYPAIR MANAGER TESTS
// =============================================================================

describe('KeypairManager', () => {
  const testDir = '.test-agent-identity';

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('publicKeyToDid', () => {
    test('generates correct did:persistence format', () => {
      const keypair = Keypair.generate();
      const did = publicKeyToDid(keypair.publicKey, 'devnet');

      expect(did).toMatch(/^did:persistence:devnet:[1-9A-HJ-NP-Za-km-z]+$/);
      expect(did).toContain(keypair.publicKey.toBase58());
    });

    test('includes network in DID', () => {
      const keypair = Keypair.generate();

      const devnetDid = publicKeyToDid(keypair.publicKey, 'devnet');
      const mainnetDid = publicKeyToDid(keypair.publicKey, 'mainnet');

      expect(devnetDid).toContain(':devnet:');
      expect(mainnetDid).toContain(':mainnet:');
    });
  });

  describe('parseDid', () => {
    test('parses valid did:persistence DIDs', () => {
      const keypair = Keypair.generate();
      const did = publicKeyToDid(keypair.publicKey, 'devnet');

      const parsed = parseDid(did);

      expect(parsed).not.toBeNull();
      expect(parsed!.method).toBe('persistence');
      expect(parsed!.network).toBe('devnet');
      expect(parsed!.publicKey).toBe(keypair.publicKey.toBase58());
    });

    test('returns null for invalid DIDs', () => {
      expect(parseDid('did:other:123')).toBeNull();
      expect(parseDid('not-a-did')).toBeNull();
      expect(parseDid('did:persistence:invalid:network:key')).toBeNull();
    });
  });

  describe('KeypairManager', () => {
    test('generates new keypair', () => {
      const manager = createKeypairManager({
        storageDir: testDir,
        network: 'devnet',
      });

      const keypair = manager.generate();

      expect(keypair).toBeInstanceOf(Keypair);
      expect(manager.getDid()).toMatch(/^did:persistence:devnet:/);
    });

    test('saves and loads keypair', () => {
      const manager1 = createKeypairManager({
        storageDir: testDir,
        network: 'devnet',
      });

      manager1.generate();
      manager1.save();

      const did1 = manager1.getDid();
      const pubkey1 = manager1.getPublicKey()!.toBase58();

      // Create new manager and load
      const manager2 = createKeypairManager({
        storageDir: testDir,
        network: 'devnet',
      });

      const keypair2 = manager2.load();

      expect(keypair2).not.toBeNull();
      expect(manager2.getDid()).toBe(did1);
      expect(manager2.getPublicKey()!.toBase58()).toBe(pubkey1);
    });

    test('loadOrGenerate creates if not exists', () => {
      const manager = createKeypairManager({
        storageDir: testDir,
        network: 'devnet',
      });

      expect(manager.exists()).toBe(false);

      const keypair = manager.loadOrGenerate();

      expect(keypair).toBeInstanceOf(Keypair);
      expect(manager.exists()).toBe(true);
    });

    test('loadOrGenerate loads if exists', () => {
      // First create
      const manager1 = createKeypairManager({
        storageDir: testDir,
        network: 'devnet',
      });
      manager1.generate();
      manager1.save();
      const did1 = manager1.getDid();

      // Then load
      const manager2 = createKeypairManager({
        storageDir: testDir,
        network: 'devnet',
      });
      manager2.loadOrGenerate();

      expect(manager2.getDid()).toBe(did1);
    });

    test('exports secret key as base58', () => {
      const manager = createKeypairManager({
        storageDir: testDir,
        network: 'devnet',
      });

      manager.generate();
      const exported = manager.exportSecretKey();

      expect(exported).not.toBeNull();
      expect(typeof exported).toBe('string');
      expect(exported!.length).toBeGreaterThan(50); // base58 encoded 64 bytes
    });

    test('creates .gitignore in storage directory', () => {
      const manager = createKeypairManager({
        storageDir: testDir,
        network: 'devnet',
      });

      manager.generate();
      manager.save();

      const gitignorePath = path.join(testDir, '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('*');
    });
  });
});

describe('DevnetFunder', () => {
  // Note: These tests require network access to devnet
  // In CI, these might be skipped or mocked

  test('creates funder with default config', () => {
    const funder = createDevnetFunder();
    expect(funder).toBeDefined();
    expect(funder.getConnection()).toBeDefined();
  });

  test('warns when endpoint is not devnet', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    createDevnetFunder({
      rpcEndpoint: 'https://api.mainnet-beta.solana.com',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('does not appear to be devnet')
    );

    warnSpy.mockRestore();
  });

  // Integration test - requires network
  test.skip('can check balance (requires network)', async () => {
    const funder = createDevnetFunder();
    const keypair = Keypair.generate();

    const balance = await funder.getBalance(keypair.publicKey);

    expect(typeof balance).toBe('number');
    expect(balance).toBe(0); // New keypair has no balance
  });

  // Integration test - requires network
  test.skip('can request airdrop (requires network)', async () => {
    const funder = createDevnetFunder();
    const keypair = Keypair.generate();

    const result = await funder.requestAirdrop(keypair.publicKey, 0.5);

    expect(result.success).toBe(true);
    expect(result.balanceAfter).toBeGreaterThan(result.balanceBefore);
  }, 60000); // Long timeout for network operation
});

describe('DID format validation', () => {
  test('did:persistence format is correct', () => {
    const keypair = Keypair.generate();
    const did = publicKeyToDid(keypair.publicKey, 'devnet');

    // Format: did:persistence:<network>:<base58-pubkey>
    const parts = did.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('did');
    expect(parts[1]).toBe('persistence');
    expect(parts[2]).toBe('devnet');
    expect(parts[3]).toBe(keypair.publicKey.toBase58());
  });

  test('DID is deterministic for same keypair', () => {
    const keypair = Keypair.generate();

    const did1 = publicKeyToDid(keypair.publicKey, 'devnet');
    const did2 = publicKeyToDid(keypair.publicKey, 'devnet');

    expect(did1).toBe(did2);
  });

  test('different keypairs produce different DIDs', () => {
    const keypair1 = Keypair.generate();
    const keypair2 = Keypair.generate();

    const did1 = publicKeyToDid(keypair1.publicKey, 'devnet');
    const did2 = publicKeyToDid(keypair2.publicKey, 'devnet');

    expect(did1).not.toBe(did2);
  });
});
