/**
 * Unified Layer Exports
 *
 * The integration layer that binds cryptographic and behavioral identity.
 */

export {
  UnifiedIdentityService,
  createUnifiedIdentityService,
  type UnifiedIdentity,
  type UnifiedIdentityConfig,
  type IdentityRegistration,
  type RegistrationResult,
  type VerificationResult,
} from './UnifiedIdentityService';

export {
  CombinedVerifier,
  createCombinedVerifier,
  quickVerify,
  type VerificationLevel,
  type CombinedChallenge,
  type CombinedProof,
  type CombinedVerificationResult,
  type VerificationConfig,
} from './CombinedVerification';

export {
  SeedCommitmentManager,
  createSeedCommitmentManager,
  type SeedCommitmentConfig,
  type CommitmentResult,
  type SeedHistory,
} from './SeedAsCommitment';
