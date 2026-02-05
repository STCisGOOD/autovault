/**
 * Genesis Protocol
 *
 * Handles the creation of new agent identities through the genesis delegation flow.
 * This is the "birth" of an agent - a human delegator creates a signed delegation
 * that allows an agent to derive its cryptographic identity.
 *
 * Flow:
 * 1. Delegator creates delegation with agent info
 * 2. Delegation is signed by delegator's wallet
 * 3. Agent derives keypair from delegation signature
 * 4. Agent acknowledges delegation by signing it
 * 5. Genesis record is created and stored
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import bs58 from 'bs58';
import type {
  GenesisDelegate,
  DelegatorInfo,
  AgentInfo,
  BlockReference,
  GenesisRecord,
} from './AgentIdentityService';
import { AgentIdentityService } from './AgentIdentityService';
import { SolanaIdentityStorage } from './SolanaIdentityStorage';
import type { Seed } from '../behavioral/PersistenceProtocol';

// ============================================================================
// GENESIS PROTOCOL
// ============================================================================

export interface GenesisConfig {
  solanaConnection: Connection;
  payer?: Keypair;
  network: 'devnet' | 'mainnet';
}

export interface GenesisResult {
  success: boolean;
  agentDid?: string;
  genesisRecord?: GenesisRecord;
  solanaTxs?: {
    delegation: string;
    genesis: string;
    seed?: string;
  };
  error?: string;
}

export class GenesisProtocol {
  private connection: Connection;
  private storage: SolanaIdentityStorage;
  private network: 'devnet' | 'mainnet';

  constructor(config: GenesisConfig) {
    this.connection = config.solanaConnection;
    this.storage = new SolanaIdentityStorage({
      connection: config.solanaConnection,
      payer: config.payer
    });
    this.network = config.network;
  }

  /**
   * Set the payer keypair for storage operations.
   */
  setPayer(payer: Keypair): void {
    this.storage.setPayer(payer);
  }

  /**
   * Create a genesis delegation (to be signed by delegator).
   */
  async createDelegation(
    delegator: DelegatorInfo,
    agent: AgentInfo,
    expiresAt?: number
  ): Promise<Omit<GenesisDelegate, 'delegator_signature'>> {
    // Get current block for anchoring
    const slot = await this.connection.getSlot();
    const block = await this.connection.getBlock(slot, {
      maxSupportedTransactionVersion: 0,
    });

    if (!block) {
      throw new Error('Failed to fetch current block');
    }

    const genesisBlock: BlockReference = {
      chain: 'solana',
      block_height: slot,
      block_hash: block.blockhash,
    };

    return {
      delegator,
      agent,
      genesis_block: genesisBlock,
      created_at: Date.now(),
      expires_at: expiresAt ?? null,
    };
  }

  /**
   * Complete genesis after delegator signs the delegation.
   * This creates the agent identity and stores it permanently.
   */
  async completeGenesis(
    signedDelegation: GenesisDelegate,
    initialSeed?: Seed
  ): Promise<GenesisResult> {
    try {
      // Verify delegator signature
      const isValidSignature = await this.verifyDelegatorSignature(signedDelegation);
      if (!isValidSignature) {
        return { success: false, error: 'Invalid delegator signature' };
      }

      // Initialize agent identity
      const identityService = new AgentIdentityService();
      const genesisRecord = await identityService.initializeFromGenesis(signedDelegation);

      // Store on Solana
      const { delegationTx, genesisTx } = await this.storage.storeGenesis(
        signedDelegation,
        genesisRecord
      );

      let seedTx: string | undefined;

      // If initial SEED provided, store it and create commitment
      if (initialSeed) {
        const { txId, seedHash } = await this.storage.storeSeed(
          genesisRecord.agent_did,
          initialSeed
        );
        seedTx = txId;

        // Create SEED commitment in the identity chain
        await identityService.addSeedCommitment(
          seedHash,
          initialSeed.version,
          txId
        );

        // Store the commitment record
        const latestCommitment = identityService.getLatestSeedCommitment();
        if (latestCommitment) {
          await this.storage.appendRecord(
            genesisRecord.agent_did,
            latestCommitment
          );
        }
      }

      return {
        success: true,
        agentDid: genesisRecord.agent_did,
        genesisRecord,
        solanaTxs: {
          delegation: delegationTx,
          genesis: genesisTx,
          seed: seedTx,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error during genesis',
      };
    }
  }

  /**
   * Verify the delegator's signature on a delegation.
   */
  private async verifyDelegatorSignature(delegation: GenesisDelegate): Promise<boolean> {
    try {
      // Create the message that was signed (delegation without signature)
      const { delegator_signature, ...delegationWithoutSig } = delegation;
      const message = JSON.stringify(delegationWithoutSig, Object.keys(delegationWithoutSig).sort());
      const messageBytes = utf8ToBytes(message);

      // Decode signature and public key
      const signatureBytes = bs58.decode(delegator_signature);
      const pubkeyBytes = bs58.decode(delegation.delegator.wallet_pubkey);

      // Verify using Ed25519
      const { verify } = await import('@noble/ed25519');
      return await verify(signatureBytes, messageBytes, pubkeyBytes);
    } catch (error) {
      console.error('Signature verification failed:', error);
      return false;
    }
  }

  /**
   * Create a self-signed delegation for testing/devnet.
   * In production, delegations come from human delegators.
   */
  async createSelfSignedDelegation(
    walletKeypair: { publicKey: Uint8Array; secretKey: Uint8Array },
    agent: AgentInfo,
    nftAddress?: string
  ): Promise<GenesisDelegate> {
    const walletPubkey = bs58.encode(walletKeypair.publicKey);
    const walletDid = 'did:persistence:' + walletPubkey;

    const delegator: DelegatorInfo = {
      nft_address: nftAddress || 'self-signed',
      wallet_pubkey: walletPubkey,
      did: walletDid,
    };

    const delegationWithoutSig = await this.createDelegation(delegator, agent);

    // Sign the delegation
    const message = JSON.stringify(delegationWithoutSig, Object.keys(delegationWithoutSig).sort());
    const messageBytes = utf8ToBytes(message);

    const { sign } = await import('@noble/ed25519');
    const signature = await sign(messageBytes, walletKeypair.secretKey.slice(0, 32));

    return {
      ...delegationWithoutSig,
      delegator_signature: bs58.encode(signature),
    };
  }

  /**
   * Verify that an agent identity exists and is valid.
   */
  async verifyAgentExists(agentDid: string): Promise<{
    exists: boolean;
    active: boolean;
    chainLength?: number;
    latestSeedVersion?: string;
  }> {
    const chain = await this.storage.getIdentityChain(agentDid);

    if (chain.length === 0) {
      return { exists: false, active: false };
    }

    const revoked = await this.storage.isDelegationRevoked(agentDid);
    const latestSeed = await this.storage.getLatestSeed(agentDid);

    return {
      exists: true,
      active: !revoked,
      chainLength: chain.length,
      latestSeedVersion: latestSeed?.version,
    };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate a unique subdomain for an agent.
 */
export function generateAgentSubdomain(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const suffix = Math.random().toString(36).substring(2, 8);
  return `${normalized}-${suffix}`;
}

/**
 * Create a hash of delegation data for signing.
 */
export function hashDelegation(delegation: Omit<GenesisDelegate, 'delegator_signature'>): string {
  const json = JSON.stringify(delegation, Object.keys(delegation).sort());
  return bytesToHex(sha256(utf8ToBytes(json)));
}

export default GenesisProtocol;
