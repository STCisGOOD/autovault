/**
 * AnchorStorageBackend.ts
 *
 * Storage backend implementation using the Anchor program for on-chain identity storage.
 *
 * Replaces the Memo-based storage with a proper PDA-based account structure that stores:
 * - Identity weights and self-model
 * - Declaration chain with cryptographic signatures
 * - Pivotal experience hashes
 * - Continuity proofs
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import {
  type StoredSelf,
  type SelfState,
  type Declaration,
  type Vocabulary,
  type DynamicsParams,
  type ContinuityProof,
  type PivotalExperience,
} from '../behavioral/FixedPointSelf';

// =============================================================================
// ANCHOR-SPECIFIC TYPES
// =============================================================================

/**
 * Result of loading identity from the Anchor program.
 */
export interface AnchorLoadResult {
  found: boolean;
  self: StoredSelf | null;
  error?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Program ID for the agent identity Anchor program.
 * Deployed to Solana devnet on 2026-02-04.
 */
export const AGENT_IDENTITY_PROGRAM_ID = new PublicKey(
  '83vBR6Rftwvisr4JdjYwnWskFx2uNfkA6K9SjHu69fxf'
);

/**
 * Maximum dimensions supported by the on-chain program.
 */
export const MAX_DIMENSIONS = 16;

/**
 * Maximum stored declarations on-chain.
 * Reduced from 32 to 4 to fit within account size limits.
 */
export const MAX_STORED_DECLARATIONS = 4;

/**
 * Weight scaling factor (0.5 = 5000, 1.0 = 10000).
 */
export const WEIGHT_SCALE = 10000;

// =============================================================================
// TYPES
// =============================================================================

export interface AnchorStorageConfig {
  /** Solana RPC connection */
  readonly connection: Connection;

  /** Payer keypair for transactions */
  readonly payer: Keypair;

  /** Program ID (uses default if not specified) */
  readonly programId?: PublicKey;

  /** Enable debug logging */
  readonly debug?: boolean;
}

export interface OnChainIdentity {
  authority: PublicKey;
  bump: number;
  dimensionCount: number;
  vocabularyHash: Uint8Array;
  dimensionNames: string[];
  weights: number[];
  selfModel: number[];
  time: number;
  declarationCount: number;
  declarations: OnChainDeclaration[];
  genesisHash: Uint8Array;
  currentHash: Uint8Array;
  merkleRoot: Uint8Array;
  pivotalCount: number;
  pivotalHashes: Uint8Array[];
  pivotalImpacts: number[];
  pivotalTimestamps: number[];
  continuityScore: number;
  coherenceScore: number;
  stabilityScore: number;
  createdAt: number;
  updatedAt: number;
}

export interface OnChainDeclaration {
  index: number;
  value: number;
  timestamp: number;
  previousHash: Uint8Array;
  signature: Uint8Array;
  contentHash: Uint8Array;
}

// =============================================================================
// ANCHOR STORAGE BACKEND
// =============================================================================

/**
 * Storage backend using the Anchor program for on-chain identity storage.
 *
 * Note: This implements a specialized on-chain storage API, not the generic
 * StorageBackend interface. Use AnchorStorageBackend directly for full
 * on-chain identity management.
 */
export class AnchorStorageBackend {
  private readonly connection: Connection;
  private readonly payer: Keypair;
  private readonly programId: PublicKey;
  private readonly debug: boolean;

  private identityPDA: PublicKey | null = null;
  private identityBump: number | null = null;

  constructor(config: AnchorStorageConfig) {
    this.connection = config.connection;
    this.payer = config.payer;
    this.programId = config.programId || AGENT_IDENTITY_PROGRAM_ID;
    this.debug = config.debug || false;
  }

  /**
   * Get the PDA for the identity account.
   */
  private async getIdentityPDA(): Promise<[PublicKey, number]> {
    if (this.identityPDA && this.identityBump !== null) {
      return [this.identityPDA, this.identityBump];
    }

    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent-identity'), this.payer.publicKey.toBuffer()],
      this.programId
    );

    this.identityPDA = pda;
    this.identityBump = bump;

    return [pda, bump];
  }

  /**
   * Check if an identity account exists.
   */
  async exists(): Promise<boolean> {
    const [pda] = await this.getIdentityPDA();
    const account = await this.connection.getAccountInfo(pda);
    return account !== null;
  }

  /**
   * Load identity from the Anchor program.
   */
  async load(): Promise<AnchorLoadResult> {
    const [pda] = await this.getIdentityPDA();
    const account = await this.connection.getAccountInfo(pda);

    if (!account) {
      return {
        found: false,
        self: null,
        error: 'No identity account found on-chain',
      };
    }

    try {
      const identity = this.deserializeIdentity(account.data);
      const storedSelf = this.onChainToStoredSelf(identity);

      if (this.debug) {
        console.log(`[AnchorStorage] Loaded identity: ${identity.dimensionCount} dimensions, ${identity.declarationCount} declarations`);
      }

      return {
        found: true,
        self: storedSelf,
      };
    } catch (error) {
      return {
        found: true,
        self: null,
        error: `Failed to deserialize identity: ${error}`,
      };
    }
  }

  /**
   * Save identity to the Anchor program.
   */
  async save(self: StoredSelf): Promise<void> {
    const exists = await this.exists();

    if (!exists) {
      await this.initialize(self);
    } else {
      await this.updateDeclarations(self);
    }
  }

  /**
   * Initialize a new identity account.
   */
  private async initialize(self: StoredSelf): Promise<void> {
    const [pda, bump] = await this.getIdentityPDA();

    // Prepare dimension names
    const dimensionNames = self.vocabulary.assertions.map(a => a.slice(0, 32));

    // Prepare initial weights (scaled)
    const initialWeights = Array.from(self.currentState.w).map(w =>
      Math.round(w * WEIGHT_SCALE)
    );

    // Compute vocabulary hash
    const vocabHash = this.computeVocabularyHash(self.vocabulary);

    // Build initialize instruction
    const ix = await this.buildInitializeInstruction(
      pda,
      bump,
      dimensionNames,
      initialWeights,
      vocabHash
    );

    // Send transaction
    const tx = new Transaction().add(ix);
    tx.feePayer = this.payer.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    tx.sign(this.payer);

    const sig = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction(sig, 'confirmed');

    if (this.debug) {
      console.log(`[AnchorStorage] Initialized identity: ${sig}`);
    }

    // Add declarations if any
    if (self.declarations.length > 0) {
      await this.updateDeclarations(self);
    }
  }

  /**
   * Update declarations on-chain.
   */
  private async updateDeclarations(self: StoredSelf): Promise<void> {
    const [pda] = await this.getIdentityPDA();

    // Get current on-chain state to know which declarations to add
    const currentResult = await this.load();
    const existingCount = currentResult.found && currentResult.self
      ? currentResult.self.declarations.length
      : 0;

    // Add new declarations
    const newDeclarations = self.declarations.slice(existingCount);

    for (const decl of newDeclarations) {
      const ix = this.buildDeclareInstruction(pda, decl);
      const tx = new Transaction().add(ix);
      tx.feePayer = this.payer.publicKey;
      tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

      tx.sign(this.payer);

      const sig = await this.connection.sendRawTransaction(tx.serialize());
      await this.connection.confirmTransaction(sig, 'confirmed');

      if (this.debug) {
        console.log(`[AnchorStorage] Declaration recorded: ${sig}`);
      }
    }

    // Record pivotal experiences
    const existingPivotalCount = currentResult.found && currentResult.self
      ? currentResult.self.pivotalExperiences.length
      : 0;

    const newPivotals = self.pivotalExperiences.slice(existingPivotalCount);

    for (const pivotal of newPivotals) {
      const ix = this.buildRecordPivotalInstruction(pda, pivotal);
      const tx = new Transaction().add(ix);
      tx.feePayer = this.payer.publicKey;
      tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

      tx.sign(this.payer);

      const sig = await this.connection.sendRawTransaction(tx.serialize());
      await this.connection.confirmTransaction(sig, 'confirmed');

      if (this.debug) {
        console.log(`[AnchorStorage] Pivotal experience recorded: ${sig}`);
      }
    }
  }

  /**
   * Close the identity account and recover rent.
   */
  async close(): Promise<void> {
    const [pda] = await this.getIdentityPDA();

    const ix = this.buildCloseInstruction(pda);
    const tx = new Transaction().add(ix);
    tx.feePayer = this.payer.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    tx.sign(this.payer);

    const sig = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction(sig, 'confirmed');

    if (this.debug) {
      console.log(`[AnchorStorage] Identity account closed: ${sig}`);
    }
  }

  // ===========================================================================
  // INSTRUCTION BUILDERS
  // ===========================================================================

  /**
   * Build the initialize instruction.
   */
  private async buildInitializeInstruction(
    pda: PublicKey,
    _bump: number,
    dimensionNames: string[],
    initialWeights: number[],
    vocabularyHash: Uint8Array
  ): Promise<TransactionInstruction> {
    // Discriminator for "initialize" instruction
    const discriminator = sha256(Buffer.from('global:initialize')).slice(0, 8);

    // Serialize instruction data
    const data = Buffer.concat([
      Buffer.from(discriminator),
      this.serializeVec(dimensionNames.map(n => Buffer.from(n))),
      this.serializeVec(initialWeights.map(w => this.serializeU64(w))),
      Buffer.from(vocabularyHash),
    ]);

    return new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data,
    });
  }

  /**
   * Build the declare instruction.
   */
  private buildDeclareInstruction(
    pda: PublicKey,
    declaration: Declaration
  ): TransactionInstruction {
    const discriminator = sha256(Buffer.from('global:declare')).slice(0, 8);

    // Extract signature bytes
    let sigBytes: Uint8Array;
    if (declaration.signature.startsWith('ed25519:')) {
      sigBytes = hexToBytes(declaration.signature.slice('ed25519:'.length));
    } else if (declaration.signature.startsWith('hash:')) {
      // Pad hash to 64 bytes for compatibility
      const hashBytes = hexToBytes(declaration.signature.slice('hash:'.length));
      sigBytes = new Uint8Array(64);
      sigBytes.set(hashBytes);
    } else {
      sigBytes = new Uint8Array(64);
    }

    // Hash the content for on-chain storage (content_hash: [u8; 32])
    const contentHash = sha256(Buffer.from(declaration.content));

    const data = Buffer.concat([
      Buffer.from(discriminator),
      Buffer.from([declaration.index]),
      this.serializeU64(Math.round(declaration.value * WEIGHT_SCALE)),
      Buffer.from(contentHash),
      Buffer.from(sigBytes),
    ]);

    return new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: false },
      ],
      programId: this.programId,
      data,
    });
  }

  /**
   * Build the record_pivotal instruction.
   */
  private buildRecordPivotalInstruction(
    pda: PublicKey,
    pivotal: PivotalExperience
  ): TransactionInstruction {
    const discriminator = sha256(Buffer.from('global:record_pivotal')).slice(0, 8);

    // Compute experience hash
    const expHash = sha256(Buffer.from(pivotal.experienceHash));

    const data = Buffer.concat([
      Buffer.from(discriminator),
      Buffer.from(expHash),
      this.serializeU64(Math.round(pivotal.impactMagnitude * WEIGHT_SCALE)),
    ]);

    return new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: false },
      ],
      programId: this.programId,
      data,
    });
  }

  /**
   * Build the evolve instruction — update on-chain weights with ARIL delta.
   * Sends new weights and a timestamp for the evolution step.
   */
  buildEvolveInstruction(
    pda: PublicKey,
    newWeights: number[],
    fitness?: number[]
  ): TransactionInstruction {
    const discriminator = sha256(Buffer.from('global:evolve')).slice(0, 8);

    // Serialize weights as Vec<i64> (signed, scaled)
    const weightBuffers = newWeights.map(w => {
      const buf = Buffer.alloc(8);
      buf.writeBigInt64LE(BigInt(Math.round(w * WEIGHT_SCALE)));
      return buf;
    });

    const parts: Buffer[] = [
      Buffer.from(discriminator),
      this.serializeVec(weightBuffers),
      this.serializeU64(Date.now()),
    ];

    // Optional: append fitness scores if provided
    if (fitness && fitness.length > 0) {
      const fitnessBuffers = fitness.map(f => {
        const buf = Buffer.alloc(8);
        buf.writeBigInt64LE(BigInt(Math.round(f * WEIGHT_SCALE)));
        return buf;
      });
      parts.push(this.serializeVec(fitnessBuffers));
    }

    const data = Buffer.concat(parts);

    return new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: false },
      ],
      programId: this.programId,
      data,
    });
  }

  /**
   * Build a verify instruction — read-only integrity check via simulateTransaction.
   * Returns whether on-chain state matches expected hash.
   */
  async verify(expectedMerkleRoot?: string): Promise<{
    valid: boolean;
    onChainRoot: string;
    error?: string;
  }> {
    const result = await this.load();
    if (!result.found || !result.self) {
      return { valid: false, onChainRoot: '', error: result.error || 'No identity on-chain' };
    }

    const onChainRoot = result.self.continuityProof.merkleRoot;

    if (expectedMerkleRoot) {
      const valid = onChainRoot === expectedMerkleRoot;
      return {
        valid,
        onChainRoot,
        error: valid ? undefined : `Merkle root mismatch: expected ${expectedMerkleRoot.slice(0, 16)}..., got ${onChainRoot.slice(0, 16)}...`,
      };
    }

    return { valid: true, onChainRoot };
  }

  /**
   * Evolve weights on-chain using ARIL update.
   */
  async evolve(newWeights: number[], fitness?: number[]): Promise<string> {
    const [pda] = await this.getIdentityPDA();
    const ix = this.buildEvolveInstruction(pda, newWeights, fitness);

    const tx = new Transaction().add(ix);
    tx.feePayer = this.payer.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    tx.sign(this.payer);

    const sig = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction(sig, 'confirmed');

    if (this.debug) {
      console.log(`[AnchorStorage] Evolved weights: ${sig}`);
    }

    return sig;
  }

  /**
   * Build the close instruction.
   */
  private buildCloseInstruction(pda: PublicKey): TransactionInstruction {
    const discriminator = sha256(Buffer.from('global:close')).slice(0, 8);

    return new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: true },
      ],
      programId: this.programId,
      data: Buffer.from(discriminator),
    });
  }

  // ===========================================================================
  // SERIALIZATION HELPERS
  // ===========================================================================

  private serializeU64(value: number): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(value));
    return buf;
  }

  private serializeString(str: string): Buffer {
    const strBuf = Buffer.from(str);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(strBuf.length);
    return Buffer.concat([lenBuf, strBuf]);
  }

  private serializeVec(items: Buffer[]): Buffer {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(items.length);
    return Buffer.concat([lenBuf, ...items]);
  }

  private computeVocabularyHash(vocabulary: Vocabulary): Uint8Array {
    const data = JSON.stringify({
      assertions: vocabulary.assertions,
    });
    return sha256(Buffer.from(data));
  }

  // ===========================================================================
  // DESERIALIZATION
  // ===========================================================================

  /**
   * Deserialize on-chain identity data.
   */
  private deserializeIdentity(data: Buffer): OnChainIdentity {
    let offset = 8; // Skip discriminator

    // Authority (32 bytes)
    const authority = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;

    // Bump (1 byte)
    const bump = data.readUInt8(offset);
    offset += 1;

    // Dimension count (1 byte)
    const dimensionCount = data.readUInt8(offset);
    offset += 1;

    // Vocabulary hash (32 bytes)
    const vocabularyHash = new Uint8Array(data.slice(offset, offset + 32));
    offset += 32;

    // Dimension names (MAX_DIMENSIONS * 32 bytes)
    const dimensionNames: string[] = [];
    for (let i = 0; i < MAX_DIMENSIONS; i++) {
      const nameBytes = data.slice(offset, offset + 32);
      const nullIdx = nameBytes.indexOf(0);
      const name = nameBytes.slice(0, nullIdx === -1 ? 32 : nullIdx).toString('utf8');
      if (i < dimensionCount) {
        dimensionNames.push(name);
      }
      offset += 32;
    }

    // Weights (MAX_DIMENSIONS * 8 bytes)
    const weights: number[] = [];
    for (let i = 0; i < MAX_DIMENSIONS; i++) {
      const weight = Number(data.readBigUInt64LE(offset)) / WEIGHT_SCALE;
      if (i < dimensionCount) {
        weights.push(weight);
      }
      offset += 8;
    }

    // Self-model (MAX_DIMENSIONS * 8 bytes)
    const selfModel: number[] = [];
    for (let i = 0; i < MAX_DIMENSIONS; i++) {
      const m = Number(data.readBigUInt64LE(offset)) / WEIGHT_SCALE;
      if (i < dimensionCount) {
        selfModel.push(m);
      }
      offset += 8;
    }

    // Time (8 bytes)
    const time = Number(data.readBigUInt64LE(offset));
    offset += 8;

    // Declaration count (4 bytes)
    const declarationCount = data.readUInt32LE(offset);
    offset += 4;

    // Declarations (MAX_STORED_DECLARATIONS * Declaration size)
    // Layout: index(1) + value(8) + timestamp(8) + previousHash(32) + signature(64) + contentHash(32) = 145
    const declarations: OnChainDeclaration[] = [];
    const DECL_SIZE = 1 + 8 + 8 + 32 + 64 + 32; // 145 bytes
    for (let i = 0; i < MAX_STORED_DECLARATIONS; i++) {
      if (i < declarationCount) {
        const decl = this.deserializeDeclaration(data.slice(offset, offset + DECL_SIZE));
        declarations.push(decl);
      }
      offset += DECL_SIZE;
    }

    // Genesis hash (32 bytes)
    const genesisHash = new Uint8Array(data.slice(offset, offset + 32));
    offset += 32;

    // Current hash (32 bytes)
    const currentHash = new Uint8Array(data.slice(offset, offset + 32));
    offset += 32;

    // Merkle root (32 bytes)
    const merkleRoot = new Uint8Array(data.slice(offset, offset + 32));
    offset += 32;

    // Pivotal count (2 bytes)
    const pivotalCount = data.readUInt16LE(offset);
    offset += 2;

    // Pivotal hashes (MAX_STORED_DECLARATIONS * 32 bytes)
    const pivotalHashes: Uint8Array[] = [];
    for (let i = 0; i < MAX_STORED_DECLARATIONS; i++) {
      if (i < pivotalCount) {
        pivotalHashes.push(new Uint8Array(data.slice(offset, offset + 32)));
      }
      offset += 32;
    }

    // Pivotal impacts (MAX_STORED_DECLARATIONS * 8 bytes)
    const pivotalImpacts: number[] = [];
    for (let i = 0; i < MAX_STORED_DECLARATIONS; i++) {
      if (i < pivotalCount) {
        pivotalImpacts.push(Number(data.readBigUInt64LE(offset)) / WEIGHT_SCALE);
      }
      offset += 8;
    }

    // Pivotal timestamps (MAX_STORED_DECLARATIONS * 8 bytes)
    const pivotalTimestamps: number[] = [];
    for (let i = 0; i < MAX_STORED_DECLARATIONS; i++) {
      if (i < pivotalCount) {
        pivotalTimestamps.push(Number(data.readBigInt64LE(offset)));
      }
      offset += 8;
    }

    // Scores
    const continuityScore = Number(data.readBigUInt64LE(offset)) / WEIGHT_SCALE;
    offset += 8;
    const coherenceScore = Number(data.readBigUInt64LE(offset)) / WEIGHT_SCALE;
    offset += 8;
    const stabilityScore = Number(data.readBigUInt64LE(offset)) / WEIGHT_SCALE;
    offset += 8;

    // Timestamps
    const createdAt = Number(data.readBigInt64LE(offset));
    offset += 8;
    const updatedAt = Number(data.readBigInt64LE(offset));
    offset += 8;

    return {
      authority,
      bump,
      dimensionCount,
      vocabularyHash,
      dimensionNames,
      weights,
      selfModel,
      time,
      declarationCount,
      declarations,
      genesisHash,
      currentHash,
      merkleRoot,
      pivotalCount,
      pivotalHashes,
      pivotalImpacts,
      pivotalTimestamps,
      continuityScore,
      coherenceScore,
      stabilityScore,
      createdAt,
      updatedAt,
    };
  }

  private deserializeDeclaration(data: Buffer): OnChainDeclaration {
    let offset = 0;

    const index = data.readUInt8(offset);
    offset += 1;

    const value = Number(data.readBigUInt64LE(offset)) / WEIGHT_SCALE;
    offset += 8;

    const timestamp = Number(data.readBigInt64LE(offset));
    offset += 8;

    const previousHash = new Uint8Array(data.slice(offset, offset + 32));
    offset += 32;

    const signature = new Uint8Array(data.slice(offset, offset + 64));
    offset += 64;

    // content_hash: [u8; 32] (replaced inline content to fix stack overflow)
    const contentHash = new Uint8Array(data.slice(offset, offset + 32));
    offset += 32;

    return {
      index,
      value,
      timestamp,
      previousHash,
      signature,
      contentHash,
    };
  }

  // ===========================================================================
  // CONVERSION
  // ===========================================================================

  /**
   * Convert on-chain identity to StoredSelf format.
   */
  private onChainToStoredSelf(identity: OnChainIdentity): StoredSelf {
    // Reconstruct vocabulary
    const n = identity.dimensionCount;
    const relationships = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        relationships[i * n + j] = i === j ? 0 : 0.1;
      }
    }

    const vocabulary: Vocabulary = {
      assertions: identity.dimensionNames,
      relationships,
    };

    // Reconstruct state
    const currentState: SelfState = {
      dimension: n,
      w: Float64Array.from(identity.weights),
      m: Float64Array.from(identity.selfModel),
      time: identity.time,
    };

    // Reconstruct declarations (content_hash on-chain, content not stored on-chain)
    const declarations: Declaration[] = identity.declarations.map(d => ({
      index: d.index,
      value: d.value,
      timestamp: d.timestamp,
      previousHash: bytesToHex(d.previousHash),
      signature: `ed25519:${bytesToHex(d.signature)}`,
      content: `[on-chain hash: ${bytesToHex(d.contentHash)}]`,
    }));

    // Reconstruct pivotal experiences
    const pivotalExperiences: PivotalExperience[] = [];
    for (let i = 0; i < identity.pivotalCount; i++) {
      pivotalExperiences.push({
        timestamp: identity.pivotalTimestamps[i],
        experienceHash: bytesToHex(identity.pivotalHashes[i]),
        insight: '', // Not stored on-chain
        declarationsBefore: [],
        declarationsAfter: [],
        impactMagnitude: identity.pivotalImpacts[i],
      });
    }

    // Reconstruct params
    const w_star = new Float64Array(n).fill(0.5);
    const params: DynamicsParams = {
      D: 0.1,
      lambda: 0.4,
      mu: 0.3,
      kappa: 0.1,
      a: 0.5,
      w_star,
    };

    // Reconstruct continuity proof
    const continuityProof: ContinuityProof = {
      genesisHash: bytesToHex(identity.genesisHash),
      currentHash: bytesToHex(identity.currentHash),
      chainLength: identity.declarationCount,
      continuityScore: identity.continuityScore,
      stabilityScore: identity.stabilityScore,
      coherenceScore: identity.coherenceScore,
      merkleRoot: bytesToHex(identity.merkleRoot),
    };

    return {
      vocabulary,
      declarations,
      pivotalExperiences,
      historyRoot: bytesToHex(identity.merkleRoot),
      continuityProof,
      currentState,
      params,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create an Anchor-based storage backend.
 */
export function createAnchorStorageBackend(config: AnchorStorageConfig): AnchorStorageBackend {
  return new AnchorStorageBackend(config);
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  AnchorStorageBackend,
  createAnchorStorageBackend,
  AGENT_IDENTITY_PROGRAM_ID,
  MAX_DIMENSIONS,
  MAX_STORED_DECLARATIONS,
  WEIGHT_SCALE,
};
