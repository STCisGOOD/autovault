import { tier0Confidence, tier1Confidence, TRAJECTORY_SCHEMA_VERSION, TRAJECTORY_BASE_WEIGHT } from '../types';

describe('tier0Confidence', () => {
  it('returns 0 for count <= 0', () => {
    expect(tier0Confidence(0)).toBe(0.0);
    expect(tier0Confidence(-1)).toBe(0.0);
  });

  it('returns 0.1 for count = 1', () => {
    expect(tier0Confidence(1)).toBe(0.1);
  });

  it('returns 0.5 for count = 3', () => {
    expect(tier0Confidence(3)).toBeCloseTo(0.5);
  });

  it('returns 0.8 for count = 5', () => {
    expect(tier0Confidence(5)).toBeCloseTo(0.8);
  });

  it('returns 1.0 for count = 10', () => {
    expect(tier0Confidence(10)).toBeCloseTo(1.0);
  });

  it('returns 1.0 for count > 10', () => {
    expect(tier0Confidence(15)).toBe(1.0);
    expect(tier0Confidence(100)).toBe(1.0);
  });

  it('interpolates linearly between breakpoints', () => {
    // Between 1 and 3: slope = 0.2 per step
    expect(tier0Confidence(2)).toBeCloseTo(0.3);
    // Between 3 and 5: slope = 0.15 per step
    expect(tier0Confidence(4)).toBeCloseTo(0.65);
    // Between 5 and 10: slope = 0.04 per step
    expect(tier0Confidence(7)).toBeCloseTo(0.88);
  });
});

describe('tier1Confidence', () => {
  it('returns 0 for count <= 0', () => {
    expect(tier1Confidence(0)).toBe(0.0);
    expect(tier1Confidence(-1)).toBe(0.0);
  });

  it('returns 0.2 for count = 1', () => {
    expect(tier1Confidence(1)).toBe(0.2);
  });

  it('returns 0.6 for count = 3', () => {
    expect(tier1Confidence(3)).toBeCloseTo(0.6);
  });

  it('returns 1.0 for count = 5', () => {
    expect(tier1Confidence(5)).toBeCloseTo(1.0);
  });

  it('returns 1.0 for count > 5', () => {
    expect(tier1Confidence(10)).toBe(1.0);
  });

  it('interpolates linearly between breakpoints', () => {
    // Between 1 and 3: slope = 0.2 per step
    expect(tier1Confidence(2)).toBeCloseTo(0.4);
    // Between 3 and 5: slope = 0.2 per step
    expect(tier1Confidence(4)).toBeCloseTo(0.8);
  });
});

describe('constants', () => {
  it('TRAJECTORY_SCHEMA_VERSION is 1', () => {
    expect(TRAJECTORY_SCHEMA_VERSION).toBe(1);
  });

  it('TRAJECTORY_BASE_WEIGHT is 0.02', () => {
    expect(TRAJECTORY_BASE_WEIGHT).toBe(0.02);
  });
});
