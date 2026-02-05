/**
 * Infrastructure Cost Tracker
 *
 * Tracks operational costs and revenue for the agent identity system.
 * Helps determine if the system is economically self-sustaining.
 *
 * Monthly cost estimates:
 * - Solana Storage: ~$5-15 (depends on transaction volume)
 * - Vercel Hosting: ~$20
 * - RPC Node Access: ~$50
 * - Total: ~$75-85/month
 *
 * Break-even: ~25,000 verification requests/month at $0.001 each
 */

// ============================================================================
// TYPES
// ============================================================================

export interface CostCategory {
  id: string;
  name: string;
  monthlyEstimate: number;
  actualThisMonth: number;
  unit: string;
}

export interface RevenueCategory {
  id: string;
  name: string;
  pricePerUnit: number;
  unitsThisMonth: number;
  revenueThisMonth: number;
}

export interface CostTrackerState {
  period: string;  // YYYY-MM
  costs: CostCategory[];
  revenue: RevenueCategory[];
  totalCosts: number;
  totalRevenue: number;
  netPosition: number;
  sustainabilityRatio: number;  // revenue / costs
}

export interface UsageEvent {
  timestamp: number;
  service: string;
  units: number;
  cost: number;
  revenue: number;
  metadata?: Record<string, any>;
}

// ============================================================================
// DEFAULT COSTS AND REVENUE CATEGORIES
// ============================================================================

const DEFAULT_COSTS: CostCategory[] = [
  {
    id: 'solana_storage',
    name: 'Solana Storage (Memos)',
    monthlyEstimate: 10,
    actualThisMonth: 0,
    unit: 'USD'
  },
  {
    id: 'hosting',
    name: 'Vercel Hosting',
    monthlyEstimate: 20,
    actualThisMonth: 0,
    unit: 'USD'
  },
  {
    id: 'rpc',
    name: 'RPC Node Access',
    monthlyEstimate: 50,
    actualThisMonth: 0,
    unit: 'USD'
  },
  {
    id: 'facilitator',
    name: 'x402 Facilitator',
    monthlyEstimate: 10,
    actualThisMonth: 0,
    unit: 'USD'
  }
];

const DEFAULT_REVENUE: RevenueCategory[] = [
  {
    id: 'registration',
    name: 'Registrations',
    pricePerUnit: 0.01,
    unitsThisMonth: 0,
    revenueThisMonth: 0
  },
  {
    id: 'verification',
    name: 'Verifications',
    pricePerUnit: 0.001,
    unitsThisMonth: 0,
    revenueThisMonth: 0
  },
  {
    id: 'propagation_test',
    name: 'Propagation Tests',
    pricePerUnit: 0.005,
    unitsThisMonth: 0,
    revenueThisMonth: 0
  },
  {
    id: 'seed_refinement',
    name: 'SEED Refinements',
    pricePerUnit: 0.002,
    unitsThisMonth: 0,
    revenueThisMonth: 0
  },
  {
    id: 'storage_gateway',
    name: 'Storage Gateway',
    pricePerUnit: 0.003,
    unitsThisMonth: 0,
    revenueThisMonth: 0
  }
];

// ============================================================================
// INFRASTRUCTURE COST TRACKER
// ============================================================================

export class InfrastructureCostTracker {
  private costs: CostCategory[];
  private revenue: RevenueCategory[];
  private events: UsageEvent[] = [];
  private currentPeriod: string;

  constructor() {
    this.costs = JSON.parse(JSON.stringify(DEFAULT_COSTS));
    this.revenue = JSON.parse(JSON.stringify(DEFAULT_REVENUE));
    this.currentPeriod = this.getCurrentPeriod();
  }

  /**
   * Get current period (YYYY-MM).
   */
  private getCurrentPeriod(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Record a usage event.
   */
  recordUsage(
    service: string,
    units: number,
    options: { cost?: number; revenue?: number; metadata?: Record<string, any> } = {}
  ): void {
    // Auto-rotate period if needed
    const period = this.getCurrentPeriod();
    if (period !== this.currentPeriod) {
      this.rotatePeriod();
    }

    // Record the event
    const event: UsageEvent = {
      timestamp: Date.now(),
      service,
      units,
      cost: options.cost || 0,
      revenue: options.revenue || 0,
      metadata: options.metadata
    };
    this.events.push(event);

    // Update costs if applicable
    if (options.cost && options.cost > 0) {
      const costCategory = this.costs.find(c =>
        c.id === service || c.name.toLowerCase().includes(service.toLowerCase())
      );
      if (costCategory) {
        costCategory.actualThisMonth += options.cost;
      }
    }

    // Update revenue if applicable
    if (options.revenue && options.revenue > 0) {
      const revenueCategory = this.revenue.find(r =>
        r.id === service || r.name.toLowerCase().includes(service.toLowerCase())
      );
      if (revenueCategory) {
        revenueCategory.unitsThisMonth += units;
        revenueCategory.revenueThisMonth += options.revenue;
      }
    }
  }

  /**
   * Record a service call (auto-calculates revenue).
   */
  recordServiceCall(service: string, units: number = 1): void {
    const revenueCategory = this.revenue.find(r => r.id === service);
    if (revenueCategory) {
      const revenue = revenueCategory.pricePerUnit * units;
      this.recordUsage(service, units, { revenue });
    } else {
      this.recordUsage(service, units);
    }
  }

  /**
   * Record an infrastructure cost.
   */
  recordCost(category: string, amount: number): void {
    this.recordUsage(category, 1, { cost: amount });
  }

  /**
   * Get current state.
   */
  getState(): CostTrackerState {
    const totalCosts = this.costs.reduce((sum, c) => sum + c.actualThisMonth, 0) ||
                       this.costs.reduce((sum, c) => sum + c.monthlyEstimate, 0);
    const totalRevenue = this.revenue.reduce((sum, r) => sum + r.revenueThisMonth, 0);
    const netPosition = totalRevenue - totalCosts;
    const sustainabilityRatio = totalCosts > 0 ? totalRevenue / totalCosts : 0;

    return {
      period: this.currentPeriod,
      costs: [...this.costs],
      revenue: [...this.revenue],
      totalCosts,
      totalRevenue,
      netPosition,
      sustainabilityRatio
    };
  }

  /**
   * Calculate break-even requirements.
   */
  getBreakEvenAnalysis(): {
    monthlyTarget: number;
    currentProgress: number;
    percentComplete: number;
    requiredByService: Record<string, number>;
  } {
    const state = this.getState();
    const monthlyTarget = state.totalCosts ||
      this.costs.reduce((sum, c) => sum + c.monthlyEstimate, 0);

    // Calculate how many of each service needed to break even
    const requiredByService: Record<string, number> = {};
    for (const r of this.revenue) {
      if (r.pricePerUnit > 0) {
        requiredByService[r.id] = Math.ceil(monthlyTarget / r.pricePerUnit);
      }
    }

    return {
      monthlyTarget,
      currentProgress: state.totalRevenue,
      percentComplete: monthlyTarget > 0 ? (state.totalRevenue / monthlyTarget) * 100 : 0,
      requiredByService
    };
  }

  /**
   * Get usage report.
   */
  getUsageReport(): {
    period: string;
    totalEvents: number;
    byService: Record<string, { count: number; revenue: number; cost: number }>;
    peakHour?: number;
  } {
    const byService: Record<string, { count: number; revenue: number; cost: number }> = {};

    for (const event of this.events) {
      if (!byService[event.service]) {
        byService[event.service] = { count: 0, revenue: 0, cost: 0 };
      }
      byService[event.service].count += event.units;
      byService[event.service].revenue += event.revenue;
      byService[event.service].cost += event.cost;
    }

    // Find peak hour
    const hourCounts: Record<number, number> = {};
    for (const event of this.events) {
      const hour = new Date(event.timestamp).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    }
    const peakHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];

    return {
      period: this.currentPeriod,
      totalEvents: this.events.length,
      byService,
      peakHour: peakHour ? parseInt(peakHour[0]) : undefined
    };
  }

  /**
   * Get sustainability status.
   */
  getSustainabilityStatus(): {
    status: 'sustainable' | 'approaching' | 'deficit';
    message: string;
    ratio: number;
    monthsOfRunway?: number;
  } {
    const state = this.getState();

    if (state.sustainabilityRatio >= 1.0) {
      return {
        status: 'sustainable',
        message: 'Revenue covers infrastructure costs',
        ratio: state.sustainabilityRatio
      };
    } else if (state.sustainabilityRatio >= 0.5) {
      return {
        status: 'approaching',
        message: `Revenue covers ${(state.sustainabilityRatio * 100).toFixed(1)}% of costs`,
        ratio: state.sustainabilityRatio
      };
    } else {
      return {
        status: 'deficit',
        message: `Significant funding gap - need ${((1 - state.sustainabilityRatio) * 100).toFixed(1)}% more revenue`,
        ratio: state.sustainabilityRatio
      };
    }
  }

  /**
   * Rotate to a new period.
   */
  private rotatePeriod(): void {
    // Archive current data (in production, would save to storage)
    console.log(`Rotating period from ${this.currentPeriod} to ${this.getCurrentPeriod()}`);

    // Reset counters
    for (const cost of this.costs) {
      cost.actualThisMonth = 0;
    }
    for (const rev of this.revenue) {
      rev.unitsThisMonth = 0;
      rev.revenueThisMonth = 0;
    }
    this.events = [];
    this.currentPeriod = this.getCurrentPeriod();
  }

  /**
   * Export data for analysis.
   */
  exportData(): {
    state: CostTrackerState;
    events: UsageEvent[];
    breakEven: { monthlyTarget: number; currentProgress: number; percentComplete: number; requiredByService: Record<string, number> };
    sustainability: { status: 'sustainable' | 'approaching' | 'deficit'; message: string; ratio: number; monthsOfRunway?: number };
  } {
    return {
      state: this.getState(),
      events: [...this.events],
      breakEven: this.getBreakEvenAnalysis(),
      sustainability: this.getSustainabilityStatus()
    };
  }

  /**
   * Reset all data.
   */
  reset(): void {
    this.costs = JSON.parse(JSON.stringify(DEFAULT_COSTS));
    this.revenue = JSON.parse(JSON.stringify(DEFAULT_REVENUE));
    this.events = [];
    this.currentPeriod = this.getCurrentPeriod();
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

// Singleton instance for global tracking
let globalTracker: InfrastructureCostTracker | null = null;

export function getInfrastructureCostTracker(): InfrastructureCostTracker {
  if (!globalTracker) {
    globalTracker = new InfrastructureCostTracker();
  }
  return globalTracker;
}

export function createInfrastructureCostTracker(): InfrastructureCostTracker {
  return new InfrastructureCostTracker();
}

export default InfrastructureCostTracker;
