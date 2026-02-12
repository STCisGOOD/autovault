/**
 * FilterBar — Sort/filter controls for the gallery.
 */

import { useStore } from '@nanostores/react';
import { $filters, $sortOrder, $agents, updateFilter, setSortOrder } from '../stores/agents';
import { SPECIALTIES, type GalleryFilters, type SortOrder, type SpecialtyKey } from '../lib/types';

const DOMAIN_OPTIONS: { value: GalleryFilters['domain']; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'cognitive', label: 'Cognitive' },
  { value: 'execution', label: 'Execution' },
  { value: 'social', label: 'Social' },
];

const SORT_OPTIONS: { value: SortOrder; label: string }[] = [
  { value: 'trust-desc', label: 'Trust' },
  { value: 'fitness-desc', label: 'Fitness' },
  { value: 'newest', label: 'Newest' },
  { value: 'price-asc', label: 'Price ↑' },
  { value: 'price-desc', label: 'Price ↓' },
];

export default function FilterBar() {
  const filters = useStore($filters);
  const sort = useStore($sortOrder);
  const agents = useStore($agents);

  // Build specialty options from what's actually in the agent list
  const specialtyCounts = new Map<string, number>();
  for (const agent of agents) {
    specialtyCounts.set(agent.specialty, (specialtyCounts.get(agent.specialty) ?? 0) + 1);
  }

  const specialtyOptions: { value: SpecialtyKey | 'all'; label: string; count: number }[] = [
    { value: 'all', label: 'All', count: agents.length },
  ];

  for (const spec of SPECIALTIES) {
    const count = specialtyCounts.get(spec.key) ?? 0;
    if (count > 0) {
      specialtyOptions.push({ value: spec.key, label: spec.short, count });
    }
  }

  const generalistCount = specialtyCounts.get('generalist') ?? 0;
  if (generalistCount > 0) {
    specialtyOptions.push({ value: 'generalist', label: 'Generalist', count: generalistCount });
  }

  return (
    <div className="border-b border-vault-border/50">
      {/* Row 1: Specialty */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-vault-border/30">
        <span className="text-[10px] uppercase tracking-widest text-vault-accent-dim mr-1">
          Specialty
        </span>
        <div className="flex flex-wrap gap-1">
          {specialtyOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => updateFilter('specialty', opt.value)}
              className={`px-2.5 py-1 text-[10px] uppercase tracking-wider border transition-colors
                ${
                  filters.specialty === opt.value
                    ? 'border-vault-accent/40 text-vault-accent bg-vault-accent/10'
                    : 'border-vault-border text-vault-accent-dim hover:text-vault-accent hover:border-vault-accent/20'
                }`}
            >
              {opt.label}
              <span className="ml-1 opacity-50">{opt.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Row 2: Domain, Sort, Verified, Trust */}
      <div className="flex flex-wrap items-center gap-4 px-4 py-2.5">
        {/* Domain filter */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-vault-accent-dim">
            Domain
          </span>
          <div className="flex gap-1">
            {DOMAIN_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => updateFilter('domain', opt.value)}
                className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors
                  ${
                    filters.domain === opt.value
                      ? 'border-vault-accent/40 text-vault-accent bg-vault-accent/10'
                      : 'border-vault-border text-vault-accent-dim hover:text-vault-accent hover:border-vault-accent/20'
                  }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Sort */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-vault-accent-dim">
            Sort
          </span>
          <div className="flex gap-1">
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSortOrder(opt.value)}
                className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors
                  ${
                    sort === opt.value
                      ? 'border-vault-accent/40 text-vault-accent bg-vault-accent/10'
                      : 'border-vault-border text-vault-accent-dim hover:text-vault-accent hover:border-vault-accent/20'
                  }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Verified toggle */}
        <button
          onClick={() => updateFilter('verifiedOnly', !filters.verifiedOnly)}
          className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border transition-colors
            ${
              filters.verifiedOnly
                ? 'border-vault-accent/40 text-vault-accent bg-vault-accent/10'
                : 'border-vault-border text-vault-accent-dim hover:text-vault-accent hover:border-vault-accent/20'
            }`}
        >
          Verified only
        </button>

        {/* Trust slider */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-vault-accent-dim">
            Min Trust
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={filters.minTrust}
            onChange={(e) => updateFilter('minTrust', Number(e.target.value))}
            className="w-20 h-1 accent-vault-accent bg-vault-border appearance-none cursor-pointer
                       [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3
                       [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-vault-accent
                       [&::-webkit-slider-thumb]:rounded-full"
          />
          <span className="text-[10px] text-vault-accent-dim w-6 text-right">
            {filters.minTrust}
          </span>
        </div>
      </div>
    </div>
  );
}
