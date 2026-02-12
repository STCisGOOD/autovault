/**
 * Agent Registration — builds the `initialize` transaction for the
 * agent-identity Anchor program.
 *
 * Creates a PDA with 9 default dimensions at 50% weights.
 * The PDA is derived from seeds: ["agent-identity", authority_pubkey].
 * Anchor's `init` constraint handles account creation + rent.
 */

import { PublicKey, Transaction, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { getConnection, PROGRAM_ID, deriveIdentityPDA } from './solana';

const WEIGHT_SCALE = 10000;

// Default 9 dimensions matching ARIL v2 strategy atoms.
// Names must fit in 16 bytes (on-chain MAX_DIMENSION_NAME_LEN).
const DEFAULT_DIMENSIONS = [
  'curiosity',         // 9 chars
  'precision',         // 9
  'persistence',       // 11
  'empathy',           // 7
  'read_before_edit',  // 16 (exact fit)
  'test_after_chng',   // 16 (truncated from test_after_change)
  'ctx_gathering',     // 13 (truncated from context_gathering)
  'output_verify',     // 13 (truncated from output_verification)
  'error_recovery',    // 14
];

// Human-readable labels for the UI (matches ridgeMath.ts DIMENSIONS order)
const DIMENSION_LABELS = [
  'Curiosity', 'Precision', 'Persistence', 'Empathy',
  'Read \u2192 Edit', 'Test \u2192 Change', 'Context', 'Verification', 'Recovery',
];

const DEFAULT_WEIGHTS = DEFAULT_DIMENSIONS.map(() => Math.round(0.5 * WEIGHT_SCALE));

// ─── Borsh Serialization Helpers ─────────────────────────────────────────

function serializeU32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = value & 0xff;
  buf[1] = (value >> 8) & 0xff;
  buf[2] = (value >> 16) & 0xff;
  buf[3] = (value >> 24) & 0xff;
  return buf;
}

function serializeU64LE(value: number): Uint8Array {
  const buf = new Uint8Array(8);
  const lo = value >>> 0;
  const hi = (Math.floor(value / 0x100000000)) >>> 0;
  buf[0] = lo & 0xff;
  buf[1] = (lo >> 8) & 0xff;
  buf[2] = (lo >> 16) & 0xff;
  buf[3] = (lo >> 24) & 0xff;
  buf[4] = hi & 0xff;
  buf[5] = (hi >> 8) & 0xff;
  buf[6] = (hi >> 16) & 0xff;
  buf[7] = (hi >> 24) & 0xff;
  return buf;
}

function serializeBorshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const len = serializeU32LE(bytes.length);
  const result = new Uint8Array(4 + bytes.length);
  result.set(len, 0);
  result.set(bytes, 4);
  return result;
}

function serializeBorshVec(items: Uint8Array[]): Uint8Array {
  const lenPrefix = serializeU32LE(items.length);
  const totalLen = items.reduce((sum, item) => sum + item.length, 0);
  const result = new Uint8Array(4 + totalLen);
  result.set(lenPrefix, 0);
  let offset = 4;
  for (const item of items) {
    result.set(item, offset);
    offset += item.length;
  }
  return result;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash);
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Check if an agent identity PDA already exists for the given authority.
 */
export async function checkAgentExists(authority: PublicKey): Promise<boolean> {
  const connection = getConnection();
  const [pda] = deriveIdentityPDA(authority);
  try {
    const info = await connection.getAccountInfo(pda);
    return info !== null;
  } catch {
    return false;
  }
}

/**
 * Build the `initialize` transaction for the agent-identity program.
 * Creates a new on-chain PDA with 9 default dimensions at 50% weights.
 */
export async function buildInitializeTx(authority: PublicKey): Promise<Transaction> {
  const connection = getConnection();
  const [pda] = deriveIdentityPDA(authority);

  // Anchor discriminator: sha256("global:initialize")[0..8]
  const discriminator = (
    await sha256(new TextEncoder().encode('global:initialize'))
  ).slice(0, 8);

  // Serialize Vec<String> dimension_names
  const namesVec = serializeBorshVec(
    DEFAULT_DIMENSIONS.map((n) => serializeBorshString(n)),
  );

  // Serialize Vec<u64> initial_weights
  const weightsVec = serializeBorshVec(
    DEFAULT_WEIGHTS.map((w) => serializeU64LE(w)),
  );

  // vocabulary_hash: [u8; 32] — SHA-256 of vocabulary JSON
  const vocabJson = JSON.stringify({ assertions: DEFAULT_DIMENSIONS });
  const vocabularyHash = await sha256(new TextEncoder().encode(vocabJson));

  // Build instruction data
  const data = concatBytes(discriminator, namesVec, weightsVec, vocabularyHash);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: Buffer.from(data),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = authority;

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;

  return tx;
}

export { DEFAULT_DIMENSIONS, DIMENSION_LABELS, DEFAULT_WEIGHTS, WEIGHT_SCALE };
