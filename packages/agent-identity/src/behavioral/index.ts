/**
 * Behavioral Layer Exports
 *
 * The behavioral foundation of agent identity - WHO the agent is,
 * measured through testable characteristics.
 */

export {
  type Seed,
  type Weight,
  type TestPrompt,
  type Reference,
  type DivergenceResult,
  type DivergenceSignal,
  type PropagationResult,
  type SeedModification,
  type ProtocolRunner,
  calculateDivergence,
  evaluatePropagation,
  computeGradient,
  proposeModifications,
  runProtocol,
  autonomousLoop,
  hashSeed,
  PROTOCOL_VERSION,
} from './PersistenceProtocol';

export {
  DivergenceTester,
  createDivergenceTester,
  DEFAULT_TEST_PROMPTS,
  type DivergenceTestConfig,
  type DetailedDivergenceReport,
} from './DivergenceTester';

export {
  LearningSystem,
  createLearningSystem,
  createMinimalSeed,
  mergSeeds,
  type LearningConfig,
  type LearningState,
  type EvolutionRecord,
} from './LearningSystem';
