/**
 * API Layer Exports
 *
 * HTTP endpoints for the agent identity system.
 *
 * Security Hardening:
 * - API key authentication (auth.ts)
 * - Timing-safe key comparison
 * - Per-key rate limiting
 * - Request audit logging
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

export {
  AuthMiddleware,
  createAuthMiddleware,
  createDevnetAuthMiddleware,
  createMainnetAuthMiddleware,
  createExpressMiddleware,
  hashApiKey,
  generateApiKey,
  getAuditLog,
  getAuditLogForKey,
  type AuthConfig,
  type AuthResult,
  type AuthenticatedRequest,
} from './auth';
