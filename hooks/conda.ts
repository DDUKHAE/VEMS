import type { VemsEnv, VemsHit, VemsPackage } from '../types'

// Package specs go to conda as one argv entry (no shell), but keep them to
// what a spec can hold: name, channel prefix, version constraint.
const SPEC = /^[A-Za-z0-9_.\-]+(::[A-Za-z0-9_.\-]+)?([=<>!]=?[A-Za-z0-9_.*\-]*)*$/

export const isValidSpec = (spec: string) => SPEC.test(spec)

// "myenv python=3.11 samtools" -> name plus package specs, or null if malformed.
export function parseCreate(line: string): { name: string; specs: string[] } | null {
  const [name, ...specs] = line.trim().split(/\s+/)
  if (!name || !isEnvName(name) || !specs.every(isValidSpec)) return null

  return { name, specs }
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// Prefix that activates an env inside one shell command (works in bash and zsh).
export const activatePrefix = (exe: string, env: VemsEnv) =>
  `eval "$(${quote(exe)} shell.posix activate ${quote(env.path)})"`

export function parseEnvs(json: string): VemsEnv[] {
  const data = JSON.parse(json) as {
    envs: string[]
    envs_details?: Record<string, { name?: string; base?: boolean }>
  }

  return data.envs.map(path => {
    const detail = data.envs_details?.[path] ?? {}
    const name = detail.name || path.split('/').pop() || path

    return { name, path, isBase: detail.base === true }
  })
}

// Packages `conda update --all --dry-run --json` would move to a new version (in both
// UNLINK and LINK, version changed; a rebuild of the same version is not an update).
export function parseUpdates(json: string): Record<string, string> {
  type Action = { name: string; version: string }
  const data = JSON.parse(json) as { actions?: { LINK?: Action[]; UNLINK?: Action[] } }
  const old = new Map((data.actions?.UNLINK ?? []).map(p => [p.name, p.version]))
  const found: Record<string, string> = {}
  for (const p of data.actions?.LINK ?? []) {
    const was = old.get(p.name)
    if (was !== undefined && was !== p.version) found[p.name] = p.version
  }

  return found
}

// conda's own pin file: every solve in the env (update --all included) keeps these specs.
export const pinFile = (env: VemsEnv) => `${env.path}/conda-meta/pinned`

const pinName = (line: string) => line.trim().split(/[\s=<>!]/)[0] ?? ''

export const parsePins = (text: string) =>
  text.split('\n').map(pinName).filter(name => name !== '' && !name.startsWith('#'))

// Adds `name ==version`, or drops every line pinning name; other lines are kept as written.
export function togglePin(text: string, name: string, version: string): string {
  const lines = text.split('\n').filter(line => line.trim() !== '')
  const kept = lines.filter(line => pinName(line) !== name)

  return [...kept, ...(kept.length === lines.length ? [`${name} ==${version}`] : [])].join('\n') + '\n'
}

// anaconda.org's (undocumented) search spans every user's channel; keep the two curated ones,
// with an exact name match first.
const CURATED = ['bioconda', 'conda-forge']
export const searchUrl = (query: string) => `https://api.anaconda.org/search?name=${encodeURIComponent(query)}`

export function parseSearch(json: string, query: string): VemsHit[] {
  type Raw = { owner?: string; name?: string; latest_version?: string | null; summary?: string | null }
  const hits = (JSON.parse(json) as Raw[])
    .filter(x => CURATED.includes(x.owner ?? '') && x.name)
    .map(x => ({ name: x.name!, version: x.latest_version ?? '', channel: x.owner!, summary: x.summary ?? '' }))

  return [...hits.filter(h => h.name === query), ...hits.filter(h => h.name !== query)]
}

// `du -k -d 1 <env>`: the env's own size in kB; for base, without envs/ and pkgs/.
export function parseDu(out: string, env: VemsEnv): number {
  const rows = out.trim().split('\n').map(line => {
    const [kb, ...path] = line.split('\t')

    return { kb: Number(kb), path: path.join('\t') }
  })
  const total = rows.find(r => r.path === env.path)?.kb ?? 0
  if (!env.isBase) return total
  const sub = (name: string) => rows.find(r => r.path === `${env.path}/${name}`)?.kb ?? 0

  return total - sub('envs') - sub('pkgs')
}

// What `conda clean --all` would free, in kB. pkgs/ itself is much bigger, but most of it is
// hard-linked into installed envs and stays; conda's dry run counts only what would go.
export function parseCleanable(json: string): number {
  const data = JSON.parse(json) as { tarballs?: { total_size?: number }; packages?: { total_size?: number } }

  return Math.round(((data.tarballs?.total_size ?? 0) + (data.packages?.total_size ?? 0)) / 1024)
}

export const formatSize = (kb: number) =>
  kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)}G` : `${Math.round(kb / 1024)}M`

// The mod's own release check: the manifest on the repo's main branch, compared by version.
export const REPO_MANIFEST = 'https://raw.githubusercontent.com/DDUKHAE/VEMS/main/.claude-plugin/plugin.json'
export const UPDATE_COMMAND = 'claude plugin update vems@vems'

export function isNewer(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number)
  const b = current.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }

  return false
}

export const isEnvName = (name: string) => /^[A-Za-z0-9_.\-]+$/.test(name)

export function parsePackages(json: string): VemsPackage[] {
  const list = JSON.parse(json) as { name: string; version: string; channel: string }[]

  return list.map(({ name, version, channel }) => ({ name, version, source: channel === 'pypi' ? 'pip' : 'conda' }))
}

// pip's names are not normalized the way conda lists them (Foo_Bar vs foo-bar).
const pipKey = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-')

// `pip list --outdated` also reports conda-installed Python packages; keep only pip's own,
// under the name conda lists them by.
export function parsePipOutdated(json: string, pipPackages: VemsPackage[]): Record<string, string> {
  const byKey = new Map(pipPackages.map(p => [pipKey(p.name), p.name]))
  const found: Record<string, string> = {}
  for (const p of JSON.parse(json) as { name: string; latest_version: string }[]) {
    const name = byKey.get(pipKey(p.name))
    if (name !== undefined) found[name] = p.latest_version
  }

  return found
}

export const filterBy = <T extends { name: string }>(items: T[], query: string) =>
  items.filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase()))

const BIO = ['-c', 'conda-forge', '-c', 'bioconda']
// base keeps its own channels; other envs use the bio channels they were installed from.
// The update check must use the same channels as the update, or it reports versions the update won't pick.
const channelsFor = (env: VemsEnv) => (env.isBase ? [] : BIO)

export const channelKey = (env: VemsEnv) => channelsFor(env).join(' ')

export const argv = {
  envs: () => ['env', 'list', '--json'],
  packages: (env: VemsEnv) => ['list', '-p', env.path, '--json'],
  install: (env: VemsEnv, spec: string) => ['install', '-p', env.path, '-y', ...BIO, spec],
  create: (name: string, specs: string[]) => ['create', '-n', name, '-y', ...BIO, ...specs],
  // --use-index-cache reuses the downloaded channel index: ~1.5 s per env instead of ~5.5 s.
  updates: (env: VemsEnv, useIndexCache = false) =>
    ['update', '--all', '-p', env.path, ...channelsFor(env), ...(useIndexCache ? ['--use-index-cache'] : []), '--dry-run', '--json'],
  // `conda update <pkg>` keeps every other package where it is, so it stops short when a dependency
  // has to move too (conda went 26.5.3 → 26.7.3, then "already installed" with 26.9.3 out). Asking
  // for the version the update check found lets the solver move just the dependencies it needs.
  updatePkg: (env: VemsEnv, pkg: string, version?: string) =>
    version === undefined
      ? ['update', '-p', env.path, '-y', ...channelsFor(env), pkg]
      : ['install', '-p', env.path, '-y', ...channelsFor(env), `${pkg}=${version}`],
  updateAll: (env: VemsEnv) => ['update', '--all', '-p', env.path, '-y', ...channelsFor(env)],
  version: () => ['--version'],
  importYml: (file: string) => ['env', 'create', '-f', file, '-y'],
  clone: (source: VemsEnv, name: string) => ['create', '-n', name, '--clone', source.path, '-y'],
  clean: () => ['clean', '--all', '-y'],
  cleanable: () => ['clean', '--all', '--dry-run', '--json'],
  // one level deep, so base can leave out envs/ (the other envs) and pkgs/ (the download cache)
  du: (env: VemsEnv) => ['du', '-k', '-d', '1', env.path],
  // pip runs as the env's own Python, so it touches only that env.
  pipOutdated: (env: VemsEnv) => [`${env.path}/bin/python`, '-m', 'pip', 'list', '--outdated', '--format=json'],
  pipUpgrade: (env: VemsEnv, names: string[]) => [`${env.path}/bin/python`, '-m', 'pip', 'install', '-U', ...names],
  pipRemove: (env: VemsEnv, name: string) => [`${env.path}/bin/python`, '-m', 'pip', 'uninstall', '-y', name],
  remove: (env: VemsEnv, pkg: string) => ['remove', '-p', env.path, '-y', pkg],
  removeEnv: (env: VemsEnv) => ['env', 'remove', '-p', env.path, '-y'],
  exportYml: (env: VemsEnv, file: string) =>
    ['env', 'export', '-p', env.path, '--no-builds', '-f', file],
}
