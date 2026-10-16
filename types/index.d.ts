export type VemsEnv = { name: string; path: string; isBase: boolean }
// source 'pip' = installed by pip (conda lists it under the pypi channel); conda can't update or remove it.
export type VemsPackage = { name: string; version: string; source: 'conda' | 'pip' }
// Package name -> the version an update would bring; 'checking' while conda runs, 'error' if it failed.
export type VemsUpdate = Record<string, string> | 'checking' | 'error'
// One package anaconda.org's search found on conda-forge or bioconda.
export type VemsHit = { name: string; version: string; channel: string; summary: string }
// The one box open under the Envs buttons.
export type VemsForm = { kind: 'create' } | { kind: 'import' } | { kind: 'clone'; from: VemsEnv }
// What sits under a tab's buttons: a form or a confirm, never both, so switching is one write.
export type VemsBox = { form: VemsForm } | { ask: VemsPending }
export type VemsTab = 'envs' | 'packages' | 'install'
export type VemsPending = { action: 'install' | 'update' | 'update-all' | 'update-conda' | 'clean' | 'remove' | 'remove-env'; pkg: string; env: VemsEnv }

declare module 'claude-code' {
  interface PluginState {
    vems: {
      tab: VemsTab
      query: string
      selected: VemsEnv | null
      envs: VemsEnv[]
      packages: VemsPackage[]
      busy: string | null
      box: VemsBox | null
      active: VemsEnv | null
      updates: Record<string, VemsUpdate>
      updatesOnly: boolean
      pins: string[]
      hits: VemsHit[] | null
      hitFocus: string | null
      targetPackages: VemsPackage[]
      dots: number
      sizes: Record<string, number>
      cacheSize: number | null
      modUpdate: { current: string; latest: string } | null
      condaVersion: string | null
      draft: string
    }
  }
}
