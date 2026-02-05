/**
 * AgentIdentityBootstrap.ts
 *
 * Zero-friction identity initialization for autonomous agents.
 *
 * On first run:
 * 1. Generates Ed25519 keypair
 * 2. Requests devnet airdrop
 * 3. Creates identity with default behavioral weights
 * 4. Saves credentials locally
 *
 * On subsequent runs:
 * 1. Loads existing identity
 * 2. Ensures sufficient balance
 * 3. Returns ready-to-use identity
 *
 * Usage:
 * ```typescript
 * import { AgentIdentityBootstrap } from '@persistence/agent-identity';
 *
 * const identity = await AgentIdentityBootstrap.initialize();
 * console.log(`Agent DID: ${identity.did}`);
 * ```
 */

import { PublicKey } from '@solana/web3.js';

import {
  KeypairManager,
  createKeypairManager,
  publicKeyToDid,
  type KeypairManagerConfig,
} from './KeypairManager';

import {
  DevnetFunder,
  createDevnetFunder,
  type DevnetFunderConfig,
} from './DevnetFunder';

import {
  SolanaStorageBackend,
  createSolanaStorageBackend,
} from './SolanaStorageBackend';

import {
  FileSystemPrivateStorage,
  createFileSystemPrivateStorage,
} from './PrivateStorage';

import {
  UnifiedIdentity,
  createUnifiedIdentity,
  type UnifiedIdentityConfig,
} from '../behavioral/UnifiedIdentity';

import {
  type StorageBackend,
} from '../behavioral/IdentityPersistence';

import { Connection } from '@solana/web3.js';

// =============================================================================
// TYPES
// =============================================================================

export interface BootstrapConfig {
  /** Keypair manager configuration */
  keypair?: Partial<KeypairManagerConfig>;

  /** Devnet funder configuration */
  funder?: Partial<DevnetFunderConfig>;

  /** Unified identity configuration */
  identity?: Partial<UnifiedIdentityConfig>;

  /** Storage backend for identity persistence */
  storage?: StorageBackend;

  /**
   * Use Solana blockchain for storage (default: true).
   * When true, identity evolution is committed to Solana devnet.
   * When false, uses in-memory storage (data lost on restart).
   */
  useSolanaStorage?: boolean;

  /**
   * Use local filesystem for private ActionLog storage (default: true).
   * ActionLogs contain the full behavioral data (decisions, reasoning).
   * Only the hash goes on-chain; full data stays local and private.
   */
  usePrivateStorage?: boolean;

  /** Solana RPC endpoint (default: devnet) */
  solanaRpcUrl?: string;

  /** Default behavioral weights [curiosity, precision, persistence, empathy] */
  defaultWeights?: number[];

  /** Whether to auto-fund on devnet */
  autoFund?: boolean;

  /** Minimum SOL balance to maintain */
  minBalance?: number;

  /** Whether to log progress */
  verbose?: boolean;
}

const DEFAULT_CONFIG: Required<Omit<BootstrapConfig, 'keypair' | 'funder' | 'identity' | 'storage'>> = {
  useSolanaStorage: true,
  usePrivateStorage: true,
  solanaRpcUrl: 'https://api.devnet.solana.com',
  defaultWeights: [0.5, 0.5, 0.5, 0.5],
  autoFund: true,
  minBalance: 0.1,
  verbose: true,
};

export interface BootstrappedIdentity {
  /** The did:persistence DID */
  did: string;

  /** The public key (base58) */
  publicKey: string;

  /** Network (always 'devnet' for now) */
  network: 'devnet';

  /** Whether this is a newly created identity */
  isNew: boolean;

  /** Current SOL balance */
  balance: number;

  /** The unified identity instance for behavioral tracking */
  identity: UnifiedIdentity;

  /** Start observing an interaction */
  startObservation: (interactionId: string) => void;

  /** End observation and process through identity evolution */
  endObservation: (interaction: Parameters<UnifiedIdentity['endObservation']>[0]) => ReturnType<UnifiedIdentity['endObservation']>;

  /** Get current identity status */
  getStatus: () => ReturnType<UnifiedIdentity['getStatus']>;

  /** Save identity to storage */
  save: () => Promise<boolean>;

  /** Shutdown gracefully */
  shutdown: () => Promise<void>;
}

// =============================================================================
// IN-MEMORY STORAGE (DEFAULT)
// =============================================================================

/**
 * Simple in-memory storage for development.
 * For production, use a real storage backend (Vercel KV, Redis, etc.)
 */
class InMemoryStorage implements StorageBackend {
  private store: Map<string, unknown> = new Map();

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async keys(pattern?: string): Promise<string[]> {
    const allKeys = Array.from(this.store.keys());
    if (!pattern || pattern === '*') return allKeys;
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    return allKeys.filter(k => regex.test(k));
  }

  isPersistent(): boolean {
    return false;
  }
}

// =============================================================================
// BOOTSTRAP
// =============================================================================

export class AgentIdentityBootstrap {
  private readonly config: BootstrapConfig & typeof DEFAULT_CONFIG;
  private readonly keypairManager: KeypairManager;
  private readonly funder: DevnetFunder;
  private readonly connection: Connection;
  private storage: StorageBackend | null = null;
  private identity: UnifiedIdentity | null = null;

  private constructor(config: BootstrapConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.keypairManager = createKeypairManager({
      network: 'devnet',
      ...config.keypair,
    });

    this.connection = new Connection(this.config.solanaRpcUrl, 'confirmed');
    this.funder = createDevnetFunder({
      rpcEndpoint: this.config.solanaRpcUrl,
      ...config.funder,
    });

    // Storage is set up in run() after keypair is loaded
    if (config.storage) {
      this.storage = config.storage;
    }
  }

  /**
   * Initialize agent identity.
   *
   * This is the main entry point. It handles:
   * - Loading or generating keypair
   * - Funding wallet if needed
   * - Creating or loading identity
   *
   * @returns Ready-to-use identity object
   */
  static async initialize(config: BootstrapConfig = {}): Promise<BootstrappedIdentity> {
    const bootstrap = new AgentIdentityBootstrap(config);
    return bootstrap.run();
  }

  private log(message: string): void {
    if (this.config.verbose) {
      console.log(`[AgentIdentity] ${message}`);
    }
  }

  private async run(): Promise<BootstrappedIdentity> {
    // Step 1: Load or generate keypair
    const isNew = !this.keypairManager.exists();

    if (isNew) {
      this.log('No existing identity found');
      this.log('Generating new keypair...');
      this.keypairManager.generate();
      this.keypairManager.save();
    } else {
      this.log('Loading existing identity...');
      this.keypairManager.load();
    }

    const keypair = this.keypairManager.getKeypair()!;
    const did = this.keypairManager.getDid()!;
    const publicKey = keypair.publicKey;

    this.log(`DID: ${did}`);

    // Step 2: Ensure wallet is funded (devnet)
    let balance = await this.funder.getBalance(publicKey);

    if (this.config.autoFund && balance < this.config.minBalance) {
      this.log(`Balance low (${balance.toFixed(4)} SOL), requesting airdrop...`);

      const fundResult = await this.funder.ensureFunded(publicKey, this.config.minBalance);

      if (!fundResult.success) {
        this.log(`Warning: Airdrop failed - ${fundResult.error}`);
        this.log('Continuing with current balance...');
      }

      balance = fundResult.balanceAfter;
    }

    this.log(`Balance: ${balance.toFixed(4)} SOL`);

    // Step 3: Set up storage backend
    if (!this.storage) {
      if (this.config.useSolanaStorage) {
        this.log('Using Solana blockchain for identity storage');
        this.storage = createSolanaStorageBackend({
          connection: this.connection,
          payer: keypair,
          namespace: did,
          commitment: 'confirmed',
          compress: true,
        });
      } else {
        this.log('Using in-memory storage (data will not persist)');
        this.storage = new InMemoryStorage();
      }
    }

    // Step 4: Set up private storage for ActionLogs
    if (this.config.usePrivateStorage) {
      this.log('Using local filesystem for private ActionLog storage');
      const privateStorage = createFileSystemPrivateStorage({
        agentDid: did,
      });
      this.log(`Private storage: ${privateStorage.getStorageDir()}`);
      // Will be attached to identity after creation
    }

    // Step 5: Create or load unified identity
    this.identity = createUnifiedIdentity(this.storage, this.config.identity);

    // Attach private storage if configured
    if (this.config.usePrivateStorage) {
      const privateStorage = createFileSystemPrivateStorage({ agentDid: did });
      this.identity.setPrivateStorage(privateStorage);
    }

    const loadResult = await this.identity.initialize(this.config.defaultWeights);

    if (loadResult.isNew) {
      this.log('Created new behavioral identity');
    } else {
      this.log('Restored behavioral identity from storage');
    }

    this.log('Identity ready');

    // Return the bootstrapped identity
    return this.createBootstrappedIdentity(did, publicKey, balance, isNew);
  }

  private createBootstrappedIdentity(
    did: string,
    publicKey: PublicKey,
    balance: number,
    isNew: boolean
  ): BootstrappedIdentity {
    const identity = this.identity!;

    return {
      did,
      publicKey: publicKey.toBase58(),
      network: 'devnet',
      isNew,
      balance,
      identity,

      startObservation: (interactionId: string) => {
        identity.startObservation(interactionId);
      },

      endObservation: (interaction) => {
        return identity.endObservation(interaction);
      },

      getStatus: () => {
        return identity.getStatus();
      },

      save: async () => {
        return identity.save();
      },

      shutdown: async () => {
        await identity.shutdown();
      },
    };
  }
}

// =============================================================================
// CONVENIENCE EXPORTS
// =============================================================================

/**
 * Initialize agent identity with default settings.
 *
 * This is the simplest way to get started:
 * ```typescript
 * const identity = await initializeAgentIdentity();
 * ```
 */
export async function initializeAgentIdentity(
  config?: BootstrapConfig
): Promise<BootstrappedIdentity> {
  return AgentIdentityBootstrap.initialize(config);
}

export default {
  AgentIdentityBootstrap,
  initializeAgentIdentity,
};
