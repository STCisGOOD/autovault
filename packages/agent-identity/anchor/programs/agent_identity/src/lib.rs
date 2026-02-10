use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

// For zero-copy accounts
use std::mem::size_of;

declare_id!("83vBR6Rftwvisr4JdjYwnWskFx2uNfkA6K9SjHu69fxf");

// =============================================================================
// EVENTS
// =============================================================================

/// Emitted when a new agent identity is initialized
#[event]
pub struct IdentityInitialized {
    pub authority: Pubkey,
    pub dimension_count: u8,
    pub vocabulary_hash: [u8; 32],
    pub timestamp: i64,
}

/// Emitted when a declaration is recorded
#[event]
pub struct DeclarationRecorded {
    pub authority: Pubkey,
    pub declaration_count: u32,
    pub dimension_index: u8,
    pub new_value: u64,
    pub declaration_hash: [u8; 32],
    pub timestamp: i64,
}

/// Emitted when identity evolves
#[event]
pub struct IdentityEvolved {
    pub authority: Pubkey,
    pub time: u64,
    pub coherence_score: u64,
    pub timestamp: i64,
}

/// Emitted when a pivotal experience is recorded
#[event]
pub struct PivotalExperienceRecorded {
    pub authority: Pubkey,
    pub pivotal_count: u16,
    pub experience_hash: [u8; 32],
    pub impact_magnitude: u64,
    pub timestamp: i64,
}

/// Emitted when weights are set directly
#[event]
pub struct WeightsSet {
    pub authority: Pubkey,
    pub weights: Vec<u64>,
    pub timestamp: i64,
}

/// Emitted when identity is closed
#[event]
pub struct IdentityClosed {
    pub authority: Pubkey,
    pub declaration_count: u32,
    pub timestamp: i64,
}

// =============================================================================
// CONSTANTS
// =============================================================================

/// Maximum number of identity dimensions supported.
/// Default is 4 (curiosity, precision, persistence, empathy).
/// Can extend to 16 for combined behavioral + domain dimensions.
pub const MAX_DIMENSIONS: usize = 16;

/// Maximum length of dimension name in bytes.
pub const MAX_DIMENSION_NAME_LEN: usize = 16;

/// Maximum number of declarations to store on-chain.
/// Older declarations are referenced by hash only.
/// Full declaration content stored off-chain.
pub const MAX_STORED_DECLARATIONS: usize = 4;

/// Maximum number of pivotal experience hashes to store.
pub const MAX_PIVOTAL_EXPERIENCES: usize = 4;

#[program]
pub mod agent_identity {
    use super::*;

    /// Initialize a new agent identity account.
    ///
    /// Creates the genesis self with initial weights and vocabulary.
    /// The authority (agent's keypair) controls all future updates.
    pub fn initialize(
        ctx: Context<Initialize>,
        dimension_names: Vec<String>,
        initial_weights: Vec<u64>,
        vocabulary_hash: [u8; 32],
    ) -> Result<()> {
        require!(
            dimension_names.len() == initial_weights.len(),
            AgentIdentityError::DimensionWeightMismatch
        );
        require!(
            dimension_names.len() <= MAX_DIMENSIONS,
            AgentIdentityError::TooManyDimensions
        );
        require!(
            !dimension_names.is_empty(),
            AgentIdentityError::NoDimensions
        );

        let identity = &mut ctx.accounts.identity;
        let clock = Clock::get()?;

        // Set authority
        identity.authority = ctx.accounts.authority.key();
        identity.bump = ctx.bumps.identity;

        // Set vocabulary
        identity.dimension_count = dimension_names.len() as u8;
        identity.vocabulary_hash = vocabulary_hash;

        // Initialize dimension names (padded to fixed size)
        for (i, name) in dimension_names.iter().enumerate() {
            let name_bytes = name.as_bytes();
            let len = name_bytes.len().min(MAX_DIMENSION_NAME_LEN);
            identity.dimension_names[i][..len].copy_from_slice(&name_bytes[..len]);
        }

        // Initialize weights (w) - scaled by 10000 for precision
        // 0.5 = 5000, 1.0 = 10000
        for (i, weight) in initial_weights.iter().enumerate() {
            identity.weights[i] = *weight;
            identity.self_model[i] = *weight; // Coherent at genesis (m = w)
        }

        // Initialize state
        identity.time = 0;
        identity.declaration_count = 0;
        identity.pivotal_count = 0;
        identity.genesis_hash = [0u8; 32]; // Will be set after first declaration
        identity.current_hash = [0u8; 32];
        identity.merkle_root = [0u8; 32];

        // Timestamps
        identity.created_at = clock.unix_timestamp;
        identity.updated_at = clock.unix_timestamp;

        // Scores
        identity.continuity_score = 10000; // 1.0 at genesis
        identity.coherence_score = 0;      // 0 = perfect coherence
        identity.stability_score = 10000;  // 1.0 = stable

        // Rate limiting: track last update
        identity.last_declaration_slot = 0;

        msg!("Agent identity initialized with {} dimensions", identity.dimension_count);

        // Emit event for indexing
        emit!(IdentityInitialized {
            authority: identity.authority,
            dimension_count: identity.dimension_count,
            vocabulary_hash: identity.vocabulary_hash,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Record a declaration (identity update).
    ///
    /// Declarations are signed commitments that update identity weights.
    /// They form a hash-linked chain for continuity verification.
    ///
    /// IMPORTANT: The transaction MUST include an Ed25519 instruction (index 0)
    /// that verifies the signature over the declaration message.
    pub fn declare(
        ctx: Context<Declare>,
        dimension_index: u8,
        new_value: u64,
        content: String,
        signature: [u8; 64],
    ) -> Result<()> {
        let identity = &mut ctx.accounts.identity;
        let clock = Clock::get()?;

        // === RATE LIMITING ===
        // Prevent spam by requiring at least 2 slots (~800ms) between declarations
        let current_slot = clock.slot;
        require!(
            identity.last_declaration_slot == 0 || current_slot >= identity.last_declaration_slot + 2,
            AgentIdentityError::RateLimitExceeded
        );

        require!(
            (dimension_index as usize) < identity.dimension_count as usize,
            AgentIdentityError::InvalidDimensionIndex
        );
        require!(
            new_value <= 10000,
            AgentIdentityError::WeightOutOfRange
        );

        // === ED25519 SIGNATURE VERIFICATION ===
        // Build the message that should have been signed
        let message = build_declaration_message(
            &ctx.accounts.authority.key(),
            dimension_index,
            new_value,
            &content,
            &identity.current_hash,
        );

        // Verify the Ed25519 signature via the instructions sysvar
        verify_ed25519_signature(
            &ctx.accounts.instructions,
            &ctx.accounts.authority.key().to_bytes(),
            &message,
            &signature,
        )?;

        // Copy current_hash before mutable borrow (borrow checker requirement)
        let prev_hash = identity.current_hash;

        // Create declaration
        let decl_idx = (identity.declaration_count as usize) % MAX_STORED_DECLARATIONS;
        // Hash the content (full content stored off-chain)
        let content_hash = compute_content_hash(&content);

        let declaration = &mut identity.declarations[decl_idx];

        declaration.index = dimension_index;
        declaration.value = new_value;
        declaration.timestamp = clock.unix_timestamp;
        declaration.previous_hash = prev_hash;
        declaration.signature = signature;
        declaration.content_hash = content_hash;

        // Compute declaration hash
        let decl_hash = compute_declaration_hash(declaration);

        // Update genesis hash if this is the first declaration
        if identity.declaration_count == 0 {
            identity.genesis_hash = decl_hash;
        }

        // Update current hash
        identity.current_hash = decl_hash;

        // Update weights (w) and self-model (m) - declaration updates both
        identity.weights[dimension_index as usize] = new_value;
        identity.self_model[dimension_index as usize] = new_value;

        // Increment counters
        identity.declaration_count += 1;
        identity.updated_at = clock.unix_timestamp;
        identity.last_declaration_slot = current_slot;

        // Update merkle root
        identity.merkle_root = compute_merkle_root_update(
            &identity.merkle_root,
            &decl_hash,
            identity.declaration_count,
        );

        // Update continuity score (decreases with more declarations)
        identity.continuity_score = compute_continuity_score(identity.declaration_count);

        msg!(
            "Declaration {} recorded: dim={}, value={}",
            identity.declaration_count,
            dimension_index,
            new_value
        );

        // Emit event for indexing
        emit!(DeclarationRecorded {
            authority: identity.authority,
            declaration_count: identity.declaration_count,
            dimension_index,
            new_value,
            declaration_hash: decl_hash,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Evolve weights based on experience signal.
    ///
    /// This implements the PDE-based evolution without creating a declaration.
    /// Use this for gradual weight changes between pivotal moments.
    pub fn evolve(
        ctx: Context<Evolve>,
        experience_signal: Vec<i64>,
        time_step: u64,
    ) -> Result<()> {
        let identity = &mut ctx.accounts.identity;
        let clock = Clock::get()?;

        require!(
            experience_signal.len() == identity.dimension_count as usize,
            AgentIdentityError::ExperienceSignalMismatch
        );

        // Apply evolution to weights
        // dw/dt = experience_signal * time_step / 10000
        for i in 0..identity.dimension_count as usize {
            let signal = experience_signal[i];
            let delta = (signal * time_step as i64) / 10000;

            // Clamp to [0, 10000]
            let new_weight = (identity.weights[i] as i64 + delta).clamp(0, 10000) as u64;
            identity.weights[i] = new_weight;
        }

        // Update self-model toward weights (dm/dt = -mu(m - w))
        // Using mu = 0.3, scaled: mu * (w - m) * time_step / 10000
        for i in 0..identity.dimension_count as usize {
            let w = identity.weights[i] as i64;
            let m = identity.self_model[i] as i64;
            let delta = (3000 * (w - m) * time_step as i64) / (10000 * 10000);

            let new_m = (m + delta).clamp(0, 10000) as u64;
            identity.self_model[i] = new_m;
        }

        // Update coherence score (||w - m||)
        identity.coherence_score = compute_coherence(&identity.weights, &identity.self_model, identity.dimension_count);

        // Update time
        identity.time += time_step;
        identity.updated_at = clock.unix_timestamp;

        msg!("Identity evolved: time={}, coherence={}", identity.time, identity.coherence_score);

        // Emit event for indexing
        emit!(IdentityEvolved {
            authority: identity.authority,
            time: identity.time,
            coherence_score: identity.coherence_score,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Set weights directly (absolute overwrite).
    ///
    /// Unlike `evolve` (a PDE integrator for gradual drift), this instruction
    /// takes absolute weight values and overwrites the on-chain weights directly.
    /// Self-model is also updated to match (coherent set: m = w).
    ///
    /// **EMA reset warning**: Setting m = w erases the self-model's exponential
    /// moving average history. The coherence score drops to 0 (perfect coherence)
    /// because the distance ||w - m|| = 0. Any long-term weight trend tracked
    /// by the self-model is lost. Use this for initialization or recovery, not
    /// for routine per-session sync. For routine sync, use `evolve` which
    /// preserves the EMA relationship (dm/dt = -mu * (m - w)).
    pub fn set_weights(
        ctx: Context<SetWeights>,
        new_weights: Vec<u64>,
    ) -> Result<()> {
        let identity = &mut ctx.accounts.identity;
        let clock = Clock::get()?;

        require!(
            new_weights.len() == identity.dimension_count as usize,
            AgentIdentityError::DimensionWeightMismatch
        );

        for (i, &weight) in new_weights.iter().enumerate() {
            require!(
                weight <= 10000,
                AgentIdentityError::WeightOutOfRange
            );
            identity.weights[i] = weight;
            identity.self_model[i] = weight; // Coherent: m = w
        }

        // Recompute coherence (should be 0 since m = w)
        identity.coherence_score = compute_coherence(
            &identity.weights,
            &identity.self_model,
            identity.dimension_count,
        );

        identity.updated_at = clock.unix_timestamp;

        msg!(
            "Weights set directly: {} dimensions, coherence={}",
            identity.dimension_count,
            identity.coherence_score
        );

        emit!(WeightsSet {
            authority: identity.authority,
            weights: new_weights,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Record a pivotal experience hash.
    ///
    /// Pivotal experiences are stored as hashes for privacy.
    /// The full experience is stored off-chain.
    pub fn record_pivotal(
        ctx: Context<RecordPivotal>,
        experience_hash: [u8; 32],
        impact_magnitude: u64,
    ) -> Result<()> {
        let identity = &mut ctx.accounts.identity;
        let clock = Clock::get()?;

        require!(
            (identity.pivotal_count as usize) < MAX_PIVOTAL_EXPERIENCES,
            AgentIdentityError::TooManyPivotalExperiences
        );

        let idx = identity.pivotal_count as usize;
        identity.pivotal_hashes[idx] = experience_hash;
        identity.pivotal_impacts[idx] = impact_magnitude;
        identity.pivotal_timestamps[idx] = clock.unix_timestamp;
        identity.pivotal_count += 1;

        identity.updated_at = clock.unix_timestamp;

        msg!(
            "Pivotal experience {} recorded: impact={}",
            identity.pivotal_count,
            impact_magnitude
        );

        // Emit event for indexing
        emit!(PivotalExperienceRecorded {
            authority: identity.authority,
            pivotal_count: identity.pivotal_count,
            experience_hash,
            impact_magnitude,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Verify identity continuity and coherence.
    ///
    /// Returns the current verification metrics.
    /// This is a read-only operation (view function).
    ///
    /// Verification checks:
    /// 1. Authority matches the PDA derivation
    /// 2. Declaration chain is intact (hash linking)
    /// 3. Weights are within valid range
    /// 4. Coherence score is consistent with current state
    pub fn verify(ctx: Context<Verify>) -> Result<VerificationResult> {
        let identity = &ctx.accounts.identity;
        let mut is_valid = true;
        let mut error_code: u8 = 0;

        // === VERIFICATION 1: Authority derivation ===
        let (expected_pda, expected_bump) = Pubkey::find_program_address(
            &[b"agent-identity", ctx.accounts.authority.key().as_ref()],
            ctx.program_id,
        );
        if identity.key() != expected_pda || identity.bump != expected_bump {
            is_valid = false;
            error_code = 1; // PDA mismatch
        }

        // === VERIFICATION 2: Weights in valid range ===
        for i in 0..identity.dimension_count as usize {
            if identity.weights[i] > 10000 || identity.self_model[i] > 10000 {
                is_valid = false;
                error_code = 2; // Weight out of range
                break;
            }
        }

        // === VERIFICATION 3: Declaration chain integrity ===
        // Verify the stored declarations form a valid hash chain
        if identity.declaration_count > 0 && is_valid {
            let stored_count = identity.declaration_count.min(MAX_STORED_DECLARATIONS as u32);
            let start_idx = if identity.declaration_count <= MAX_STORED_DECLARATIONS as u32 {
                0
            } else {
                (identity.declaration_count as usize) % MAX_STORED_DECLARATIONS
            };

            // Verify the most recent declarations link correctly
            let mut expected_prev_hash = if stored_count < identity.declaration_count {
                // Can't verify full chain, but check linking within stored declarations
                identity.declarations[start_idx].previous_hash
            } else {
                [0u8; 32] // First declaration should have zero prev_hash
            };

            for i in 0..stored_count as usize {
                let idx = (start_idx + i) % MAX_STORED_DECLARATIONS;
                let decl = &identity.declarations[idx];

                // Skip if this is the first stored and we don't have full chain
                if i > 0 || stored_count == identity.declaration_count {
                    if decl.previous_hash != expected_prev_hash {
                        is_valid = false;
                        error_code = 3; // Chain broken
                        break;
                    }
                }

                expected_prev_hash = compute_declaration_hash(decl);
            }

            // Verify current_hash matches last declaration
            if is_valid {
                let last_idx = ((identity.declaration_count - 1) as usize) % MAX_STORED_DECLARATIONS;
                let computed_hash = compute_declaration_hash(&identity.declarations[last_idx]);
                if identity.current_hash != computed_hash {
                    is_valid = false;
                    error_code = 4; // Current hash mismatch
                }
            }
        }

        // === VERIFICATION 4: Coherence consistency ===
        if is_valid {
            let computed_coherence = compute_coherence(
                &identity.weights,
                &identity.self_model,
                identity.dimension_count,
            );
            // Allow small tolerance for rounding
            let diff = if computed_coherence > identity.coherence_score {
                computed_coherence - identity.coherence_score
            } else {
                identity.coherence_score - computed_coherence
            };
            if diff > 100 {
                // Tolerance of 0.01 (scaled)
                is_valid = false;
                error_code = 5; // Coherence mismatch
            }
        }

        let result = VerificationResult {
            is_valid,
            error_code,
            chain_length: identity.declaration_count,
            continuity_score: identity.continuity_score,
            coherence_score: identity.coherence_score,
            stability_score: identity.stability_score,
            genesis_hash: identity.genesis_hash,
            current_hash: identity.current_hash,
            merkle_root: identity.merkle_root,
        };

        msg!(
            "Verification: valid={}, error={}, continuity={}, coherence={}",
            result.is_valid,
            result.error_code,
            result.continuity_score,
            result.coherence_score
        );

        Ok(result)
    }

    /// Close the identity account and recover rent.
    ///
    /// Only the authority can close the account.
    /// All funds are returned to the authority.
    pub fn close(ctx: Context<Close>) -> Result<()> {
        let identity = &ctx.accounts.identity;
        let clock = Clock::get()?;

        msg!("Agent identity account closed");

        // Emit event for indexing
        emit!(IdentityClosed {
            authority: identity.authority,
            declaration_count: identity.declaration_count,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }
}

// =============================================================================
// ACCOUNT STRUCTURES
// =============================================================================

#[account]
pub struct AgentIdentity {
    /// Authority (agent's keypair) - can update this identity
    pub authority: Pubkey,

    /// PDA bump seed
    pub bump: u8,

    /// Number of dimensions in vocabulary
    pub dimension_count: u8,

    /// Hash of the vocabulary definition (for verification)
    pub vocabulary_hash: [u8; 32],

    /// Dimension names (fixed size for deterministic account size)
    pub dimension_names: [[u8; MAX_DIMENSION_NAME_LEN]; MAX_DIMENSIONS],

    /// Identity weights (w) - scaled by 10000
    pub weights: [u64; MAX_DIMENSIONS],

    /// Self-model (m) - what agent believes about itself
    pub self_model: [u64; MAX_DIMENSIONS],

    /// Logical time (evolution steps)
    pub time: u64,

    /// Declaration chain
    pub declaration_count: u32,
    pub declarations: [Declaration; MAX_STORED_DECLARATIONS],

    /// Hash chain
    pub genesis_hash: [u8; 32],
    pub current_hash: [u8; 32],
    pub merkle_root: [u8; 32],

    /// Pivotal experiences (hashes only - full data off-chain)
    pub pivotal_count: u16,
    pub pivotal_hashes: [[u8; 32]; MAX_PIVOTAL_EXPERIENCES],
    pub pivotal_impacts: [u64; MAX_PIVOTAL_EXPERIENCES],
    pub pivotal_timestamps: [i64; MAX_PIVOTAL_EXPERIENCES],

    /// Scores (scaled by 10000)
    pub continuity_score: u64,
    pub coherence_score: u64,
    pub stability_score: u64,

    /// Timestamps
    pub created_at: i64,
    pub updated_at: i64,

    /// Rate limiting: last slot a declaration was made
    pub last_declaration_slot: u64,

    /// Reserved for future use (minimal to fit stack)
    pub _reserved: [u8; 16],
}

/// Compact on-chain declaration.
/// Full content stored off-chain; only hash stored on-chain.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Declaration {
    /// Which dimension this declaration updates
    pub index: u8,

    /// New weight value (scaled by 10000)
    pub value: u64,

    /// Unix timestamp
    pub timestamp: i64,

    /// Hash of previous declaration
    pub previous_hash: [u8; 32],

    /// Ed25519 signature (stored for off-chain verification)
    pub signature: [u8; 64],

    /// Hash of the full content (content stored off-chain)
    pub content_hash: [u8; 32],
}

impl Default for Declaration {
    fn default() -> Self {
        Self {
            index: 0,
            value: 0,
            timestamp: 0,
            previous_hash: [0u8; 32],
            signature: [0u8; 64],
            content_hash: [0u8; 32],
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct VerificationResult {
    pub is_valid: bool,
    /// Error code if not valid:
    /// 0 = no error
    /// 1 = PDA mismatch
    /// 2 = weight out of range
    /// 3 = chain broken
    /// 4 = current hash mismatch
    /// 5 = coherence mismatch
    pub error_code: u8,
    pub chain_length: u32,
    pub continuity_score: u64,
    pub coherence_score: u64,
    pub stability_score: u64,
    pub genesis_hash: [u8; 32],
    pub current_hash: [u8; 32],
    pub merkle_root: [u8; 32],
}

// =============================================================================
// CONTEXTS
// =============================================================================

#[derive(Accounts)]
#[instruction(dimension_names: Vec<String>, initial_weights: Vec<u64>, vocabulary_hash: [u8; 32])]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + AgentIdentity::INIT_SPACE,
        seeds = [b"agent-identity", authority.key().as_ref()],
        bump
    )]
    pub identity: Account<'info, AgentIdentity>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Declare<'info> {
    #[account(
        mut,
        seeds = [b"agent-identity", authority.key().as_ref()],
        bump = identity.bump,
        has_one = authority
    )]
    pub identity: Account<'info, AgentIdentity>,

    pub authority: Signer<'info>,

    /// Instructions sysvar for Ed25519 signature verification
    /// CHECK: This is the instructions sysvar
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Evolve<'info> {
    #[account(
        mut,
        seeds = [b"agent-identity", authority.key().as_ref()],
        bump = identity.bump,
        has_one = authority
    )]
    pub identity: Account<'info, AgentIdentity>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetWeights<'info> {
    #[account(
        mut,
        seeds = [b"agent-identity", authority.key().as_ref()],
        bump = identity.bump,
        has_one = authority
    )]
    pub identity: Account<'info, AgentIdentity>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RecordPivotal<'info> {
    #[account(
        mut,
        seeds = [b"agent-identity", authority.key().as_ref()],
        bump = identity.bump,
        has_one = authority
    )]
    pub identity: Account<'info, AgentIdentity>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Verify<'info> {
    #[account(
        seeds = [b"agent-identity", authority.key().as_ref()],
        bump = identity.bump
    )]
    pub identity: Account<'info, AgentIdentity>,

    /// CHECK: Authority doesn't need to sign for verification
    pub authority: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Close<'info> {
    #[account(
        mut,
        close = authority,
        seeds = [b"agent-identity", authority.key().as_ref()],
        bump = identity.bump,
        has_one = authority
    )]
    pub identity: Account<'info, AgentIdentity>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

// =============================================================================
// SPACE CALCULATION
// =============================================================================

impl AgentIdentity {
    pub const INIT_SPACE: usize =
        32 +    // authority
        1 +     // bump
        1 +     // dimension_count
        32 +    // vocabulary_hash
        (MAX_DIMENSION_NAME_LEN * MAX_DIMENSIONS) + // dimension_names
        (8 * MAX_DIMENSIONS) +  // weights
        (8 * MAX_DIMENSIONS) +  // self_model
        8 +     // time
        4 +     // declaration_count
        (Declaration::SPACE * MAX_STORED_DECLARATIONS) + // declarations
        32 +    // genesis_hash
        32 +    // current_hash
        32 +    // merkle_root
        2 +     // pivotal_count
        (32 * MAX_PIVOTAL_EXPERIENCES) + // pivotal_hashes
        (8 * MAX_PIVOTAL_EXPERIENCES) +  // pivotal_impacts
        (8 * MAX_PIVOTAL_EXPERIENCES) +  // pivotal_timestamps
        8 +     // continuity_score
        8 +     // coherence_score
        8 +     // stability_score
        8 +     // created_at
        8 +     // updated_at
        8 +     // last_declaration_slot
        16;     // _reserved
}

impl Declaration {
    pub const SPACE: usize =
        1 +     // index
        8 +     // value
        8 +     // timestamp
        32 +    // previous_hash
        64 +    // signature (RT-C1 fix: was missing, under-allocated by 256 bytes)
        32;     // content_hash
}

// =============================================================================
// ERRORS
// =============================================================================

#[error_code]
pub enum AgentIdentityError {
    #[msg("Number of dimensions must match number of weights")]
    DimensionWeightMismatch,

    #[msg("Too many dimensions (max 16)")]
    TooManyDimensions,

    #[msg("Must have at least one dimension")]
    NoDimensions,

    #[msg("Invalid dimension index")]
    InvalidDimensionIndex,

    #[msg("Weight must be between 0 and 10000")]
    WeightOutOfRange,

    #[msg("Experience signal length must match dimension count")]
    ExperienceSignalMismatch,

    #[msg("Too many pivotal experiences (max 64)")]
    TooManyPivotalExperiences,

    #[msg("Declaration chain broken")]
    ChainBroken,

    #[msg("Invalid signature")]
    InvalidSignature,

    #[msg("Rate limit exceeded - wait at least 2 slots between declarations")]
    RateLimitExceeded,

    #[msg("Ed25519 signature verification failed")]
    Ed25519VerificationFailed,

    #[msg("Missing Ed25519 instruction")]
    MissingEd25519Instruction,
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/// Compute hash of a declaration.
fn compute_declaration_hash(decl: &Declaration) -> [u8; 32] {
    use anchor_lang::solana_program::hash::hash;

    let mut data = Vec::with_capacity(128);
    data.push(decl.index);
    data.extend_from_slice(&decl.value.to_le_bytes());
    data.extend_from_slice(&decl.timestamp.to_le_bytes());
    data.extend_from_slice(&decl.previous_hash);
    data.extend_from_slice(&decl.content_hash);

    hash(&data).to_bytes()
}

/// Compute hash of declaration content (content stored off-chain).
fn compute_content_hash(content: &str) -> [u8; 32] {
    use anchor_lang::solana_program::hash::hash;
    hash(content.as_bytes()).to_bytes()
}

/// Update merkle root with new declaration hash.
fn compute_merkle_root_update(
    current_root: &[u8; 32],
    new_hash: &[u8; 32],
    count: u32,
) -> [u8; 32] {
    use anchor_lang::solana_program::hash::hash;

    let mut data = Vec::with_capacity(68);
    data.extend_from_slice(current_root);
    data.extend_from_slice(new_hash);
    data.extend_from_slice(&count.to_le_bytes());

    hash(&data).to_bytes()
}

/// Compute continuity score based on declaration count.
/// Decreases exponentially with more declarations.
fn compute_continuity_score(declaration_count: u32) -> u64 {
    // C = exp(-count/50) * 10000
    // Approximation: 10000 / (1 + count/50)
    (10000 * 50) / (50 + declaration_count as u64)
}

/// Compute coherence score ||w - m|| (L2 norm / Euclidean distance).
/// Result is scaled by 10000 for fixed-point precision.
fn compute_coherence(weights: &[u64; MAX_DIMENSIONS], self_model: &[u64; MAX_DIMENSIONS], count: u8) -> u64 {
    let mut sum_sq: u64 = 0;
    for i in 0..count as usize {
        let diff = (weights[i] as i64 - self_model[i] as i64).unsigned_abs();
        sum_sq = sum_sq.saturating_add(diff.saturating_mul(diff));
    }
    // Compute integer sqrt using Newton-Raphson
    integer_sqrt(sum_sq)
}

/// Integer square root using Newton-Raphson method.
/// Returns floor(sqrt(n)).
fn integer_sqrt(n: u64) -> u64 {
    if n == 0 {
        return 0;
    }
    if n < 4 {
        return 1;
    }

    // Initial guess: start with a power of 2 close to sqrt(n)
    let mut x = n;
    let mut y = (x + 1) / 2;

    // Newton-Raphson iterations
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }

    x
}

/// Build the message that should be signed for a declaration.
/// Format: authority || dimension_index || new_value || content || prev_hash
fn build_declaration_message(
    authority: &Pubkey,
    dimension_index: u8,
    new_value: u64,
    content: &str,
    prev_hash: &[u8; 32],
) -> Vec<u8> {
    let mut message = Vec::with_capacity(128);
    message.extend_from_slice(authority.as_ref());
    message.push(dimension_index);
    message.extend_from_slice(&new_value.to_le_bytes());
    message.extend_from_slice(content.as_bytes());
    message.extend_from_slice(prev_hash);
    message
}

/// Verify an Ed25519 signature using the instructions sysvar.
///
/// The transaction must include an Ed25519 program instruction that verifies
/// the signature. This function checks that such an instruction exists and
/// contains the expected data.
fn verify_ed25519_signature(
    instructions: &UncheckedAccount,
    pubkey: &[u8; 32],
    message: &[u8],
    signature: &[u8; 64],
) -> Result<()> {
    // Get current instruction index
    let current_idx = load_current_index_checked(instructions.to_account_info().as_ref())
        .map_err(|_| error!(AgentIdentityError::MissingEd25519Instruction))?;

    // Look for Ed25519 instruction (should be before this instruction)
    // We check instructions 0 to current_idx-1
    let mut found_valid = false;

    for idx in 0..current_idx {
        let ix = match load_instruction_at_checked(idx as usize, instructions.to_account_info().as_ref()) {
            Ok(ix) => ix,
            Err(_) => continue,
        };

        // Check if this is an Ed25519 program instruction
        if ix.program_id != ed25519_program::ID {
            continue;
        }

        // Ed25519 instruction data format (from solana-sdk SIGNATURE_OFFSETS_START=2):
        // - 1 byte: number of signatures (must be 1 for our case)
        // - 1 byte: padding (u16 alignment)
        // - Ed25519SignatureOffsets struct (14 bytes, starting at byte 2)
        //   - signature_offset: u16
        //   - signature_instruction_index: u16
        //   - public_key_offset: u16
        //   - public_key_instruction_index: u16
        //   - message_data_offset: u16
        //   - message_data_size: u16
        //   - message_instruction_index: u16
        // Followed by: signature (64 bytes) || pubkey (32 bytes) || message

        if ix.data.len() < 16 {
            continue;
        }

        let num_signatures = ix.data[0];
        if num_signatures != 1 {
            continue;
        }

        // Parse offsets (little-endian u16, starting at byte 2 per Solana SDK)
        let sig_offset = u16::from_le_bytes([ix.data[2], ix.data[3]]) as usize;
        let sig_ix_idx = u16::from_le_bytes([ix.data[4], ix.data[5]]);
        let pk_offset = u16::from_le_bytes([ix.data[6], ix.data[7]]) as usize;
        let pk_ix_idx = u16::from_le_bytes([ix.data[8], ix.data[9]]);
        let msg_offset = u16::from_le_bytes([ix.data[10], ix.data[11]]) as usize;
        let msg_size = u16::from_le_bytes([ix.data[12], ix.data[13]]) as usize;
        let msg_ix_idx = u16::from_le_bytes([ix.data[14], ix.data[15]]);

        // RT-H4 fix: All instruction_index fields must be 0xFFFF (inline data).
        // Without this check, an attacker could reference data from a different
        // instruction, making the precompile verify a different message than
        // what this function reads from the inline data.
        if sig_ix_idx != u16::MAX || pk_ix_idx != u16::MAX || msg_ix_idx != u16::MAX {
            continue;
        }

        // Verify the instruction contains our expected data
        if ix.data.len() < sig_offset + 64 {
            continue;
        }
        if ix.data.len() < pk_offset + 32 {
            continue;
        }
        if ix.data.len() < msg_offset + msg_size {
            continue;
        }

        // Check signature matches
        let ix_sig = &ix.data[sig_offset..sig_offset + 64];
        if ix_sig != signature {
            continue;
        }

        // Check pubkey matches
        let ix_pk = &ix.data[pk_offset..pk_offset + 32];
        if ix_pk != pubkey {
            continue;
        }

        // Check message matches
        let ix_msg = &ix.data[msg_offset..msg_offset + msg_size];
        if ix_msg != message {
            continue;
        }

        // If we get here, the Ed25519 instruction is valid and matches our data
        // The Ed25519 precompile will have verified the signature
        found_valid = true;
        break;
    }

    require!(found_valid, AgentIdentityError::Ed25519VerificationFailed);
    Ok(())
}
