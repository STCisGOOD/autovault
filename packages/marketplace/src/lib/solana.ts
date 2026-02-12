/**
 * Solana connection and account utilities for the marketplace.
 *
 * Handles RPC connection, PDA derivation, and on-chain account deserialization.
 * Uses the same constants and layout as the backend AccountTypes.ts.
 */

import { Connection, PublicKey } from '@solana/web3.js';

// ─── Constants (must match lib.rs / AccountTypes.ts) ──────────────────────

export const PROGRAM_ID = new PublicKey('83vBR6Rftwvisr4JdjYwnWskFx2uNfkA6K9SjHu69fxf');

const MAX_DIMENSIONS = 16;
const MAX_DIMENSION_NAME_LEN = 16;
const MAX_STORED_DECLARATIONS = 4;
const MAX_PIVOTAL_EXPERIENCES = 4;
const WEIGHT_SCALE = 10000;
const DISCRIMINATOR_SIZE = 8;
const DECL_SIZE = 1 + 8 + 8 + 32 + 64 + 32; // 145

// ─── Connection ───────────────────────────────────────────────────────────

const RPC_URL = 'https://api.devnet.solana.com';
let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(RPC_URL, 'confirmed');
  }
  return _connection;
}

// ─── PDA Derivation ───────────────────────────────────────────────────────

export function deriveIdentityPDA(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('agent-identity'), authority.toBuffer()],
    PROGRAM_ID,
  );
}

// ─── Account Deserialization ──────────────────────────────────────────────

export interface ParsedAgentIdentity {
  authority: PublicKey;
  bump: number;
  dimensionCount: number;
  dimensionNames: string[];
  weights: number[];
  selfModel: number[];
  time: number;
  declarationCount: number;
  continuityScore: number;
  coherenceScore: number;
  stabilityScore: number;
  createdAt: number;
  updatedAt: number;
}

/** Read a u8 from buffer at offset */
function readU8(data: Buffer, offset: number): number {
  return data[offset];
}

/** Read a little-endian u32 from buffer */
function readU32LE(data: Buffer, offset: number): number {
  return data.readUInt32LE(offset);
}

/** Read a little-endian u64 as number (safe for values < 2^53) */
function readU64AsNumber(data: Buffer, offset: number): number {
  const lo = data.readUInt32LE(offset);
  const hi = data.readUInt32LE(offset + 4);
  return lo + hi * 0x100000000;
}

/** Read a little-endian i64 as number */
function readI64AsNumber(data: Buffer, offset: number): number {
  const lo = data.readUInt32LE(offset);
  const hi = data.readInt32LE(offset + 4);
  return lo + hi * 0x100000000;
}

/** Convert fixed-size null-padded bytes to string */
function readFixedString(data: Buffer, offset: number, maxLen: number): string {
  const slice = data.subarray(offset, offset + maxLen);
  const nullIdx = slice.indexOf(0);
  const trimmed = nullIdx === -1 ? slice : slice.subarray(0, nullIdx);
  return new TextDecoder().decode(trimmed);
}

/**
 * Parse raw account data into a typed structure.
 * Layout must match the Rust AgentIdentity struct exactly.
 */
export function parseAgentIdentity(data: Buffer): ParsedAgentIdentity | null {
  try {
    let offset = DISCRIMINATOR_SIZE; // Skip Anchor discriminator

    // authority: Pubkey (32 bytes)
    const authority = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;

    // bump: u8
    const bump = readU8(data, offset);
    offset += 1;

    // dimension_count: u8
    const dimensionCount = readU8(data, offset);
    offset += 1;

    // vocabulary_hash: [u8; 32]
    offset += 32; // skip

    // dimension_names: [[u8; 16]; 16]
    const dimensionNames: string[] = [];
    for (let i = 0; i < MAX_DIMENSIONS; i++) {
      const name = readFixedString(data, offset, MAX_DIMENSION_NAME_LEN);
      if (i < dimensionCount && name.length > 0) {
        dimensionNames.push(name);
      }
      offset += MAX_DIMENSION_NAME_LEN;
    }

    // weights: [u64; 16]
    const weights: number[] = [];
    for (let i = 0; i < MAX_DIMENSIONS; i++) {
      const scaled = readU64AsNumber(data, offset);
      if (i < dimensionCount) {
        weights.push(scaled / WEIGHT_SCALE);
      }
      offset += 8;
    }

    // self_model: [u64; 16]
    const selfModel: number[] = [];
    for (let i = 0; i < MAX_DIMENSIONS; i++) {
      const scaled = readU64AsNumber(data, offset);
      if (i < dimensionCount) {
        selfModel.push(scaled / WEIGHT_SCALE);
      }
      offset += 8;
    }

    // time: u64
    const time = readU64AsNumber(data, offset);
    offset += 8;

    // declaration_count: u32
    const declarationCount = readU32LE(data, offset);
    offset += 4;

    // declarations: [Declaration; 4] — skip for now
    offset += DECL_SIZE * MAX_STORED_DECLARATIONS;

    // genesis_hash, current_hash, merkle_root: [u8; 32] each
    offset += 32 * 3;

    // pivotal_count: u16
    offset += 2;

    // pivotal_hashes, impacts, timestamps
    offset += 32 * MAX_PIVOTAL_EXPERIENCES;
    offset += 8 * MAX_PIVOTAL_EXPERIENCES;
    offset += 8 * MAX_PIVOTAL_EXPERIENCES;

    // continuity_score, coherence_score, stability_score: u64 each
    const continuityScore = readU64AsNumber(data, offset) / WEIGHT_SCALE;
    offset += 8;
    const coherenceScore = readU64AsNumber(data, offset) / WEIGHT_SCALE;
    offset += 8;
    const stabilityScore = readU64AsNumber(data, offset) / WEIGHT_SCALE;
    offset += 8;

    // created_at, updated_at: i64
    const createdAt = readI64AsNumber(data, offset);
    offset += 8;
    const updatedAt = readI64AsNumber(data, offset);
    offset += 8;

    return {
      authority,
      bump,
      dimensionCount,
      dimensionNames,
      weights,
      selfModel,
      time,
      declarationCount,
      continuityScore,
      coherenceScore,
      stabilityScore,
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}
