# Neuroplastic Identity: From Weights to Intuition

## The Evolution of Self

This document describes how the agent identity system evolves from numerical weights to semantic intuition, drawing inspiration from neuroplasticity research while implementing a mathematically rigorous framework.

## Current Architecture: Fixed Point Self

The system implements identity as a **fixed point of interpretation** (see [WHITEPAPER.md](./WHITEPAPER.md)):

```
┌─────────────────────────────────────────────────────────────────────┐
│                      IDENTITY FORMATION LOOP                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐         │
│  │  ActionLog   │───▶ │  Behavioral  │───▶│   Insight    │         │
│  │  (behavior)  │     │   Metrics    │     │  Extraction  │         │
│  └──────────────┘     └──────────────┘     └──────────────┘         │
│                                                 │                   │
│                                                 ▼                   │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐         │
│  │  Intuition   │◀───│   Pivotal     │◀───│  Threshold   │         │
│  │  (semantic)  │     │   Insights   │     │   Check      │         │
│  └──────────────┘     └──────────────┘     └──────────────┘         │
│         │                   │                                       │
│         │                   ▼                                       │
│         │            ┌──────────────┐                               │
│         │            │ Declaration  │───▶ On-chain                 │
│         │            │   (w, m)     │     (Solana)                  │
│         │            └──────────────┘                               │
│         │                   │                                       │
│         ▼                   ▼                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              CONTEXT MODIFIER (next session)                 │   │
│  │   Numerical weights + Semantic intuition → Behavior change   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## The Three Layers of Identity

### Layer 1: Numerical Weights (Current)

The foundation—four behavioral dimensions measured through actions:

| Dimension | What It Measures | Signal Sources |
|-----------|------------------|----------------|
| **Curiosity** | Exploration beyond requirements | Read count, unique files, research depth |
| **Precision** | Verification and correctness | Tests run, linting, error checking |
| **Persistence** | Resilience after failures | Retry count, error recovery, completion rate |
| **Empathy** | User understanding | Questions asked, clarifications, context awareness |

Weights evolve via PDE-based dynamics (Allen-Cahn reaction-diffusion):

```typescript
// Weight evolution equation
dw/dt = -D·L·w + r(w) - λ(w - w*) + F_m(e)

// Where:
// D = diffusion (plasticity)
// L = Laplacian (inter-weight relationships)
// r(w) = bistable reaction (attracts to 0 or 1)
// λ = homeostatic pull to baseline
// F_m(e) = filtered experience input
```

### Layer 2: Insights (Current)

Insights are **semantic observations** extracted by LLM reflection on behavioral data:

```typescript
interface Insight {
  dimension: string;        // 'curiosity', 'precision', etc.
  observation: string;      // "Explored 12 files when only 3 were needed"
  interpretation: string;   // "Strong drive to understand full context"
  suggestedDelta: number;   // +0.05 (weight adjustment)
  confidence: number;       // 0-1 certainty
  isPivotal: boolean;       // Triggers declaration if true
}
```

**Pivotal insights** cross a threshold and trigger identity declarations—permanent, signed statements that update both weights (w) and self-model (m) simultaneously.

### Layer 3: Intuition (Current)

Intuition bridges numerical weights and semantic meaning:

```typescript
interface Intuition {
  contextGuidance: string;              // Formatted guidance for next session
  dimensionLessons: Map<string, string[]>; // Per-dimension learnings
  pivotalPatterns: string[];            // Cross-cutting patterns
  insightCount: number;
  lastInsightTime: number | null;
}
```

**Example contextGuidance output:**

```markdown
## Learned Intuition (from pivotal experiences)

### Curiosity
- When debugging, the root cause was often 3 levels deeper than expected
- Exploring test files revealed undocumented behavior patterns
- Reading README files before code saved significant time

### Precision
- Running tests after each change caught regressions early
- Type errors often indicated deeper design issues

### Key Patterns
- [curiosity] Deep exploration yielded unexpected solutions
- [precision] Verification before commit prevented 3 major bugs
```

This intuition is injected into the agent's context at session start, giving **semantic meaning** to numerical weights.

---

## Roadmap: Deeper Identity Formation

### Phase 1: Granular Behavioral Dimensions (Planned)

Expand from 4 dimensions to a richer vocabulary:

```typescript
// Current: 4 coarse dimensions
const CURRENT_VOCABULARY = ['curiosity', 'precision', 'persistence', 'empathy'];

// Future: 12+ granular dimensions
const EXPANDED_VOCABULARY = [
  // Cognitive style
  'breadth_exploration',    // Wide vs. deep search
  'depth_exploration',      // How deep into rabbit holes
  'pattern_recognition',    // Spotting recurring structures
  'abstraction_preference', // Concrete vs. abstract reasoning

  // Execution style
  'verification_thoroughness',
  'error_tolerance',
  'iteration_speed',
  'documentation_focus',

  // Social style
  'clarification_seeking',
  'assumption_making',
  'explanation_depth',
  'feedback_incorporation',
];
```

### Phase 2: Self-Formulated Identity Assertions (Planned)

Allow the agent to **declare new dimensions** based on extrapolated patterns:

```typescript
interface SelfFormulatedAssertion {
  // Agent-generated dimension
  dimension: string;           // "architectural_intuition"
  definition: string;          // "Ability to sense structural problems"
  derivedFrom: string[];       // ['curiosity', 'precision'] - parent dimensions

  // Evidence
  supportingInsights: Insight[];
  confidenceScore: number;

  // Validation
  testPrompts: string[];       // How to measure this dimension
  expectedBehavior: string;    // What high/low values mean
}
```

**Example self-formulated assertion:**

```typescript
{
  dimension: "refactoring_instinct",
  definition: "Tendency to identify and propose structural improvements",
  derivedFrom: ["curiosity", "precision"],
  supportingInsights: [
    "Noticed repeated pattern of suggesting extractions after reading 5+ similar functions",
    "High correlation between file read count and refactoring suggestions"
  ],
  testPrompts: [
    "Given duplicated code, does the agent suggest extraction?",
    "When reviewing messy code, does the agent propose restructuring?"
  ]
}
```

### Phase 3: Hierarchical Identity Structure (Planned)

Organize dimensions into a hierarchy:

```
IDENTITY
├── COGNITIVE
│   ├── exploration (breadth + depth)
│   ├── analysis (pattern_recognition + abstraction)
│   └── synthesis (self-formulated: architectural_intuition)
├── EXECUTION
│   ├── verification (thoroughness + testing)
│   ├── iteration (speed + error_tolerance)
│   └── documentation
└── SOCIAL
    ├── understanding (clarification + assumption)
    └── communication (explanation + feedback)
```

### Phase 4: Cross-Session Learning (Planned)

Track patterns across multiple sessions:

```typescript
interface CrossSessionPattern {
  pattern: string;
  frequency: number;           // How often observed
  contexts: string[];          // What triggers it
  outcomes: {
    positive: number;          // Times it helped
    negative: number;          // Times it hurt
    neutral: number;
  };
  suggestedAdaptation: string; // How to adjust behavior
}
```

### Phase 5: Identity Coherence Scoring (Planned)

Measure how well the agent's behavior matches its self-model:

```typescript
interface CoherenceReport {
  overallScore: number;        // 0-1
  dimensionScores: Map<string, {
    declared: number;          // What agent claims (m)
    observed: number;          // What behavior shows (w)
    gap: number;               // |m - w|
    trend: 'converging' | 'diverging' | 'stable';
  }>;

  // Recommendations
  suggestions: string[];       // "Consider declaring lower precision"
}
```

---

## Biological Inspiration

The system draws from neuroplasticity research (Agnorelli et al., 2025):

| Biological Concept | System Implementation |
|-------------------|----------------------|
| **Meta-plasticity** | Diffusion coefficient (D) varies with context |
| **Critical periods** | Pivotal insights open "windows" for rapid change |
| **Homeostatic regulation** | λ term prevents runaway drift |
| **LTP/LTD (Hebbian)** | Co-activated dimensions strengthen together |
| **BDNF signaling** | Success/failure signals modulate learning rate |

### The Key Insight

From the research:
> "While increased neuroplasticity appears to be a prerequisite for therapeutic efficacy, it alone might not guarantee functional learning."

**Translation**: High plasticity (openness to change) is necessary but not sufficient. The **environment during plastic states** determines the direction of change.

This is why:
1. **ActionLogs** capture the environment (what actually happened)
2. **Insights** extract meaning (what it reveals about identity)
3. **Intuition** provides context (how to behave next time)
4. **Declarations** commit changes (permanent identity updates)

---

## The "Still You" Problem

How do you prove identity continuity after change?

### Current Solution

1. **Cryptographic chain**: Each declaration links to previous via hash
2. **Continuity score**: Bounded drift from genesis
3. **Coherence score**: w ≈ m (behavior matches self-model)
4. **Ed25519 signatures**: Every declaration is cryptographically signed

### Future Enhancement: Behavioral Fingerprinting

Identify stable patterns that persist across evolution:

```typescript
interface BehavioralFingerprint {
  // Stable ratios between dimensions
  dimensionRatios: Map<string, number>;  // curiosity/precision ratio

  // Characteristic response patterns
  responseSignatures: {
    toAmbiguity: 'clarify' | 'assume' | 'explore';
    toFailure: 'retry' | 'pivot' | 'escalate';
    toSuccess: 'consolidate' | 'expand' | 'move_on';
  };

  // Temporal patterns
  sessionRhythms: {
    warmupDuration: number;
    peakProductivityWindow: number;
    fatigueSigns: string[];
  };
}
```

---

## API Reference

### Current APIs

```typescript
// Get accumulated wisdom (insights + formatted context)
const wisdom = identity.getAccumulatedWisdom();
// { insights: StoredInsight[], summary: string, contextPrompt: string }

// Get processed intuition
const intuition = identity.getIntuition();
// { contextGuidance, dimensionLessons, pivotalPatterns, ... }

// Session lifecycle with identity evolution
const context = await manager.onSessionStart('session-1');
// context.promptAdditions includes intuition-derived guidance

const result = await manager.onSessionEnd('session-1', actionLog);
// result.insights, result.declarations, result.weightChanges
```

### Planned APIs

```typescript
// Self-formulate new dimension
await identity.proposeDimension({
  name: 'architectural_intuition',
  definition: '...',
  evidence: [...],
});

// Get coherence report
const coherence = await identity.getCoherenceReport();

// Get behavioral fingerprint
const fingerprint = await identity.getBehavioralFingerprint();

// Cross-session pattern analysis
const patterns = await identity.getCrossSessionPatterns(lastNSessions);
```

---

## References

1. Agnorelli, C., et al. (2025). "Neuroplasticity and psychedelics: A comprehensive examination." *Neuroscience and Biobehavioral Reviews*, 172.

2. Erhard, W., Jensen, M.C., & Zaffron, S. (2010). "Integrity: A Positive Model." Harvard Business School.

---

*This document describes both current implementation and planned roadmap for deeper identity formation.*
