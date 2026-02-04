/**
 * Solana Identity Storage
 *
 * Stores identity chain and SEED data directly on Solana using memo transactions.
 * Simple, hackathon-friendly approach - no Arweave dependency.
 *
 * Data is stored as memo instructions, queryable via getSignaturesForAddress.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import type { IdentityRecord, GenesisDelegate, GenesisRecord, SeedCommitmentRecord } from './AgentIdentityService';
import type { Seed } from '../behavioral/PersistenceProtocol';
import { hashSeed } from '../behavioral/PersistenceProtocol';

// Memo program ID
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// ============================================================================
// TYPES
// ============================================================================

export interface SolanaStorageConfig {
  connection: Connection;
  payer?: Keypair;  // Optional - for writing. Reading is free.
}

interface StoredRecord {
  type: 'genesis' | 'delegation' | 'seed_commitment' | 'seed' | 'revocation';
  data: any;
  signature: string;
  slot: number;
  timestamp: number;
}

// ============================================================================
// SOLANA IDENTITY STORAGE
// ============================================================================

export class SolanaIdentityStorage {
  private connection: Connection;
  private payer: Keypair | null = null;

  constructor(config: SolanaStorageConfig) {
    this.connection = config.connection;
    this.payer = config.payer || null;
  }

  /**
   * Set the payer keypair for write operations.
   */
  setPayer(payer: Keypair): void {
    this.payer = payer;
  }

  /**
   * Store a record as a memo transaction.
   */
  async storeRecord(
    agentPublicKey: PublicKey,
    record: IdentityRecord | GenesisRecord | { type: string; data: any }
  ): Promise<string> {
    if (!this.payer) {
      throw new Error('Payer not set. Call setPayer() first.');
    }

    const memoData = JSON.stringify({
      protocol: 'persistence-identity',
      version: '0.1.0',
      agent: agentPublicKey.toBase58(),
      record,
      timestamp: Date.now(),
    });

    // Create memo instruction
    const memoInstruction = new TransactionInstruction({
      keys: [{ pubkey: agentPublicKey, isSigner: false, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memoData, 'utf-8'),
    });

    const transaction = new Transaction().add(memoInstruction);

    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [this.payer],
      { commitment: 'confirmed' }
    );

    return signature;
  }

  /**
   * Store genesis delegation and record.
   */
  async storeGenesis(
    delegation: GenesisDelegate,
    genesisRecord: GenesisRecord
  ): Promise<{ delegationTx: string; genesisTx: string }> {
    const agentPubkey = new PublicKey(genesisRecord.agent_pubkey);

    const delegationTx = await this.storeRecord(agentPubkey, {
      type: 'delegation',
      data: delegation,
    });

    const genesisTx = await this.storeRecord(agentPubkey, {
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
    // Extract public key from DID
    const pubkeyBase58 = agentDid.replace('did:persistence:', '');
    const agentPubkey = new PublicKey(pubkeyBase58);

    const seedHash = hashSeed(seed);

    const txId = await this.storeRecord(agentPubkey, {
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
    const agentPubkey = new PublicKey(pubkeyBase58);

    return this.storeRecord(agentPubkey, record);
  }

  /**
   * Get all identity records for an agent.
   */
  async getIdentityChain(agentDid: string): Promise<IdentityRecord[]> {
    const pubkeyBase58 = agentDid.replace('did:persistence:', '');
    const agentPubkey = new PublicKey(pubkeyBase58);

    // Get all signatures for this address
    const signatures = await this.connection.getSignaturesForAddress(
      agentPubkey,
      { limit: 1000 },
      'confirmed'
    );

    const records: IdentityRecord[] = [];

    // Fetch and parse each transaction
    for (const sigInfo of signatures.reverse()) {  // Oldest first
      try {
        const tx = await this.connection.getTransaction(sigInfo.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });

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

    // Find the latest seed record
    for (let i = chain.length - 1; i >= 0; i--) {
      const record = chain[i] as any;
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
   * Airdrop SOL to an account (devnet only).
   */
  async airdrop(publicKey: PublicKey, amount: number = 1): Promise<string> {
    const signature = await this.connection.requestAirdrop(
      publicKey,
      amount * LAMPORTS_PER_SOL
    );
    await this.connection.confirmTransaction(signature, 'confirmed');
    return signature;
  }

  /**
   * Get account balance.
   */
  async getBalance(publicKey: PublicKey): Promise<number> {
    const balance = await this.connection.getBalance(publicKey);
    return balance / LAMPORTS_PER_SOL;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createSolanaStorage(config: SolanaStorageConfig): SolanaIdentityStorage {
  return new SolanaIdentityStorage(config);
}

/**
 * Check if an agent identity exists on Solana.
 */
export async function agentIdentityExists(
  connection: Connection,
  agentDid: string
): Promise<boolean> {
  const storage = new SolanaIdentityStorage({ connection });
  const chain = await storage.getIdentityChain(agentDid);
  return chain.length > 0;
}

/**
 * Check if an agent identity is active (not revoked).
 */
export async function agentIdentityActive(
  connection: Connection,
  agentDid: string
): Promise<boolean> {
  const storage = new SolanaIdentityStorage({ connection });
  const exists = (await storage.getIdentityChain(agentDid)).length > 0;
  if (!exists) return false;
  const revoked = await storage.isDelegationRevoked(agentDid);
  return !revoked;
}

export default SolanaIdentityStorage;
