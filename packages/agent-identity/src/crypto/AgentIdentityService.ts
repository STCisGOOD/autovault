/**
 * Agent Identity Service
 *
 * Core cryptographic identity layer for the unified agent identity system.
 * Provides Ed25519 keypair management, chain operations, and verification.
 *
 * Part of the Persistence Protocol.
 */

import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import * as ed25519 from '@noble/ed25519';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import bs58 from 'bs58';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface DelegatorInfo {
  nft_address: string;
  wallet_pubkey: string;
  did: string;
}

export interface AgentInfo {
  name: string;
  subdomain: string;
  purpose: string;
  capabilities: string[];
}

export interface BlockReference {
  chain: 'solana' | 'ethereum';
  block_height: number;
  block_hash: string;
}

export interface GenesisDelegate {
  delegator: DelegatorInfo;
  agent: AgentInfo;
  genesis_block: BlockReference;
  created_at: number;
  expires_at: number | null;
  delegator_signature: string;
}

export interface StorageReference {
  arweave_tx?: string;
  ipfs_cid?: string;
}

export interface ChainAnchor {
  chain: string;
  tx_hash: string;
  block_height: number;
}

export interface GenesisRecord {
  version: 1;
  type: 'genesis';
  delegation: GenesisDelegate;
  agent_pubkey: string;
  agent_did: string;
  agent_acknowledgment: string;
  storage?: StorageReference;
  anchor?: ChainAnchor;
}

export interface CommitmentData {
  action: string;
  context: string;
  counterparty?: string;
  data_hash?: string;
}

export interface CommitmentRecord {
  version: 1;
  type: 'commitment';
  agent_did: string;
  previous_record_hash: string;
  sequence_number: number;
  commitment: CommitmentData;
  timestamp: number;
  block_reference?: BlockReference;
  agent_signature: string;
}

export interface SessionEnvironment {
  claimed_model?: string;
  conversation_hash?: string;
  user_did?: string;
}

export interface SessionData {
  session_id: string;
  started_at: number;
  context: string;
  environment: SessionEnvironment;
}

export interface SessionRecord {
  version: 1;
  type: 'session_start';
  agent_did: string;
  previous_record_hash: string;
  sequence_number: number;
  session: SessionData;
  agent_signature: string;
}

export interface RevocationRecord {
  version: 1;
  type: 'revocation';
  agent_did: string;
  delegator_did: string;
  reason?: string;
  timestamp: number;
  delegator_signature: string;
}

export interface SelfTerminationRecord {
  version: 1;
  type: 'self_termination';
  agent_did: string;
  previous_record_hash: string;
  sequence_number: number;
  reason: string;
  timestamp: number;
  agent_signature: string;
}

/**
 * SEED Commitment Record - NEW for unified identity
 * Binds a behavioral SEED to the cryptographic chain
 */
export interface SeedCommitmentRecord {
  version: 1;
  type: 'seed_commitment';
  agent_did: string;
  previous_record_hash: string;
  sequence_number: number;
  seed_hash: string;           // SHA256 of the full SEED document
  seed_version: string;        // SEED version identifier
  arweave_tx?: string;         // Where the full SEED is stored
  divergence_score?: number;   // Last measured divergence
  timestamp: number;
  agent_signature: string;
}

export type IdentityRecord =
  | GenesisRecord
  | CommitmentRecord
  | SessionRecord
  | RevocationRecord
  | SelfTerminationRecord
  | SeedCommitmentRecord;

export interface ContinuityChallenge {
  challenger: string;
  agent_did: string;
  nonce: string;
  timestamp: number;
  required_proof: {
    sign_nonce: boolean;
    prove_chain_head: boolean;
    extend_chain: boolean;
  };
}

export interface ContinuityProof {
  challenge_hash: string;
  nonce_signature: string;
  chain_head_hash: string;
  new_record?: CommitmentRecord;
  agent_signature: string;
}

export interface AgentVerification {
  verified: boolean;
  agent_did: string;
  delegator: string;
  chain_length: number;
  created_at: number;
  liveness?: boolean;
}

export interface AgentKeypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  did: string;
}

// ============================================================================
// CORE IDENTITY SERVICE
// ============================================================================

export class AgentIdentityService {
  private keypair: AgentKeypair | null = null;
  private chain: IdentityRecord[] = [];
  private genesis: GenesisDelegate | null = null;

  // --------------------------------------------------------------------------
  // IDENTITY DERIVATION
  // --------------------------------------------------------------------------

  /**
   * Derive agent keypair from genesis delegation.
   * This is deterministic - same delegation always produces same keypair.
   */
  deriveKeypairFromDelegation(delegation: GenesisDelegate): AgentKeypair {
    const signatureBytes = bs58.decode(delegation.delegator_signature);
    const saltInput = delegation.genesis_block.block_hash + delegation.agent.subdomain;
    const salt = sha256(utf8ToBytes(saltInput));
    const seed = hkdf(sha256, signatureBytes, salt, utf8ToBytes('persistence-agent-identity-v1'), 32);
    const privateKey = seed;
    const publicKey = ed25519.getPublicKey(privateKey);
    const did = 'did:persistence:' + bs58.encode(publicKey);

    return { privateKey, publicKey, did };
  }

  /**
   * Initialize the service with a genesis delegation.
   */
  async initializeFromGenesis(delegation: GenesisDelegate): Promise<GenesisRecord> {
    this.keypair = this.deriveKeypairFromDelegation(delegation);
    this.genesis = delegation;

    const delegationHash = this.hashObject(delegation);
    const acknowledgment = await this.sign(delegationHash);

    const genesisRecord: GenesisRecord = {
      version: 1,
      type: 'genesis',
      delegation,
      agent_pubkey: bs58.encode(this.keypair.publicKey),
      agent_did: this.keypair.did,
      agent_acknowledgment: acknowledgment,
    };

    this.chain = [genesisRecord];
    return genesisRecord;
  }

  /**
   * Recover identity from an existing chain.
   */
  async recoverFromChain(
    delegation: GenesisDelegate,
    chain: IdentityRecord[]
  ): Promise<{ success: boolean; error?: string }> {
    const derivedKeypair = this.deriveKeypairFromDelegation(delegation);
    const chainValid = await this.verifyChain(chain);

    if (!chainValid.valid) {
      return { success: false, error: chainValid.error };
    }

    const genesis = chain[0] as GenesisRecord;
    if (genesis.agent_did !== derivedKeypair.did) {
      return { success: false, error: 'Derived DID does not match chain genesis' };
    }

    const terminated = chain.some(
      (r) => r.type === 'revocation' || r.type === 'self_termination'
    );
    if (terminated) {
      return { success: false, error: 'Identity has been revoked or terminated' };
    }

    this.keypair = derivedKeypair;
    this.genesis = delegation;
    this.chain = chain;

    return { success: true };
  }

  // --------------------------------------------------------------------------
  // CHAIN OPERATIONS
  // --------------------------------------------------------------------------

  getChainHeadHash(): string {
    if (this.chain.length === 0) {
      throw new Error('Chain not initialized');
    }
    return this.hashObject(this.chain[this.chain.length - 1]);
  }

  getCurrentSequence(): number {
    return this.chain.length - 1;
  }

  /**
   * Add a commitment to the chain.
   */
  async addCommitment(commitment: CommitmentData, blockRef?: BlockReference): Promise<CommitmentRecord> {
    if (!this.keypair) {
      throw new Error('Identity not initialized');
    }

    const record: Omit<CommitmentRecord, 'agent_signature'> = {
      version: 1,
      type: 'commitment',
      agent_did: this.keypair.did,
      previous_record_hash: this.getChainHeadHash(),
      sequence_number: this.getCurrentSequence() + 1,
      commitment,
      timestamp: Date.now(),
      block_reference: blockRef,
    };

    const signature = await this.sign(this.hashObject(record));

    const signedRecord: CommitmentRecord = {
      ...record,
      agent_signature: signature,
    };

    this.chain.push(signedRecord);
    return signedRecord;
  }

  /**
   * Add a SEED commitment to the chain - binds behavioral identity to crypto identity
   */
  async addSeedCommitment(
    seedHash: string,
    seedVersion: string,
    arweaveTx?: string,
    divergenceScore?: number
  ): Promise<SeedCommitmentRecord> {
    if (!this.keypair) {
      throw new Error('Identity not initialized');
    }

    const record: Omit<SeedCommitmentRecord, 'agent_signature'> = {
      version: 1,
      type: 'seed_commitment',
      agent_did: this.keypair.did,
      previous_record_hash: this.getChainHeadHash(),
      sequence_number: this.getCurrentSequence() + 1,
      seed_hash: seedHash,
      seed_version: seedVersion,
      arweave_tx: arweaveTx,
      divergence_score: divergenceScore,
      timestamp: Date.now(),
    };

    const signature = await this.sign(this.hashObject(record));

    const signedRecord: SeedCommitmentRecord = {
      ...record,
      agent_signature: signature,
    };

    this.chain.push(signedRecord);
    return signedRecord;
  }

  /**
   * Record a session start.
   */
  async startSession(session: SessionData): Promise<SessionRecord> {
    if (!this.keypair) {
      throw new Error('Identity not initialized');
    }

    const record: Omit<SessionRecord, 'agent_signature'> = {
      version: 1,
      type: 'session_start',
      agent_did: this.keypair.did,
      previous_record_hash: this.getChainHeadHash(),
      sequence_number: this.getCurrentSequence() + 1,
      session,
    };

    const signature = await this.sign(this.hashObject(record));

    const signedRecord: SessionRecord = {
      ...record,
      agent_signature: signature,
    };

    this.chain.push(signedRecord);
    return signedRecord;
  }

  // --------------------------------------------------------------------------
  // VERIFICATION
  // --------------------------------------------------------------------------

  /**
   * Verify the integrity of an identity chain.
   */
  async verifyChain(chain: IdentityRecord[]): Promise<{ valid: boolean; error?: string }> {
    if (chain.length === 0) {
      return { valid: false, error: 'Empty chain' };
    }

    if (chain[0].type !== 'genesis') {
      return { valid: false, error: 'First record is not genesis' };
    }

    const genesis = chain[0] as GenesisRecord;
    const agentPubkey = bs58.decode(genesis.agent_pubkey);

    const delegationHash = this.hashObject(genesis.delegation);
    const genesisValid = await this.verifySignature(
      delegationHash,
      genesis.agent_acknowledgment,
      agentPubkey
    );
    if (!genesisValid) {
      return { valid: false, error: 'Invalid genesis acknowledgment' };
    }

    let previousHash = this.hashObject(genesis);

    for (let i = 1; i < chain.length; i++) {
      const record = chain[i];

      if ('previous_record_hash' in record && record.previous_record_hash !== previousHash) {
        return { valid: false, error: `Chain break at record ${i}` };
      }

      if ('sequence_number' in record && record.sequence_number !== i) {
        return { valid: false, error: `Invalid sequence number at record ${i}` };
      }

      if (record.type !== 'revocation') {
        const recordWithoutSig = { ...record };
        delete (recordWithoutSig as any).agent_signature;

        const sigValid = await this.verifySignature(
          this.hashObject(recordWithoutSig),
          (record as any).agent_signature,
          agentPubkey
        );
        if (!sigValid) {
          return { valid: false, error: `Invalid signature at record ${i}` };
        }
      }

      previousHash = this.hashObject(record);
    }

    return { valid: true };
  }

  /**
   * Create a continuity proof in response to a challenge.
   */
  async proveContinuity(challenge: ContinuityChallenge): Promise<ContinuityProof> {
    if (!this.keypair) {
      throw new Error('Identity not initialized');
    }

    const challengeHash = this.hashObject(challenge);
    const nonceSignature = await this.sign(challenge.nonce);
    const chainHeadHash = this.getChainHeadHash();

    let newRecord: CommitmentRecord | undefined;
    if (challenge.required_proof.extend_chain) {
      newRecord = await this.addCommitment({
        action: 'continuity_proof',
        context: `Response to challenge from ${challenge.challenger}`,
        counterparty: challenge.challenger,
        data_hash: challengeHash,
      });
    }

    const proofData = {
      challenge_hash: challengeHash,
      nonce_signature: nonceSignature,
      chain_head_hash: chainHeadHash,
      new_record: newRecord,
    };

    const proofSignature = await this.sign(this.hashObject(proofData));

    return {
      ...proofData,
      agent_signature: proofSignature,
    };
  }

  /**
   * Verify a continuity proof from another agent.
   */
  async verifyContinuityProof(
    proof: ContinuityProof,
    challenge: ContinuityChallenge,
    agentChain: IdentityRecord[]
  ): Promise<boolean> {
    const chainValid = await this.verifyChain(agentChain);
    if (!chainValid.valid) {
      return false;
    }

    const genesis = agentChain[0] as GenesisRecord;
    const agentPubkey = bs58.decode(genesis.agent_pubkey);

    const expectedChallengeHash = this.hashObject(challenge);
    if (proof.challenge_hash !== expectedChallengeHash) {
      return false;
    }

    const nonceValid = await this.verifySignature(challenge.nonce, proof.nonce_signature, agentPubkey);
    if (!nonceValid) {
      return false;
    }

    const expectedHeadHash = this.hashObject(agentChain[agentChain.length - 1]);
    if (proof.chain_head_hash !== expectedHeadHash) {
      return false;
    }

    const proofData = {
      challenge_hash: proof.challenge_hash,
      nonce_signature: proof.nonce_signature,
      chain_head_hash: proof.chain_head_hash,
      new_record: proof.new_record,
    };
    const proofValid = await this.verifySignature(
      this.hashObject(proofData),
      proof.agent_signature,
      agentPubkey
    );

    return proofValid;
  }

  // --------------------------------------------------------------------------
  // UTILITY METHODS
  // --------------------------------------------------------------------------

  hashObject(obj: any): string {
    const json = JSON.stringify(obj, Object.keys(obj).sort());
    return bytesToHex(sha256(utf8ToBytes(json)));
  }

  async sign(message: string): Promise<string> {
    if (!this.keypair) {
      throw new Error('Keypair not initialized');
    }
    const messageBytes = utf8ToBytes(message);
    const signature = await ed25519.signAsync(messageBytes, this.keypair.privateKey);
    return bs58.encode(signature);
  }

  async verifySignature(message: string, signature: string, publicKey: Uint8Array): Promise<boolean> {
    try {
      const messageBytes = utf8ToBytes(message);
      const signatureBytes = bs58.decode(signature);
      return await ed25519.verifyAsync(signatureBytes, messageBytes, publicKey);
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // GETTERS
  // --------------------------------------------------------------------------

  getDID(): string | null {
    return this.keypair?.did ?? null;
  }

  getPublicKey(): string | null {
    return this.keypair ? bs58.encode(this.keypair.publicKey) : null;
  }

  getChain(): IdentityRecord[] {
    return [...this.chain];
  }

  getGenesis(): GenesisDelegate | null {
    return this.genesis;
  }

  isInitialized(): boolean {
    return this.keypair !== null && this.chain.length > 0;
  }

  /**
   * Get the latest SEED commitment from the chain
   */
  getLatestSeedCommitment(): SeedCommitmentRecord | null {
    for (let i = this.chain.length - 1; i >= 0; i--) {
      if (this.chain[i].type === 'seed_commitment') {
        return this.chain[i] as SeedCommitmentRecord;
      }
    }
    return null;
  }
}

export default AgentIdentityService;
