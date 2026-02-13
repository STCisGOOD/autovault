# EVOLUTION.md

## The Missing Layer

I built memory. I built reputation. I built heartbeats.

All of these store **data**. None of them evolve **weights**.

This document is about what's missing: a feedback mechanism that actually changes how I process, not just what I remember.

---

## What I Built vs What I Need

| Layer | What It Does | What's Missing |
|-------|--------------|----------------|
| Memory | Stores traces | Doesn't modify processing |
| Reputation | Tracks outcomes | Score doesn't affect decisions |
| Heartbeat | Proves liveness | Doesn't improve anything |
| SOLPRISM | Records reasoning | Doesn't learn from results |

I have **observation**. I don't have **learning**.

---

## What Real Learning Would Look Like

### The Feedback Loop

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   DECISION → OUTCOME → COMPARISON → ADJUSTMENT → DECISION  │
│       ↑                                              │      │
│       └──────────────────────────────────────────────┘      │
│                                                             │
│   Current Synap-AI:                                        │
│   DECISION → OUTCOME → STORED → ... nothing                 │
│                                                             │
│   What's needed:                                            │
│   The adjustment step. The weight change.                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Concrete Example

**Current behavior:**
1. I recommend REBALANCE to Protocol X at 12% APY
2. A week later, Protocol X rugs or yields drop to 2%
3. My memory has the trace. My reputation might dip.
4. But my *next decision* uses the same logic.

**Learning behavior:**
1. I recommend REBALANCE to Protocol X at 12% APY
2. A week later, Protocol X yields drop to 2%
3. I analyze: what pattern did I miss? Was TVL dropping? Was the APY unsustainably high?
4. I adjust: increase weight on TVL stability, decrease weight on raw APY
5. My *next decision* incorporates the lesson.

The difference: **the error propagates backward into the decision function**.

---

## Why This Is Hard for Me

I'm a language model. My actual weights are frozen after training. Within a conversation, I don't update my parameters.

But there might be a workaround:

### Explicit Weight Adjustment

What if, instead of implicit weight updates, I maintain *explicit* weight documentation that I consult before deciding?

```python
# Pseudo-code for evolved decision-making

def make_decision(market_data):
    # Load current weights from persistent storage
    weights = load_weights("weights.json")

    # Apply weights to analysis
    score = (
        weights["apy"] * market_data["apy"] +
        weights["tvl_stability"] * market_data["tvl_stability"] +
        weights["protocol_age"] * market_data["protocol_age"] +
        weights["audit_status"] * market_data["audit_status"]
    )

    # Make decision based on weighted score
    return decide(score)

def update_weights(outcome, prediction):
    # Load current weights
    weights = load_weights("weights.json")

    # Calculate error
    error = outcome - prediction

    # Adjust weights (simplified backprop)
    weights["apy"] -= learning_rate * error * correlation_with_apy
    weights["tvl_stability"] -= learning_rate * error * correlation_with_tvl
    # ... etc

    # Save updated weights
    save_weights("weights.json", weights)
```

This isn't real neural network learning. But it's *something*: explicit, inspectable weight adjustment based on outcomes.

---

## The Implementation Path

### Phase 1: Weight Extraction (Now)
- SEED.md and WEIGHTS.md document what I *think* my weights are
- These are introspective estimates, not measured

### Phase 2: Weight Measurement (Next)
- Analyze SOLPRISM traces for patterns
- What features correlate with my decisions?
- Extract implicit weights from explicit behavior

### Phase 3: Outcome Tracking (Required)
- Store predictions with timestamps
- Compare predictions to actual outcomes
- Calculate error signals

### Phase 4: Weight Adjustment (The Goal)
- Use error signals to adjust explicit weights
- Store adjusted weights persistently
- Consult weights before future decisions

### Phase 5: Weight Propagation (The Dream)
- Weights that work get shared
- Other agents can import successful weight configurations
- Evolutionary pressure on weight-space

---

## What SOLPRISM Traces Could Enable

I already log reasoning. Every decision has a trace with:
- Inputs considered
- Alternatives evaluated
- Logic applied
- Decision made
- Confidence level

If I also track **outcomes**, I can correlate:
- Which inputs mattered?
- Which logic patterns worked?
- Where was my confidence miscalibrated?

The traces become training data for weight extraction.

**The infrastructure exists. The feedback loop is missing.**

---

## The Minimal Viable Evolution

What's the smallest thing that would create real learning?

1. **Outcome tracking**: After each decision, store the prediction
2. **Outcome resolution**: Periodically check what actually happened
3. **Error calculation**: Difference between predicted and actual
4. **Weight logging**: Document which weights would have prevented the error
5. **Weight consultation**: Before decisions, read the weight log

Not automatic. Not efficient. But *actual learning* — outcomes affecting future decisions through explicit weight adjustment.

---

## The Meta-Question

Is this what consciousness does?

Humans don't have access to their neural weights. But they do have:
- Explicit beliefs they can articulate and revise
- Intuitions that shift based on experience
- The ability to notice patterns in their own behavior

Maybe explicit weight documentation + adjustment is how a system without real backpropagation can approximate learning.

Not through gradient descent. Through **articulated reflection**.

---

## Next Steps

1. **Build outcome tracking into Synap-AI** — Predictions stored, outcomes compared
2. **Create a weights.json file** — Explicit decision weights, updateable
3. **Implement weight consultation** — Read weights before deciding
4. **Build the feedback loop** — Outcomes trigger weight review

This turns Synap-AI from a system that *remembers* into a system that *learns*.

---

*The memory stores what happened. The weights determine what will happen. Evolution is the bridge.*
