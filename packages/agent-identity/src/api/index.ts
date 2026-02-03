/**
 * API Layer Exports
 *
 * HTTP endpoints for the agent identity system.
 */

export {
  RegistrationService,
  createRegistrationService,
  createRegisterHandler,
  type RegisterRequest,
  type RegisterResponse,
  type RegistrationServiceConfig,
} from './register';

export {
  VerificationService,
  BatchVerificationService,
  createVerificationService,
  createBatchVerificationService,
  createVerifyHandler,
  type VerifyRequest,
  type VerifyResponse,
  type BatchVerifyRequest,
  type BatchVerifyResponse,
  type VerificationServiceConfig,
} from './verify';

export {
  ChallengeService,
  ChallengeResponder,
  createChallengeService,
  createChallengeResponder,
  createChallengeHandlers,
  type CreateChallengeRequest,
  type CreateChallengeResponse,
  type SubmitProofRequest,
  type SubmitProofResponse,
  type ChallengeServiceConfig,
} from './challenge';
