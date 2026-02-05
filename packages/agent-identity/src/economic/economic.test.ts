/**
 * economic.test.ts
 *
 * Tests for the economic layer: x402 payment gateway, devnet airdrop, and cost tracking.
 */

import {
  X402PaymentGateway,
  createPaymentGateway,
  type ServiceType,
  type PaymentRequirement,
} from './x402PaymentGateway';

import {
  DevnetAirdropService,
  createDevnetAirdropService,
} from './DevnetAirdropService';

import {
  InfrastructureCostTracker,
  createInfrastructureCostTracker,
  getInfrastructureCostTracker,
} from './InfrastructureCostTracker';

// =============================================================================
// X402 PAYMENT GATEWAY TESTS
// =============================================================================

describe('X402PaymentGateway', () => {
  describe('default (disabled)', () => {
    let gateway: X402PaymentGateway;

    beforeEach(() => {
      gateway = createPaymentGateway();
    });

    test('payments not required when disabled', () => {
      expect(gateway.requiresPayment('registration')).toBe(false);
      expect(gateway.requiresPayment('verification')).toBe(false);
      expect(gateway.requiresPayment('propagation_test')).toBe(false);
      expect(gateway.requiresPayment('seed_refinement')).toBe(false);
      expect(gateway.requiresPayment('storage_gateway')).toBe(false);
    });

    test('getPrice returns correct prices', () => {
      const regPrice = gateway.getPrice('registration');
      expect(regPrice.priceUSDC).toBe(0.01);
      expect(regPrice.price).toBe('$0.01');

      const verifyPrice = gateway.getPrice('verification');
      expect(verifyPrice.priceUSDC).toBe(0.001);
    });

    test('buildPaymentRequirements returns null when disabled', () => {
      const requirements = gateway.buildPaymentRequirements('registration');
      expect(requirements).toBeNull();
    });

    test('verifyPayment succeeds when disabled', async () => {
      const result = await gateway.verifyPayment(null, 'registration');
      expect(result.valid).toBe(true);
      expect(result.settled).toBe(true);
    });

    test('getStatus shows not enabled', () => {
      const status = gateway.getStatus();
      expect(status.network).toBe('devnet');
      expect(status.enabled).toBe(false);
      expect(status.note).toContain('not enabled');
    });
  });

  describe('devnet mode with payments enabled', () => {
    let gateway: X402PaymentGateway;
    const testPayToAddress = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

    beforeEach(() => {
      gateway = createPaymentGateway({
        network: 'devnet',
        enabled: true,
        payToAddress: testPayToAddress,
      });
    });

    test('payments required when enabled on devnet', () => {
      expect(gateway.requiresPayment('registration')).toBe(true);
      expect(gateway.requiresPayment('verification')).toBe(true);
    });

    test('buildPaymentRequirements uses devnet network identifier', () => {
      const requirements = gateway.buildPaymentRequirements('registration');
      expect(requirements).not.toBeNull();
      // Devnet: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1
      expect(requirements!.accepts[0].network).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
    });

    test('getStatus shows devnet payments active', () => {
      const status = gateway.getStatus();
      expect(status.network).toBe('devnet');
      expect(status.enabled).toBe(true);
      expect(status.note).toContain('faucet tokens');
    });
  });

  describe('mainnet mode with payments enabled', () => {
    let gateway: X402PaymentGateway;
    const testPayToAddress = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

    beforeEach(() => {
      gateway = createPaymentGateway({
        network: 'mainnet',
        enabled: true,
        payToAddress: testPayToAddress,
      });
    });

    test('payments required when enabled', () => {
      expect(gateway.requiresPayment('registration')).toBe(true);
      expect(gateway.requiresPayment('verification')).toBe(true);
    });

    test('buildPaymentRequirements returns valid structure', () => {
      const requirements = gateway.buildPaymentRequirements('registration');

      expect(requirements).not.toBeNull();
      expect(requirements!.x402Version).toBe(2);
      expect(requirements!.accepts).toHaveLength(1);
      expect(requirements!.accepts[0].scheme).toBe('exact');
      expect(requirements!.accepts[0].asset).toBe('USDC');
      expect(requirements!.accepts[0].payTo).toBe(testPayToAddress);
      expect(requirements!.accepts[0].network).toContain('solana:');
    });

    test('buildPaymentRequirements uses mainnet network identifier', () => {
      const requirements = gateway.buildPaymentRequirements('verification');
      // Mainnet: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
      expect(requirements!.accepts[0].network).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    });

    test('verifyPayment rejects when no signature provided', async () => {
      const result = await gateway.verifyPayment(null, 'registration');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Payment required');
    });

    test('createPaymentRequiredResponse returns 402 structure', () => {
      const response = gateway.createPaymentRequiredResponse('registration');

      expect(response.status).toBe(402);
      expect(response.headers['PAYMENT-REQUIRED']).toBeDefined();
      expect(response.body.error).toBe('Payment Required');
      expect(response.body.x402).toBeDefined();
    });

    test('payment required header is base64 encoded', () => {
      const response = gateway.createPaymentRequiredResponse('registration');
      const decoded = JSON.parse(
        Buffer.from(response.headers['PAYMENT-REQUIRED'], 'base64').toString()
      );

      expect(decoded.x402Version).toBe(2);
      expect(decoded.accepts).toHaveLength(1);
    });
  });

  describe('configuration methods', () => {
    let gateway: X402PaymentGateway;

    beforeEach(() => {
      gateway = createPaymentGateway();
    });

    test('enable() activates payments', () => {
      const address = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
      gateway.setNetwork('mainnet');
      gateway.enable(address);

      expect(gateway.requiresPayment('registration')).toBe(true);
    });

    test('disable() deactivates payments', () => {
      gateway.setNetwork('mainnet');
      gateway.enable('someAddress');
      gateway.disable();

      expect(gateway.requiresPayment('registration')).toBe(false);
    });

    test('setNetwork() switches network', () => {
      gateway.setNetwork('mainnet');
      const status = gateway.getStatus();
      expect(status.network).toBe('mainnet');
    });

    test('setPrice() updates service price', () => {
      gateway.setPrice('registration', 0.05);

      const price = gateway.getPrice('registration');
      expect(price.priceUSDC).toBe(0.05);
      expect(price.price).toBe('$0.05');
    });
  });

  describe('middleware', () => {
    test('middleware calls next() on devnet', async () => {
      const gateway = createPaymentGateway();
      const middleware = gateway.middleware('registration');

      const mockReq = { headers: {} };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const mockNext = jest.fn();

      await middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('middleware returns 402 when payment missing on mainnet', async () => {
      const gateway = createPaymentGateway({
        network: 'mainnet',
        enabled: true,
        payToAddress: 'someAddress',
      });
      const middleware = gateway.middleware('registration');

      const mockReq = { headers: {} };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const mockNext = jest.fn();

      await middleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(402);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// DEVNET AIRDROP SERVICE TESTS
// =============================================================================

describe('DevnetAirdropService', () => {
  let service: DevnetAirdropService;

  beforeEach(() => {
    service = createDevnetAirdropService({
      rateLimitMs: 1000, // Short for testing
    });
  });

  afterEach(() => {
    service.clearAllRateLimits();
  });

  test('creates service with default config', () => {
    const status = service.getStatus();

    expect(status.network).toBe('devnet');
    expect(status.solAmount).toBe(1.0);
    expect(status.usdcAmount).toBe(10.0);
  });

  test('rate limiting prevents rapid airdrops', async () => {
    const testAddress = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

    // Mock the first airdrop (simulate rate limit being set)
    // We can't actually airdrop without network, but we can test rate limiting
    service['airdropTimestamps'].set(testAddress, Date.now());

    const result = await service.airdropToAgent(testAddress);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Rate limited');
  });

  test('clearRateLimit removes rate limit for wallet', () => {
    const testAddress = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    service['airdropTimestamps'].set(testAddress, Date.now());

    service.clearRateLimit(testAddress);

    expect(service['airdropTimestamps'].has(testAddress)).toBe(false);
  });

  test('clearAllRateLimits clears all', () => {
    service['airdropTimestamps'].set('addr1', Date.now());
    service['airdropTimestamps'].set('addr2', Date.now());

    service.clearAllRateLimits();

    expect(service['airdropTimestamps'].size).toBe(0);
  });

  test('getStatus returns active airdrop count', () => {
    service['airdropTimestamps'].set('addr1', Date.now());
    service['airdropTimestamps'].set('addr2', Date.now());

    const status = service.getStatus();
    expect(status.activeAirdrops).toBe(2);
  });

  // Network tests - skipped without actual connection
  test.skip('checkBalance returns wallet balance (requires network)', async () => {
    const balance = await service.checkBalance('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
    expect(balance.sol).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// INFRASTRUCTURE COST TRACKER TESTS
// =============================================================================

describe('InfrastructureCostTracker', () => {
  let tracker: InfrastructureCostTracker;

  beforeEach(() => {
    tracker = createInfrastructureCostTracker();
  });

  describe('initial state', () => {
    test('starts with default costs and revenue categories', () => {
      const state = tracker.getState();

      expect(state.costs.length).toBeGreaterThan(0);
      expect(state.revenue.length).toBeGreaterThan(0);
      expect(state.totalCosts).toBeGreaterThan(0); // Estimates present
      expect(state.totalRevenue).toBe(0);
    });

    test('period is current month', () => {
      const state = tracker.getState();
      const now = new Date();
      const expectedPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      expect(state.period).toBe(expectedPeriod);
    });
  });

  describe('recording usage', () => {
    test('recordServiceCall tracks revenue', () => {
      tracker.recordServiceCall('registration', 5);
      tracker.recordServiceCall('verification', 100);

      const state = tracker.getState();
      const regRevenue = state.revenue.find(r => r.id === 'registration');
      const verifyRevenue = state.revenue.find(r => r.id === 'verification');

      expect(regRevenue!.unitsThisMonth).toBe(5);
      expect(regRevenue!.revenueThisMonth).toBe(0.05); // 5 * $0.01

      expect(verifyRevenue!.unitsThisMonth).toBe(100);
      expect(verifyRevenue!.revenueThisMonth).toBe(0.1); // 100 * $0.001
    });

    test('recordCost tracks infrastructure costs', () => {
      tracker.recordCost('solana_storage', 5.50);
      tracker.recordCost('hosting', 20.00);

      const state = tracker.getState();
      const solanaStorage = state.costs.find(c => c.id === 'solana_storage');
      const hosting = state.costs.find(c => c.id === 'hosting');

      expect(solanaStorage!.actualThisMonth).toBe(5.50);
      expect(hosting!.actualThisMonth).toBe(20.00);
    });

    test('recordUsage with custom revenue', () => {
      tracker.recordUsage('custom_service', 10, { revenue: 1.50 });

      const report = tracker.getUsageReport();
      expect(report.byService['custom_service'].revenue).toBe(1.50);
    });
  });

  describe('sustainability analysis', () => {
    test('deficit when no revenue', () => {
      const status = tracker.getSustainabilityStatus();

      expect(status.status).toBe('deficit');
      expect(status.ratio).toBe(0);
    });

    test('approaching when revenue covers 50%+', () => {
      // Default monthly costs estimate is ~$95
      // Need to generate ~$50 revenue
      tracker.recordServiceCall('registration', 2500); // $25
      tracker.recordServiceCall('verification', 25000); // $25

      const status = tracker.getSustainabilityStatus();
      expect(status.status).toBe('approaching');
    });

    test('sustainable when revenue covers 100%+', () => {
      // Generate enough to cover costs
      tracker.recordServiceCall('registration', 5000); // $50
      tracker.recordServiceCall('verification', 50000); // $50

      const status = tracker.getSustainabilityStatus();
      expect(status.status).toBe('sustainable');
    });
  });

  describe('break-even analysis', () => {
    test('calculates required units per service', () => {
      const analysis = tracker.getBreakEvenAnalysis();

      expect(analysis.monthlyTarget).toBeGreaterThan(0);
      expect(analysis.requiredByService['registration']).toBeDefined();
      expect(analysis.requiredByService['verification']).toBeDefined();

      // Verification at $0.001 should need more units than registration at $0.01
      expect(analysis.requiredByService['verification']).toBeGreaterThan(
        analysis.requiredByService['registration']
      );
    });

    test('percentComplete tracks progress', () => {
      tracker.recordServiceCall('registration', 1000);

      const analysis = tracker.getBreakEvenAnalysis();
      expect(analysis.currentProgress).toBe(10); // 1000 * $0.01
      expect(analysis.percentComplete).toBeGreaterThan(0);
    });
  });

  describe('usage reporting', () => {
    test('tracks events by service', () => {
      tracker.recordServiceCall('registration', 5);
      tracker.recordServiceCall('verification', 10);
      tracker.recordServiceCall('registration', 3);

      const report = tracker.getUsageReport();

      expect(report.totalEvents).toBe(3);
      expect(report.byService['registration'].count).toBe(8);
      expect(report.byService['verification'].count).toBe(10);
    });
  });

  describe('reset', () => {
    test('clears all data', () => {
      tracker.recordServiceCall('registration', 100);
      tracker.recordCost('solana_storage', 10);

      tracker.reset();

      const state = tracker.getState();
      expect(state.totalRevenue).toBe(0);
      expect(state.costs.every(c => c.actualThisMonth === 0)).toBe(true);
    });
  });

  describe('export', () => {
    test('exports complete data', () => {
      tracker.recordServiceCall('registration', 50);

      const exported = tracker.exportData();

      expect(exported.state).toBeDefined();
      expect(exported.events).toBeDefined();
      expect(exported.breakEven).toBeDefined();
      expect(exported.sustainability).toBeDefined();
    });
  });

  describe('singleton', () => {
    test('getInfrastructureCostTracker returns same instance', () => {
      const tracker1 = getInfrastructureCostTracker();
      const tracker2 = getInfrastructureCostTracker();

      expect(tracker1).toBe(tracker2);
    });
  });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('Economic Layer Integration', () => {
  test('payment gateway integrates with cost tracker', () => {
    // Create fresh instances to avoid state leaking from other tests
    const gateway = new X402PaymentGateway({
      network: 'mainnet',
      enabled: true,
      payToAddress: 'testAddress',
    });
    const tracker = new InfrastructureCostTracker();

    // Simulate a registration payment
    const requirements = gateway.buildPaymentRequirements('registration');
    expect(requirements).not.toBeNull();

    // Track the revenue (default registration price is $0.01)
    tracker.recordServiceCall('registration', 1);

    const state = tracker.getState();
    const regRevenue = state.revenue.find(r => r.id === 'registration');
    expect(regRevenue!.revenueThisMonth).toBe(0.01);
  });

  test('all service types have corresponding revenue categories', () => {
    const gateway = new X402PaymentGateway();
    const tracker = new InfrastructureCostTracker();

    const services: ServiceType[] = [
      'registration',
      'verification',
      'propagation_test',
      'seed_refinement',
      'storage_gateway',
    ];

    const state = tracker.getState();

    // Verify every payment service has a matching revenue tracking category
    for (const service of services) {
      const price = gateway.getPrice(service);
      const revenueCategory = state.revenue.find(r => r.id === service);

      expect(price).toBeDefined();
      expect(price.priceUSDC).toBeGreaterThan(0);
      expect(revenueCategory).toBeDefined();
      expect(revenueCategory!.pricePerUnit).toBeGreaterThan(0);
    }
  });
});
