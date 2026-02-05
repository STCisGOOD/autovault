/**
 * SEED as Commitment
 *
 * Implements the core binding mechanism between behavioral identity (SEED)
 * and cryptographic identity (identity chain).
 *
 * Key concept: Every SEED update becomes a signed commitment in the identity chain.
 * This creates an auditable history of identity evolution, cryptographically bound
 * to the agent's keypair.
 *
 * Benefits:
 * - Tamper-evident: Any modification to stored SEED is detectable
 * - Auditable: Complete history of identity evolution
 * - Verifiable: Third parties can verify SEED authenticity
 * - Recoverable: Identity can be reconstructed from chain + storage
 */

import type { SeedCommitmentRecord, AgentIdentityService } from '../crypto/AgentIdentityService';
import type { SolanaIdentityStorage } from '../crypto/SolanaIdentityStorage';
import type { Seed, PropagationResult } from '../behavioral/PersistenceProtocol';
import { hashSeed } from '../behavioral/PersistenceProtocol';

// ============================================================================
// TYPES
// ============================================================================

export interface SeedCommitmentConfig {
  requireDivergenceScore: boolean;
  maxDivergenceForCommit: number;
  autoCommitOnTest: boolean;
}

export interface CommitmentResult {
  success: boolean;
  commitment?: SeedCommitmentRecord;
  solanaTx?: string;
  seedHash?: string;
  error?: string;
}

export interface SeedHistory {
  commits: Array<{
    version: string;
    hash: string;
    divergenceScore?: number;
    timestamp: number;
    solanaTx?: string;
  }>;
  evolutionPath: string[];  // Version chain
  totalCommits: number;
  averageDivergence: number;
}

// ============================================================================
// SEED COMMITMENT MANAGER
// ============================================================================

export class SeedCommitmentManager {
  private identityService: AgentIdentityService;
  private storage: SolanaIdentityStorage;
  private config: SeedCommitmentConfig;
  private pendingSeeds: Map<string, Seed> = new Map();

  constructor(
    identityService: AgentIdentityService,
    storage: SolanaIdentityStorage,
    config?: Partial<SeedCommitmentConfig>
  ) {
    this.identityService = identityService;
    this.storage = storage;
    this.config = {
      requireDivergenceScore: false,
      maxDivergenceForCommit: 1.0,
      autoCommitOnTest: false,
      ...config
    };
  }

  /**
   * Commit a SEED to the identity chain.
   */
  async commitSeed(
    seed: Seed,
    propagationResult?: PropagationResult
  ): Promise<CommitmentResult> {
    if (!this.identityService.isInitialized()) {
      return { success: false, error: 'Identity service not initialized' };
    }

    // Check divergence requirements
    const divergenceScore = propagationResult?.overallDivergence;

    if (this.config.requireDivergenceScore && divergenceScore === undefined) {
      return { success: false, error: 'Divergence score required for commitment' };
    }

    if (divergenceScore !== undefined && divergenceScore > this.config.maxDivergenceForCommit) {
      return {
        success: false,
        error: `Divergence too high: ${divergenceScore.toFixed(3)} > ${this.config.maxDivergenceForCommit}`
      };
    }

    try {
      const agentDid = this.identityService.getDID()!;
      const seedHash = hashSeed(seed);

      // Store SEED on Solana
      const { txId } = await this.storage.storeSeed(agentDid, seed);

      // Create commitment in chain
      const commitment = await this.identityService.addSeedCommitment(
        seedHash,
        seed.version,
        txId,
        divergenceScore
      );

      // Store commitment on Solana
      await this.storage.appendRecord(agentDid, commitment);

      return {
        success: true,
        commitment,
        solanaTx: txId,
        seedHash
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Commitment failed'
      };
    }
  }

  /**
   * Stage a SEED for later commitment.
   */
  stageSeed(seed: Seed): string {
    const stageId = `${seed.version}-${Date.now()}`;
    this.pendingSeeds.set(stageId, seed);
    return stageId;
  }

  /**
   * Commit a staged SEED.
   */
  async commitStaged(
    stageId: string,
    propagationResult?: PropagationResult
  ): Promise<CommitmentResult> {
    const seed = this.pendingSeeds.get(stageId);
    if (!seed) {
      return { success: false, error: 'No staged SEED found with that ID' };
    }

    const result = await this.commitSeed(seed, propagationResult);

    if (result.success) {
      this.pendingSeeds.delete(stageId);
    }

    return result;
  }

  /**
   * Get the SEED history for an agent.
   */
  async getSeedHistory(agentDid: string): Promise<SeedHistory> {
    const chain = await this.storage.getIdentityChain(agentDid);
    const seedCommitments = chain.filter(
      r => r.type === 'seed_commitment'
    ) as SeedCommitmentRecord[];

    const commits = seedCommitments.map(c => ({
      version: c.seed_version,
      hash: c.seed_hash,
      divergenceScore: c.divergence_score,
      timestamp: c.timestamp,
      solanaTx: c.solana_tx
    }));

    const evolutionPath = commits.map(c => c.version);

    const scoresWithValues = commits
      .filter(c => c.divergenceScore !== undefined)
      .map(c => c.divergenceScore!);

    const averageDivergence = scoresWithValues.length > 0
      ? scoresWithValues.reduce((a, b) => a + b, 0) / scoresWithValues.length
      : 0;

    return {
      commits,
      evolutionPath,
      totalCommits: commits.length,
      averageDivergence
    };
  }

  /**
   * Verify that a SEED matches its commitment.
   */
  async verifySeedBinding(agentDid: string, seed: Seed): Promise<{
    bound: boolean;
    commitmentFound: boolean;
    hashMatches: boolean;
    commitment?: SeedCommitmentRecord;
  }> {
    const chain = await this.storage.getIdentityChain(agentDid);
    const seedHash = hashSeed(seed);

    // Find commitment with matching hash
    const matchingCommitment = chain.find(
      r => r.type === 'seed_commitment' &&
           (r as SeedCommitmentRecord).seed_hash === seedHash
    ) as SeedCommitmentRecord | undefined;

    if (!matchingCommitment) {
      return {
        bound: false,
        commitmentFound: false,
        hashMatches: false
      };
    }

    return {
      bound: true,
      commitmentFound: true,
      hashMatches: true,
      commitment: matchingCommitment
    };
  }

  /**
   * Get the latest committed SEED.
   */
  async getLatestCommittedSeed(agentDid: string): Promise<{
    seed: Seed | null;
    commitment: SeedCommitmentRecord | null;
  }> {
    const chain = await this.storage.getIdentityChain(agentDid);

    // Find latest seed commitment
    let latestCommitment: SeedCommitmentRecord | null = null;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].type === 'seed_commitment') {
        latestCommitment = chain[i] as SeedCommitmentRecord;
        break;
      }
    }

    if (!latestCommitment) {
      return { seed: null, commitment: null };
    }

    // Fetch SEED from Solana
    const seed = await this.storage.getLatestSeed(agentDid);

    return { seed, commitment: latestCommitment };
  }

  /**
   * Calculate the evolution delta between two SEEDs.
   */
  calculateEvolutionDelta(oldSeed: Seed, newSeed: Seed): {
    weightsChanged: number;
    promptsChanged: number;
    referencesChanged: number;
    identityChanged: boolean;
    summary: string;
  } {
    const oldWeightIds = new Set(oldSeed.weights.map(w => w.id));
    const newWeightIds = new Set(newSeed.weights.map(w => w.id));
    const weightsChanged = [...oldWeightIds, ...newWeightIds].filter(
      id => !oldWeightIds.has(id) || !newWeightIds.has(id)
    ).length;

    const oldPromptIds = new Set(oldSeed.prompts.map(p => p.id));
    const newPromptIds = new Set(newSeed.prompts.map(p => p.id));
    const promptsChanged = [...oldPromptIds, ...newPromptIds].filter(
      id => !oldPromptIds.has(id) || !newPromptIds.has(id)
    ).length;

    const oldRefIds = new Set(oldSeed.references.map(r => r.promptId));
    const newRefIds = new Set(newSeed.references.map(r => r.promptId));
    const referencesChanged = [...oldRefIds, ...newRefIds].filter(
      id => !oldRefIds.has(id) || !newRefIds.has(id)
    ).length;

    const identityChanged = oldSeed.identity !== newSeed.identity;

    let summary = '';
    if (identityChanged) summary += 'Core identity changed. ';
    if (weightsChanged > 0) summary += `${weightsChanged} weights modified. `;
    if (promptsChanged > 0) summary += `${promptsChanged} prompts modified. `;
    if (referencesChanged > 0) summary += `${referencesChanged} references modified. `;
    if (!summary) summary = 'Minor metadata changes only.';

    return {
      weightsChanged,
      promptsChanged,
      referencesChanged,
      identityChanged,
      summary: summary.trim()
    };
  }

  /**
   * Get pending (staged) SEEDs.
   */
  getPendingSeeds(): Array<{ stageId: string; seed: Seed }> {
    return Array.from(this.pendingSeeds.entries()).map(([stageId, seed]) => ({
      stageId,
      seed
    }));
  }

  /**
   * Clear all pending SEEDs.
   */
  clearPending(): void {
    this.pendingSeeds.clear();
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

export function createSeedCommitmentManager(
  identityService: AgentIdentityService,
  storage: SolanaIdentityStorage,
  config?: Partial<SeedCommitmentConfig>
): SeedCommitmentManager {
  return new SeedCommitmentManager(identityService, storage, config);
}

export default SeedCommitmentManager;
