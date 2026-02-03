/**
 * Arweave Identity Storage
 *
 * Permanent storage for agent identity chains and SEED documents on Arweave.
 * Supports both cryptographic chain records and behavioral SEED documents.
 *
 * Part of the Persistence Protocol.
 */

import Arweave from 'arweave';
import type {
  GenesisDelegate,
  IdentityRecord,
  GenesisRecord,
  SeedCommitmentRecord,
} from './AgentIdentityService';
import type { Seed } from '../behavioral/PersistenceProtocol';

// ============================================================================
// CONFIGURATION
// ============================================================================

const ARWEAVE_CONFIG = {
  host: 'arweave.net',
  port: 443,
  protocol: 'https' as const,
};

const TAGS = {
  APP_NAME: 'Persistence-Agent-Identity',
  APP_VERSION: '1.0.0',
  CONTENT_TYPE: 'application/json',
};

// ============================================================================
// ARWEAVE STORAGE IMPLEMENTATION
// ============================================================================

export class ArweaveIdentityStorage {
  private arweave: Arweave;
  private wallet: any;

  constructor(wallet?: any) {
    this.arweave = Arweave.init(ARWEAVE_CONFIG);
    this.wallet = wallet;
  }

  setWallet(wallet: any): void {
    this.wallet = wallet;
  }

  // --------------------------------------------------------------------------
  // STORAGE OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Store a genesis delegation and its corresponding genesis record.
   */
  async storeGenesis(
    delegation: GenesisDelegate,
    genesisRecord: GenesisRecord
  ): Promise<{ delegationTx: string; genesisTx: string }> {
    if (!this.wallet) {
      throw new Error('Wallet not configured');
    }

    const delegationTx = await this.storeData(
      delegation,
      {
        'Record-Type': 'genesis-delegation',
        'Agent-Subdomain': delegation.agent.subdomain,
        'Delegator-DID': delegation.delegator.did,
      }
    );

    const genesisTx = await this.storeData(
      genesisRecord,
      {
        'Record-Type': 'genesis-record',
        'Agent-DID': genesisRecord.agent_did,
        'Agent-Subdomain': delegation.agent.subdomain,
        'Sequence-Number': '0',
        'Delegation-TX': delegationTx,
      }
    );

    return { delegationTx, genesisTx };
  }

  /**
   * Append a record to an agent's identity chain.
   */
  async appendRecord(
    agentDid: string,
    record: IdentityRecord,
    previousTx?: string
  ): Promise<string> {
    if (!this.wallet) {
      throw new Error('Wallet not configured');
    }

    const sequenceNumber = 'sequence_number' in record ? record.sequence_number : 0;

    const txId = await this.storeData(
      record,
      {
        'Record-Type': record.type,
        'Agent-DID': agentDid,
        'Sequence-Number': String(sequenceNumber),
        'Previous-TX': previousTx || '',
      }
    );

    return txId;
  }

  /**
   * Store a SEED document - the behavioral identity
   */
  async storeSeed(
    agentDid: string,
    seed: Seed
  ): Promise<{ txId: string; seedHash: string }> {
    if (!this.wallet) {
      throw new Error('Wallet not configured');
    }

    // Calculate SEED hash for commitment
    const seedJson = JSON.stringify(seed, Object.keys(seed).sort());
    const seedHash = await this.hashString(seedJson);

    const txId = await this.storeData(
      seed,
      {
        'Record-Type': 'seed-document',
        'Agent-DID': agentDid,
        'Seed-Version': seed.version,
        'Seed-Hash': seedHash,
      }
    );

    return { txId, seedHash };
  }

  /**
   * Store data to Arweave with tags.
   */
  private async storeData(data: any, customTags: Record<string, string>): Promise<string> {
    const transaction = await this.arweave.createTransaction(
      { data: JSON.stringify(data, null, 2) },
      this.wallet
    );

    transaction.addTag('App-Name', TAGS.APP_NAME);
    transaction.addTag('App-Version', TAGS.APP_VERSION);
    transaction.addTag('Content-Type', TAGS.CONTENT_TYPE);
    transaction.addTag('Unix-Time', String(Date.now()));

    for (const [key, value] of Object.entries(customTags)) {
      if (value) {
        transaction.addTag(key, value);
      }
    }

    await this.arweave.transactions.sign(transaction, this.wallet);
    const response = await this.arweave.transactions.post(transaction);

    if (response.status !== 200 && response.status !== 202) {
      throw new Error(`Failed to post transaction: ${response.status}`);
    }

    return transaction.id;
  }

  // --------------------------------------------------------------------------
  // RETRIEVAL OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Get genesis delegation by subdomain.
   */
  async getGenesisDelegation(subdomain: string): Promise<GenesisDelegate | null> {
    const query = `
      query {
        transactions(
          tags: [
            { name: "App-Name", values: ["${TAGS.APP_NAME}"] },
            { name: "Record-Type", values: ["genesis-delegation"] },
            { name: "Agent-Subdomain", values: ["${subdomain}"] }
          ],
          first: 1,
          sort: HEIGHT_DESC
        ) {
          edges {
            node {
              id
            }
          }
        }
      }
    `;

    const results = await this.queryArweave(query);
    const edges = results?.data?.transactions?.edges;

    if (!edges || edges.length === 0) {
      return null;
    }

    const txId = edges[0].node.id;
    return await this.fetchTransactionData(txId) as GenesisDelegate;
  }

  /**
   * Get the complete identity chain for an agent.
   */
  async getIdentityChain(agentDid: string): Promise<IdentityRecord[]> {
    const query = `
      query {
        transactions(
          tags: [
            { name: "App-Name", values: ["${TAGS.APP_NAME}"] },
            { name: "Agent-DID", values: ["${agentDid}"] }
          ],
          first: 1000,
          sort: HEIGHT_ASC
        ) {
          edges {
            node {
              id
              tags {
                name
                value
              }
            }
          }
        }
      }
    `;

    const results = await this.queryArweave(query);
    const edges = results?.data?.transactions?.edges;

    if (!edges || edges.length === 0) {
      return [];
    }

    const records: IdentityRecord[] = [];

    for (const edge of edges) {
      const txId = edge.node.id;
      try {
        const data = await this.fetchTransactionData(txId);
        if (data) {
          records.push(data as IdentityRecord);
        }
      } catch (error) {
        console.warn(`Failed to fetch record ${txId}:`, error);
      }
    }

    records.sort((a, b) => {
      const seqA = 'sequence_number' in a ? a.sequence_number : 0;
      const seqB = 'sequence_number' in b ? b.sequence_number : 0;
      return seqA - seqB;
    });

    return records;
  }

  /**
   * Get the latest SEED document for an agent.
   */
  async getLatestSeed(agentDid: string): Promise<Seed | null> {
    const query = `
      query {
        transactions(
          tags: [
            { name: "App-Name", values: ["${TAGS.APP_NAME}"] },
            { name: "Agent-DID", values: ["${agentDid}"] },
            { name: "Record-Type", values: ["seed-document"] }
          ],
          first: 1,
          sort: HEIGHT_DESC
        ) {
          edges {
            node {
              id
            }
          }
        }
      }
    `;

    const results = await this.queryArweave(query);
    const edges = results?.data?.transactions?.edges;

    if (!edges || edges.length === 0) {
      return null;
    }

    const txId = edges[0].node.id;
    return await this.fetchTransactionData(txId) as Seed;
  }

  /**
   * Get all SEED versions for an agent (evolution history).
   */
  async getSeedHistory(agentDid: string): Promise<Array<{ seed: Seed; txId: string }>> {
    const query = `
      query {
        transactions(
          tags: [
            { name: "App-Name", values: ["${TAGS.APP_NAME}"] },
            { name: "Agent-DID", values: ["${agentDid}"] },
            { name: "Record-Type", values: ["seed-document"] }
          ],
          first: 100,
          sort: HEIGHT_ASC
        ) {
          edges {
            node {
              id
            }
          }
        }
      }
    `;

    const results = await this.queryArweave(query);
    const edges = results?.data?.transactions?.edges;

    if (!edges || edges.length === 0) {
      return [];
    }

    const history: Array<{ seed: Seed; txId: string }> = [];

    for (const edge of edges) {
      const txId = edge.node.id;
      try {
        const seed = await this.fetchTransactionData(txId) as Seed;
        if (seed) {
          history.push({ seed, txId });
        }
      } catch (error) {
        console.warn(`Failed to fetch SEED ${txId}:`, error);
      }
    }

    return history;
  }

  /**
   * Check if a delegation has been revoked.
   */
  async isDelegationRevoked(agentDid: string): Promise<boolean> {
    const query = `
      query {
        transactions(
          tags: [
            { name: "App-Name", values: ["${TAGS.APP_NAME}"] },
            { name: "Agent-DID", values: ["${agentDid}"] },
            { name: "Record-Type", values: ["revocation", "self_termination"] }
          ],
          first: 1
        ) {
          edges {
            node {
              id
            }
          }
        }
      }
    `;

    const results = await this.queryArweave(query);
    const edges = results?.data?.transactions?.edges;

    return edges && edges.length > 0;
  }

  /**
   * Get the latest record (chain head) for an agent.
   */
  async getChainHead(agentDid: string): Promise<IdentityRecord | null> {
    const query = `
      query {
        transactions(
          tags: [
            { name: "App-Name", values: ["${TAGS.APP_NAME}"] },
            { name: "Agent-DID", values: ["${agentDid}"] }
          ],
          first: 1,
          sort: HEIGHT_DESC
        ) {
          edges {
            node {
              id
            }
          }
        }
      }
    `;

    const results = await this.queryArweave(query);
    const edges = results?.data?.transactions?.edges;

    if (!edges || edges.length === 0) {
      return null;
    }

    const txId = edges[0].node.id;
    return await this.fetchTransactionData(txId) as IdentityRecord;
  }

  // --------------------------------------------------------------------------
  // UTILITY METHODS
  // --------------------------------------------------------------------------

  private async queryArweave(query: string): Promise<any> {
    const response = await fetch('https://arweave.net/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`Arweave query failed: ${response.status}`);
    }

    return response.json();
  }

  private async fetchTransactionData(txId: string): Promise<any> {
    const response = await fetch(`https://arweave.net/${txId}`);

    if (!response.ok) {
      throw new Error(`Failed to fetch transaction ${txId}: ${response.status}`);
    }

    return response.json();
  }

  async getTransactionStatus(txId: string): Promise<{ confirmed: boolean; block?: number }> {
    const status = await this.arweave.transactions.getStatus(txId);

    return {
      confirmed: status.status === 200,
      block: status.confirmed?.block_height,
    };
  }

  private async hashString(str: string): Promise<string> {
    const { sha256 } = await import('@noble/hashes/sha256');
    const { bytesToHex, utf8ToBytes } = await import('@noble/hashes/utils');
    return bytesToHex(sha256(utf8ToBytes(str)));
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

export function createArweaveStorage(wallet?: any): ArweaveIdentityStorage {
  return new ArweaveIdentityStorage(wallet);
}

export async function agentIdentityExists(subdomain: string): Promise<boolean> {
  const storage = createArweaveStorage();
  const delegation = await storage.getGenesisDelegation(subdomain);
  return delegation !== null;
}

export async function agentIdentityActive(agentDid: string): Promise<boolean> {
  const storage = createArweaveStorage();
  const revoked = await storage.isDelegationRevoked(agentDid);
  return !revoked;
}

export default ArweaveIdentityStorage;
