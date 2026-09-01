import usSpec from '../../specs/campaign-spec-us.json'

export interface SpecRegistryEntry {
  id: string
  file: string
  spec: typeof usSpec
}

export const SPECS: readonly SpecRegistryEntry[] = [
  { id: 'campaign-spec-us', file: 'specs/campaign-spec-us.json', spec: usSpec },
]
