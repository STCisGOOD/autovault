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
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
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
 * Maximum length of a dimension name in bytes (must match lib.rs).
 */
export const MAX_DIMENSION_NAME_LEN = 16;

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

    // Track the current on-chain hash for Ed25519 message construction.
    // Each declaration updates the hash, so we need the latest for each one.
    let currentHash: Uint8Array = currentResult.found && currentResult.self
      ? new Uint8Array(
          currentResult.self.continuityProof?.currentHash
            ? hexToBytes(currentResult.self.continuityProof.currentHash)
            : new Uint8Array(32)
        )
      : new Uint8Array(32);

    for (const decl of newDeclarations) {
      // Extract signature bytes for the Ed25519 precompile instruction
      let sigBytes: Uint8Array;
      if (decl.signature.startsWith('ed25519:')) {
        sigBytes = hexToBytes(decl.signature.slice('ed25519:'.length));
      } else if (decl.signature.startsWith('hash:')) {
        const hashBytes = hexToBytes(decl.signature.slice('hash:'.length));
        sigBytes = new Uint8Array(64);
        sigBytes.set(hashBytes);
      } else {
        sigBytes = new Uint8Array(64);
      }

      // RT-C2 fix: Build Ed25519 precompile instruction (must be BEFORE declare)
      const ed25519Ix = this.buildEd25519Instruction(decl, sigBytes, currentHash);
      const declareIx = this.buildDeclareInstruction(pda, decl);

      const tx = new Transaction().add(ed25519Ix).add(declareIx);
      tx.feePayer = this.payer.publicKey;
      tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

      tx.sign(this.payer);

      const sig = await this.connection.sendRawTransaction(tx.serialize());
      await this.connection.confirmTransaction(sig, 'confirmed');

      if (this.debug) {
        console.log(`[AnchorStorage] Declaration recorded: ${sig}`);
      }

      // Update currentHash for next declaration (compute the new hash).
      // This matches compute_declaration_hash in the Rust program.
      const declHash = sha256(Buffer.concat([
        Buffer.from([decl.index]),
        this.serializeU64(Math.round(decl.value * WEIGHT_SCALE)),
        Buffer.from(sha256(Buffer.from(decl.content))), // content_hash
        Buffer.from(currentHash),                         // previous_hash
      ]));
      currentHash = new Uint8Array(declHash);
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
      this.serializeVec(dimensionNames.map(n => this.serializeString(n))),
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
   *
   * RT-H5 fix: content serialized as Borsh String (4-byte LE length + UTF-8),
   * not as a raw content hash. The on-chain program computes the hash itself.
   *
   * RT-C2 fix: account keys include Instructions sysvar for Ed25519 verification.
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

    // RT-H5 fix: Send content as Borsh String (4-byte LE length + UTF-8 bytes).
    // The on-chain program receives this as `content: String` and computes
    // content_hash itself via compute_content_hash(&content).
    const contentBytes = Buffer.from(declaration.content, 'utf8');
    const contentLen = Buffer.alloc(4);
    contentLen.writeUInt32LE(contentBytes.length, 0);

    const data = Buffer.concat([
      Buffer.from(discriminator),
      Buffer.from([declaration.index]),                    // dimension_index: u8
      this.serializeU64(Math.round(declaration.value * WEIGHT_SCALE)), // new_value: u64
      contentLen,                                          // content length prefix (Borsh String)
      contentBytes,                                        // content UTF-8 bytes
      Buffer.from(sigBytes),                               // signature: [u8; 64]
    ]);

    // RT-C2 fix: Include Instructions sysvar for Ed25519 signature verification.
    // The Declare context expects 3 accounts: identity, authority, instructions.
    return new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: this.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data,
    });
  }

  /**
   * Build the Ed25519 precompile instruction for declaration signing.
   *
   * RT-C2 fix: The on-chain program's verify_ed25519_signature checks that
   * an Ed25519 precompile instruction exists earlier in the transaction with
   * matching pubkey, message, and signature data.
   *
   * The message format matches build_declaration_message in lib.rs:
   *   authority_pubkey (32) + dimension_index (1) + new_value_le (8) + content_bytes + prev_hash (32)
   */
  private buildEd25519Instruction(
    declaration: Declaration,
    sigBytes: Uint8Array,
    prevHash: Uint8Array,
  ): TransactionInstruction {
    // Build the same message as the Rust program's build_declaration_message
    const newValueBuf = Buffer.alloc(8);
    const scaledValue = Math.round(declaration.value * WEIGHT_SCALE);
    // Write as LE u64
    newValueBuf.writeUInt32LE(scaledValue & 0xFFFFFFFF, 0);
    newValueBuf.writeUInt32LE(Math.floor(scaledValue / 0x100000000) & 0xFFFFFFFF, 4);

    const message = Buffer.concat([
      this.payer.publicKey.toBuffer(),           // authority (32 bytes)
      Buffer.from([declaration.index]),           // dimension_index (1 byte)
      newValueBuf,                                // new_value LE (8 bytes)
      Buffer.from(declaration.content, 'utf8'),   // content bytes
      Buffer.from(prevHash),                      // prev_hash (32 bytes)
    ]);

    return Ed25519Program.createInstructionWithPublicKey({
      publicKey: this.payer.publicKey.toBytes(),
      message,
      signature: sigBytes,
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
   * Build the evolve instruction from weight deltas.
   *
   * The on-chain program computes: delta = signal * time_step / 10000.
   * With time_step = WEIGHT_SCALE (10000), the division is a no-op
   * and signal values are applied as direct deltas to on-chain weights.
   *
   * Self-model tracking also works correctly at time_step=10000:
   *   dm = 3000 * (w - m) * 10000 / (10000 * 10000) = 0.3 * (w - m)
   */
  buildEvolveInstruction(
    pda: PublicKey,
    weightDeltas: number[],
  ): TransactionInstruction {
    const discriminator = sha256(Buffer.from('global:evolve')).slice(0, 8);

    // Serialize deltas as Vec<i64> (signed, already in scaled units)
    const deltaBuffers = weightDeltas.map(d => {
      const buf = Buffer.alloc(8);
      buf.writeBigInt64LE(BigInt(d));
      return buf;
    });

    const data = Buffer.concat([
      Buffer.from(discriminator),
      this.serializeVec(deltaBuffers),
      this.serializeU64(WEIGHT_SCALE), // time_step = 10000 makes /10000 a no-op
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
   * Build the set_weights instruction for direct weight overwrite.
   *
   * Unlike evolve (PDE integrator), this sets absolute values.
   * Weights are already in scaled units (0-10000).
   */
  buildSetWeightsInstruction(
    pda: PublicKey,
    scaledWeights: number[],
  ): TransactionInstruction {
    const discriminator = sha256(Buffer.from('global:set_weights')).slice(0, 8);

    // Serialize as Vec<u64>
    const weightBuffers = scaledWeights.map(w => this.serializeU64(w));

    const data = Buffer.concat([
      Buffer.from(discriminator),
      this.serializeVec(weightBuffers),
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
   * Set on-chain weights to exact target values.
   *
   * Takes float weights (0.0 - 1.0), scales to on-chain units (0 - 10000),
   * and sends a set_weights instruction that directly overwrites.
   * Self-model is also set to match (coherent: m = w).
   *
   * **EMA reset warning**: This erases the self-model's exponential moving
   * average history. Use for initialization or recovery only. For routine
   * per-session sync, use `evolve()` which preserves the EMA relationship.
   */
  async setWeights(targetWeights: number[]): Promise<string> {
    const [pda] = await this.getIdentityPDA();

    // Validate identity exists
    const result = await this.load();
    if (!result.found || !result.self) {
      throw new Error('Cannot set weights: no identity account found on-chain');
    }

    const expectedCount = result.self.currentState.w.length;
    if (targetWeights.length !== expectedCount) {
      throw new Error(
        `Weight count mismatch: target=${targetWeights.length}, on-chain=${expectedCount}`
      );
    }

    // Scale to on-chain units and validate range
    const scaledWeights = targetWeights.map(w => {
      const scaled = Math.round(w * WEIGHT_SCALE);
      if (scaled < 0 || scaled > 10000) {
        throw new Error(`Weight out of range: ${w} (must be 0.0-1.0)`);
      }
      return scaled;
    });

    const ix = this.buildSetWeightsInstruction(pda, scaledWeights);

    const tx = new Transaction().add(ix);
    tx.feePayer = this.payer.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

    tx.sign(this.payer);

    const sig = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction(sig, 'confirmed');

    if (this.debug) {
      console.log(`[AnchorStorage] Set weights directly: ${sig}`);
    }

    return sig;
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
   * Evolve on-chain weights toward target values.
   *
   * IMPORTANT: The on-chain `evolve` instruction is a PDE integrator designed for
   * gradual weight drift: `new_weight = old + signal * time_step / 10000`. This
   * method abuses it as a direct setter via a mathematical trick:
   *
   *   signal = (target - current) * WEIGHT_SCALE    // delta in scaled units
   *   time_step = WEIGHT_SCALE (10000)              // makes /10000 a no-op
   *   → new_weight = old + (target - old) = target  // exact overwrite
   *
   * This works but is semantically misleading. Any third-party client reading the
   * Rust source will expect `evolve` to apply small gradual updates, not absolute
   * overwrites. Prefer `setWeights()` once the set_weights instruction is deployed.
   *
   * Loads current on-chain weights, computes deltas, and sends them as
   * experience_signal with time_step=WEIGHT_SCALE.
   */
  async evolve(targetWeights: number[]): Promise<string> {
    const [pda] = await this.getIdentityPDA();

    // Load current on-chain state to compute deltas
    const result = await this.load();
    if (!result.found || !result.self) {
      throw new Error('Cannot evolve: no identity account found on-chain');
    }

    const currentWeights = Array.from(result.self.currentState.w);
    if (targetWeights.length !== currentWeights.length) {
      throw new Error(`Weight count mismatch: target=${targetWeights.length}, on-chain=${currentWeights.length}`);
    }

    // Compute deltas in scaled units: (target - current) * WEIGHT_SCALE
    // These become the experience_signal values sent to the Rust program
    const deltas = targetWeights.map((target, i) =>
      Math.round((target - currentWeights[i]) * WEIGHT_SCALE)
    );

    if (this.debug) {
      console.log(`[AnchorStorage] Evolve deltas: ${deltas.map(d => d / WEIGHT_SCALE)}`);
    }

    const ix = this.buildEvolveInstruction(pda, deltas);

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

    // Dimension names (MAX_DIMENSIONS * MAX_DIMENSION_NAME_LEN bytes)
    // RT-M11 fix: Rust uses MAX_DIMENSION_NAME_LEN=16 bytes per name, not 32.
    // Reading 32 bytes per name shifted all subsequent field offsets by 256 bytes.
    const dimensionNames: string[] = [];
    for (let i = 0; i < MAX_DIMENSIONS; i++) {
      const nameBytes = data.slice(offset, offset + MAX_DIMENSION_NAME_LEN);
      const nullIdx = nameBytes.indexOf(0);
      const name = nameBytes.slice(0, nullIdx === -1 ? MAX_DIMENSION_NAME_LEN : nullIdx).toString('utf8');
      if (i < dimensionCount) {
        dimensionNames.push(name);
      }
      offset += MAX_DIMENSION_NAME_LEN;
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
