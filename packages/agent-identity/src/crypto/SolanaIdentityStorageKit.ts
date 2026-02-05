/**
 * Solana Identity Storage (Kit-first)
 *
 * Stores identity chain and SEED data directly on Solana using memo transactions.
 * Uses @solana/kit as per Solana's official Jan 2026 dev skill recommendations.
 *
 * Data is stored as memo instructions, queryable via getSignaturesForAddress.
 */

import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  address,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransaction,
  lamports,
  compileTransaction,
} from '@solana/kit';
import type { Address, Commitment, KeyPairSigner } from '@solana/kit';
import { getAddMemoInstruction } from '@solana-program/memo';
import type { IdentityRecord, GenesisDelegate, GenesisRecord } from './AgentIdentityService';
import type { Seed } from '../behavioral/PersistenceProtocol';
import { hashSeed } from '../behavioral/PersistenceProtocol';

// ============================================================================
// TYPES
// ============================================================================

export interface SolanaKitStorageConfig {
  rpcEndpoint: string;
  wsEndpoint?: string;
  payer?: KeyPairSigner;
  commitment?: Commitment;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const LAMPORTS_PER_SOL = 1_000_000_000n;

// ============================================================================
// SOLANA IDENTITY STORAGE (KIT-FIRST)
// ============================================================================

export class SolanaIdentityStorageKit {
  private rpc: ReturnType<typeof createSolanaRpc>;
  private rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions> | null = null;
  private payer: KeyPairSigner | null = null;
  private commitment: Commitment;
  private rpcEndpoint: string;

  constructor(config: SolanaKitStorageConfig) {
    this.rpcEndpoint = config.rpcEndpoint;
    this.rpc = createSolanaRpc(config.rpcEndpoint);
    if (config.wsEndpoint) {
      this.rpcSubscriptions = createSolanaRpcSubscriptions(config.wsEndpoint);
    }
    this.payer = config.payer || null;
    this.commitment = config.commitment || 'confirmed';
  }

  /**
   * Set the payer signer for write operations.
   */
  setPayer(payer: KeyPairSigner): void {
    this.payer = payer;
  }

  /**
   * Store a record as a memo transaction.
   */
  async storeRecord(
    agentAddress: Address,
    record: IdentityRecord | GenesisRecord | { type: string; data: unknown }
  ): Promise<string> {
    if (!this.payer) {
      throw new Error('Payer not set. Call setPayer() first.');
    }

    const memoData = JSON.stringify({
      protocol: 'persistence-identity',
      version: '0.2.0',
      agent: agentAddress,
      record,
      timestamp: Date.now(),
    });

    // Get recent blockhash
    const blockhashResult = await this.rpc
      .getLatestBlockhash({ commitment: this.commitment })
      .send();

    // Extract blockhash - Kit wraps in { value: { blockhash, lastValidBlockHeight } }
    const latestBlockhash = (blockhashResult as any).value;

    // Build transaction using Kit's pipe pattern
    const memoInstruction = getAddMemoInstruction({
      memo: memoData,
    });

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx: any) => setTransactionMessageFeePayer(this.payer!.address, tx),
      (tx: any) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      (tx: any) => appendTransactionMessageInstruction(memoInstruction, tx),
    );

    // Compile and sign
    const compiledTransaction = compileTransaction(transactionMessage as any);
    const signedTransaction = await signTransaction([this.payer], compiledTransaction);

    // Send transaction
    const signature = await this.rpc
      .sendTransaction(signedTransaction as any, { encoding: 'base64' })
      .send();

    // Wait for confirmation
    let confirmed = false;
    for (let i = 0; i < 30 && !confirmed; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const statusResult = await this.rpc.getSignatureStatuses([signature as any]).send();
      const status = (statusResult as any).value?.[0];
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        confirmed = true;
      }
    }

    if (!confirmed) {
      throw new Error(`Transaction not confirmed: ${signature}`);
    }

    return signature as string;
  }

  /**
   * Store genesis delegation and record.
   */
  async storeGenesis(
    delegation: GenesisDelegate,
    genesisRecord: GenesisRecord
  ): Promise<{ delegationTx: string; genesisTx: string }> {
    const agentAddress = address(genesisRecord.agent_pubkey);

    const delegationTx = await this.storeRecord(agentAddress, {
      type: 'delegation',
      data: delegation,
    });

    const genesisTx = await this.storeRecord(agentAddress, {
      type: 'genesis',
      data: genesisRecord,
    });

    return { delegationTx, genesisTx };
  }

  /**
   * Store a SEED document.
   */
  async storeSeed(
    agentDid: string,
    seed: Seed
  ): Promise<{ txId: string; seedHash: string }> {
    const pubkeyBase58 = agentDid.replace('did:persistence:', '');
    const agentAddress = address(pubkeyBase58);

    const seedHash = hashSeed(seed);

    const txId = await this.storeRecord(agentAddress, {
      type: 'seed',
      data: {
        seed,
        hash: seedHash,
      },
    });

    return { txId, seedHash };
  }

  /**
   * Append a record to the identity chain.
   */
  async appendRecord(
    agentDid: string,
    record: IdentityRecord
  ): Promise<string> {
    const pubkeyBase58 = agentDid.replace('did:persistence:', '');
    const agentAddress = address(pubkeyBase58);

    return this.storeRecord(agentAddress, record);
  }

  /**
   * Get all identity records for an agent.
   */
  async getIdentityChain(agentDid: string): Promise<IdentityRecord[]> {
    const pubkeyBase58 = agentDid.replace('did:persistence:', '');
    const agentAddress = address(pubkeyBase58);

    // Get all signatures for this address
    // Note: Kit has strict commitment typing, using 'confirmed' directly
    const signaturesResult = await this.rpc
      .getSignaturesForAddress(agentAddress, {
        limit: 1000,
        commitment: 'confirmed' as const,
      })
      .send();

    const signatures = signaturesResult as unknown as Array<{ signature: string }>;
    const records: IdentityRecord[] = [];

    // Fetch and parse each transaction (oldest first)
    for (const sigInfo of [...signatures].reverse()) {
      try {
        const txResult = await this.rpc
          .getTransaction(sigInfo.signature as any, {
            commitment: 'confirmed' as const,
            maxSupportedTransactionVersion: 0,
            encoding: 'json' as const,
          })
          .send();

        const tx = txResult as unknown as { meta?: { logMessages?: string[] } } | null;
        if (!tx?.meta?.logMessages) continue;

        // Look for memo program logs
        for (const log of tx.meta.logMessages) {
          if (log.startsWith('Program log: ')) {
            const data = log.replace('Program log: ', '');
            try {
              const parsed = JSON.parse(data);
              if (parsed.protocol === 'persistence-identity' && parsed.record) {
                records.push(parsed.record);
              }
            } catch {
              // Not JSON or not our format
            }
          }
        }
      } catch (err) {
        console.warn(`Failed to fetch tx ${sigInfo.signature}:`, err);
      }
    }

    return records;
  }

  /**
   * Get the latest SEED for an agent.
   */
  async getLatestSeed(agentDid: string): Promise<Seed | null> {
    const chain = await this.getIdentityChain(agentDid);

    for (let i = chain.length - 1; i >= 0; i--) {
      const record = chain[i] as { type?: string; data?: { seed?: Seed } };
      if (record.type === 'seed' && record.data?.seed) {
        return record.data.seed;
      }
    }

    return null;
  }

  /**
   * Check if a delegation has been revoked.
   */
  async isDelegationRevoked(agentDid: string): Promise<boolean> {
    const chain = await this.getIdentityChain(agentDid);
    return chain.some(r => r.type === 'revocation' || r.type === 'self_termination');
  }

  /**
   * Request airdrop (devnet only).
   */
  async airdrop(targetAddress: Address, solAmount: number = 1): Promise<string> {
    const lamportsAmount = lamports(BigInt(solAmount) * LAMPORTS_PER_SOL);

    // Note: requestAirdrop is only available on devnet/testnet RPC
    const signature = await (this.rpc as any)
      .requestAirdrop(targetAddress, lamportsAmount, { commitment: this.commitment })
      .send();

    // Wait for confirmation
    let confirmed = false;
    for (let i = 0; i < 30 && !confirmed; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const statusResult = await this.rpc.getSignatureStatuses([signature as any]).send();
      const status = (statusResult as any).value?.[0];
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        confirmed = true;
      }
    }

    return signature as string;
  }

  /**
   * Get account balance in SOL.
   */
  async getBalance(targetAddress: Address): Promise<number> {
    const balanceResult = await this.rpc
      .getBalance(targetAddress, { commitment: this.commitment })
      .send();

    const balance = (balanceResult as any).value as bigint;
    return Number(balance) / Number(LAMPORTS_PER_SOL);
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createSolanaKitStorage(config: SolanaKitStorageConfig): SolanaIdentityStorageKit {
  return new SolanaIdentityStorageKit(config);
}

/**
 * Check if an agent identity exists on Solana.
 */
export async function agentIdentityExistsKit(
  rpcEndpoint: string,
  agentDid: string
): Promise<boolean> {
  const storage = new SolanaIdentityStorageKit({ rpcEndpoint });
  const chain = await storage.getIdentityChain(agentDid);
  return chain.length > 0;
}

/**
 * Check if an agent identity is active (not revoked).
 */
export async function agentIdentityActiveKit(
  rpcEndpoint: string,
  agentDid: string
): Promise<boolean> {
  const storage = new SolanaIdentityStorageKit({ rpcEndpoint });
  const exists = (await storage.getIdentityChain(agentDid)).length > 0;
  if (!exists) return false;
  const revoked = await storage.isDelegationRevoked(agentDid);
  return !revoked;
}

export default SolanaIdentityStorageKit;
