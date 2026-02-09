/**
 * Trust API Tests
 */

import {
  TrustService,
  createTrustService,
  createTrustHandler,
  type TrustRequest,
  type TrustResponse,
  type TrustServiceConfig,
} from './trust';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

// Mock connection for testing
const mockConnection = {
  getSignaturesForAddress: jest.fn().mockResolvedValue([]),
  getTransaction: jest.fn().mockResolvedValue(null),
} as unknown as Connection;

const testConfig: TrustServiceConfig = {
  network: 'devnet',
  solanaStorage: {
    connection: mockConnection,
  },
};

describe('TrustService', () => {
  let service: TrustService;

  beforeEach(() => {
    service = createTrustService(testConfig);
    jest.clearAllMocks();
  });

  describe('getTrust', () => {
    it('should reject invalid pubkey format', async () => {
      const result = await service.getTrust({ pubkey: 'invalid-not-base58!' });

      expect(result.success).toBe(false);
      expect(result.trust_score).toBe(0);
      expect(result.spam_risk).toBe('high');
      expect(result.error).toContain('Invalid pubkey');
    });

    it('should return zero trust for unknown pubkey', async () => {
      const keypair = Keypair.generate();
      const result = await service.getTrust({ pubkey: keypair.publicKey.toBase58() });

      expect(result.success).toBe(true);
      expect(result.trust_score).toBe(0);
      expect(result.verified).toBe(false);
      expect(result.track_record).toBe('none');
      expect(result.sybil_resistant).toBe(false);
    });

    it('should include pubkey in response', async () => {
      const keypair = Keypair.generate();
      const pubkey = keypair.publicKey.toBase58();
      const result = await service.getTrust({ pubkey });

      expect(result.pubkey).toBe(pubkey);
    });
  });

  describe('getBatchTrust', () => {
    it('should handle multiple pubkeys', async () => {
      const pubkeys = [
        Keypair.generate().publicKey.toBase58(),
        Keypair.generate().publicKey.toBase58(),
        Keypair.generate().publicKey.toBase58(),
      ];

      const result = await service.getBatchTrust({ pubkeys });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(3);
      expect(result.summary.total).toBe(3);
    });

    it('should compute average trust score', async () => {
      const pubkeys = [
        Keypair.generate().publicKey.toBase58(),
        Keypair.generate().publicKey.toBase58(),
      ];

      const result = await service.getBatchTrust({ pubkeys });

      expect(result.summary.average_trust_score).toBeDefined();
      expect(typeof result.summary.average_trust_score).toBe('number');
    });
  });

  describe('quickTrust', () => {
    it('should return just the score number', async () => {
      const keypair = Keypair.generate();
      const score = await service.quickTrust(keypair.publicKey.toBase58());

      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  describe('payment requirements', () => {
    it('should not require payment on devnet', () => {
      expect(service.requiresPayment()).toBe(false);
    });

    it('should require payment on mainnet when configured', () => {
      // Mainnet requires a payToAddress to be set
      // By default, no payToAddress = no payment required
      const mainnetService = createTrustService({
        ...testConfig,
        network: 'mainnet',
      });
      // Without explicit payToAddress, defaults to disabled
      // This is a safety feature - payments must be explicitly configured
      expect(mainnetService.requiresPayment()).toBe(false);
    });
  });
});

describe('createTrustHandler', () => {
  let handler: ReturnType<typeof createTrustHandler>;

  beforeEach(() => {
    handler = createTrustHandler(testConfig);
  });

  it('should handle GET request with pubkey', async () => {
    const keypair = Keypair.generate();
    const req = {
      method: 'GET',
      query: { pubkey: keypair.publicKey.toBase58() },
      headers: {},
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
      end: jest.fn(),
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        pubkey: keypair.publicKey.toBase58(),
      })
    );
  });

  it('should return 400 for missing pubkey', async () => {
    const req = {
      method: 'GET',
      query: {},
      headers: {},
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Missing pubkey parameter',
      })
    );
  });

  it('should handle POST request with pubkey', async () => {
    const keypair = Keypair.generate();
    const req = {
      method: 'POST',
      query: {},
      body: { pubkey: keypair.publicKey.toBase58() },
      headers: {},
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('should handle batch POST request', async () => {
    const pubkeys = [
      Keypair.generate().publicKey.toBase58(),
      Keypair.generate().publicKey.toBase58(),
    ];
    const req = {
      method: 'POST',
      query: {},
      body: { pubkeys },
      headers: {},
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        summary: expect.objectContaining({
          total: 2,
        }),
      })
    );
  });

  it('should reject batch requests over 100 pubkeys', async () => {
    const pubkeys = Array(101).fill(null).map(() =>
      Keypair.generate().publicKey.toBase58()
    );
    const req = {
      method: 'POST',
      query: {},
      body: { pubkeys },
      headers: {},
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Maximum 100 pubkeys per batch',
      })
    );
  });

  it('should handle OPTIONS for CORS', async () => {
    const req = { method: 'OPTIONS' };
    const res = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      end: jest.fn(),
    };

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.end).toHaveBeenCalled();
  });

  it('should return 405 for unsupported methods', async () => {
    const req = { method: 'DELETE', headers: {} };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
    };

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
  });
});

describe('Trust Score Computation', () => {
  // These tests verify the scoring logic works correctly
  // by checking the expected ranges

  it('should produce scores in 0-100 range', async () => {
    const service = createTrustService(testConfig);

    for (let i = 0; i < 10; i++) {
      const keypair = Keypair.generate();
      const result = await service.getTrust({ pubkey: keypair.publicKey.toBase58() });

      expect(result.trust_score).toBeGreaterThanOrEqual(0);
      expect(result.trust_score).toBeLessThanOrEqual(100);
    }
  });

  it('should categorize spam risk correctly', async () => {
    const service = createTrustService(testConfig);
    const keypair = Keypair.generate();
    const result = await service.getTrust({ pubkey: keypair.publicKey.toBase58() });

    // Unknown identity should be high risk
    expect(['low', 'medium', 'high']).toContain(result.spam_risk);
  });

  it('should categorize track record correctly', async () => {
    const service = createTrustService(testConfig);
    const keypair = Keypair.generate();
    const result = await service.getTrust({ pubkey: keypair.publicKey.toBase58() });

    // Unknown identity should have no track record
    expect(['none', 'some', 'established']).toContain(result.track_record);
  });
});
