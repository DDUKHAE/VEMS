import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { VemsBox, VemsEnv, VemsForm, VemsHit, VemsPackage, VemsPending, VemsTab, VemsUpdate } from '../types'
import { activatePrefix, argv, filterBy, isValidSpec, parseCreate, parseEnvs, REPO_MANIFEST, UPDATE_COMMAND, channelKey, formatSize, isEnvName, isNewer, parseCleanable, parseDu, parsePackages, parsePins, parsePipOutdated, parseSearch, parseUpdates, pinFile, searchUrl, togglePin } from './conda'

const PANE = 'vems'
// A colored glyph leaves a gap around it, so squares in stacked rows stay apart.
const SQUARE = '■'
const hitKey = (hit: VemsHit) => `${hit.channel}:${hit.name}`

// The Envs table's UPDATE cell: text and color.
function updateLabel(state: VemsUpdate | undefined): [string, string] {
  if (typeof state === 'object') {
    const n = Object.keys(state).length

    return n === 0 ? ['0 updates', 'green'] : [`${n} update${n > 1 ? 's' : ''}`, 'yellow']
  }

  return state === 'error' ? ['unknown', 'red'] : ['checking', 'gray']
}
const tab = atom({ plugin: 'vems', key: 'tab' } as const, 'envs' as VemsTab)
const query = atom({ plugin: 'vems', key: 'query' } as const, '')
const selected = atom({ plugin: 'vems', key: 'selected' } as const, null as VemsEnv | null)
const envs = atom({ plugin: 'vems', key: 'envs' } as const, [] as VemsEnv[])
const packages = atom({ plugin: 'vems', key: 'packages' } as const, [] as VemsPackage[])
const busy = atom({ plugin: 'vems', key: 'busy' } as const, null as string | null)
const box = atom({ plugin: 'vems', key: 'box' } as const, null as VemsBox | null)
const updates = atom({ plugin: 'vems', key: 'updates' } as const, {} as Record<string, VemsUpdate>)
const updatesOnly = atom({ plugin: 'vems', key: 'updatesOnly' } as const, false)
const pins = atom({ plugin: 'vems', key: 'pins' } as const, [] as string[])
const hits = atom({ plugin: 'vems', key: 'hits' } as const, null as VemsHit[] | null)
const hitFocus = atom({ plugin: 'vems', key: 'hitFocus' } as const, null as string | null)
// Install tab works on the active env (base when none), not the one picked in Envs.
const targetPackages = atom({ plugin: 'vems', key: 'targetPackages' } as const, [] as VemsPackage[])
const dots = atom({ plugin: 'vems', key: 'dots' } as const, 1)
const sizes = atom({ plugin: 'vems', key: 'sizes' } as const, {} as Record<string, number>)
const cacheSize = atom({ plugin: 'vems', key: 'cacheSize' } as const, null as number | null)
const modUpdate = atom({ plugin: 'vems', key: 'modUpdate' } as const, null as { current: string; latest: string } | null)
const draft = atom({ plugin: 'vems', key: 'draft' } as const, '')
const condaVersion = atom({ plugin: 'vems', key: 'condaVersion' } as const, null as string | null)
const active = atom({ plugin: 'vems', key: 'active' } as const, null as VemsEnv | null)

const condaExe = async ($: EngineInterface) => (await $.env.get('CONDA_EXE')) ?? 'conda'

// The status line shows the activated env whenever no job is running.
async function showActive($: EngineInterface) {
  const env = await read($, active)
  $.ui.status(env ? `env: ${env.name}` : undefined)
}

const installTarget = async ($: EngineInterface) =>
  (await read($, active)) ?? (await read($, envs)).find(x => x.isBase) ?? null

// Runs outside job() (tab switches, activation), so a conda failure only leaves the list as it was.
async function loadTarget($: EngineInterface) {
  try {
    const target = await installTarget($)
    const list = target ? parsePackages(await conda($, argv.packages(target))) : []
    await update($, targetPackages, () => list)
  } catch {}
}

const setActive = async ($: EngineInterface, env: VemsEnv | null) => {
  await update($, active, () => env)
  await showActive($)
  void loadTarget($)
}

// $.store records keyed by env path (or one value), each with the time it was taken.
const readStore = async <T,>($: EngineInterface, key: string) => ((await $.store.get(key)) ?? {}) as T
const TTL_MS = 6 * 60 * 60 * 1000
const isStale = (record: { at?: number } | undefined, now: number) => !record?.at || now - record.at > TTL_MS

async function run($: EngineInterface, cmd: string[], timeoutMs = 60_000) {
  const ran = await $.process.run(cmd, { timeoutMs })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n').pop() || `${cmd[0]} exited ${ran.exitCode}`)

  return ran.stdout
}

const conda = async ($: EngineInterface, args: string[], timeoutMs = 60_000) =>
  run($, [await condaExe($), ...args], timeoutMs)

// Long installs run through process.spawn, which has no time limit (process.run stops at ten
// minutes); only the tail of stderr is kept, for the failure toast.
async function stream($: EngineInterface, cmd: string[]) {
  const child = $.process.spawn({ argv: cmd })
  let errors = ''
  for await (const { stream: pipe, text } of child) if (pipe === 'stderr') errors = (errors + text).slice(-4000)
  const { code } = await child.result
  if (code !== 0) throw new Error(errors.trim().split('\n').pop() || `${cmd[0]} exited ${code}`)
}

const condaStream = async ($: EngineInterface, args: string[]) => stream($, [await condaExe($), ...args])

// Sizes come from du, which takes a second or two per big env, so they fill in after the list.
const SIZES_KEY = 'sizes'

// Once per six hours at most: GitHub's copy of plugin.json against the one this mod loaded from.
// Offline, or a repo with no release yet, just shows nothing.
const MOD_UPDATE_KEY = 'modUpdate'

async function checkModUpdate($: EngineInterface) {
  try {
    const manifest = JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))) as { version: string }
    const now = await $.clock.now()
    const stored = await readStore<{ at?: number; latest?: string }>($, MOD_UPDATE_KEY)
    let latest = isStale(stored, now) ? undefined : stored.latest
    if (latest === undefined) {
      const res = await $.http.fetch(REPO_MANIFEST)
      if (!res.ok) return
      latest = (JSON.parse(res.text) as { version: string }).version
      await $.store.set(MOD_UPDATE_KEY, { at: now, latest })
    }
    const isBehind = isNewer(latest, manifest.version)
    await update($, modUpdate, () => (isBehind ? { current: manifest.version, latest: latest! } : null))
    if (isBehind) $.ui.toast(`vems ${latest} is out: ${UPDATE_COMMAND}`)
  } catch {}
}

// About 3 s, so it fills in after the list; refreshed after every job that downloads or removes.
async function measureCleanable($: EngineInterface) {
  try {
    const kb = parseCleanable(await conda($, argv.cleanable(), 120_000))
    await update($, cacheSize, () => kb)
  } catch {}
}

async function measureSizes($: EngineInterface, list: VemsEnv[]) {
  for (const env of list) {
    try {
      const size = parseDu(await run($, argv.du(env), 120_000), env)
      await update($, sizes, all => ({ ...all, [env.path]: size }))
      const stored = await readStore<Record<string, { at: number; kb: number }>>($, SIZES_KEY)
      await $.store.set(SIZES_KEY, { ...stored, [env.path]: { at: await $.clock.now(), kb: size } })
    } catch {}
  }
}

// pip updates for the env's pip-installed packages; none, or no pip in the env, is no update.
async function pipUpdates($: EngineInterface, env: VemsEnv): Promise<Record<string, string>> {
  try {
    const pipPackages = parsePackages(await conda($, argv.packages(env))).filter(p => p.source === 'pip')
    if (pipPackages.length === 0) return {}

    return parsePipOutdated(await run($, argv.pipOutdated(env), 120_000), pipPackages)
  } catch {
    return {}
  }
}

// Runs one conda job with the pane locked; failures become a toast.
async function job($: EngineInterface, label: string, work: () => Promise<unknown>) {
  if ((await read($, busy)) !== null) return
  await update($, busy, () => label)
  $.ui.status(`vems: ${label}`)
  // "installing." → ".." → "..." → "." beside the conda version while the job runs.
  const ticker = $.clock.every(500, () => void update($, dots, n => (n % 3) + 1))
  try {
    await work()
  } catch (error) {
    $.ui.toast(`vems: ${label} failed: ${(error as Error).message}`)
  } finally {
    ticker.cancel()
    await update($, busy, () => null)
    await update($, dots, () => 1)
    await showActive($)
  }
}

// Dry-run update checks take seconds each, so they run one at a time outside job().
// Results outlive the session in $.store, so reopening the pane shows them at once.
const UPDATES_KEY = 'updates'
type Stored = Record<string, { at: number; found: Record<string, string> }>

// One at a time on purpose: parallel solves fight for CPU and measured slower (78 s vs 34 s for 14 envs).
// With refreshIndex, the first env of each channel set downloads a fresh index and the rest reuse it;
// after an install or update conda has just refreshed it, so every check reuses it.
async function checkUpdates($: EngineInterface, list: VemsEnv[], refreshIndex = false) {
  const mark = (path: string, value: VemsUpdate) => update($, updates, all => ({ ...all, [path]: value }))
  const shown = await read($, updates)
  for (const env of list) if (typeof shown[env.path] !== 'object') await mark(env.path, 'checking')
  const refreshed = new Set<string>()
  for (const env of list) {
    const useCache = !refreshIndex || refreshed.has(channelKey(env))
    refreshed.add(channelKey(env))
    try {
      // pip waits on the network and conda's solve on the CPU, so they run side by side.
      const [condaFound, pipFound] = await Promise.all([
        conda($, argv.updates(env, useCache), 120_000).then(parseUpdates),
        pipUpdates($, env),
      ])
      const found = { ...condaFound, ...pipFound }
      await mark(env.path, found)
      const stored = await readStore<Stored>($, UPDATES_KEY)
      await $.store.set(UPDATES_KEY, { ...stored, [env.path]: { at: await $.clock.now(), found } })
    } catch {
      await mark(env.path, 'error')
    }
  }
}

// Shows stored results right away; checks only envs never checked or older than the TTL,
// or every env when the person asked for a refresh.
const loadEnvs = ($: EngineInterface, force = false) =>
  job($, 'loading environments', async () => {
    const list = parseEnvs(await conda($, argv.envs()))
    await update($, envs, () => list)
    await loadVersion($)
    const now = await $.clock.now()
    const stored = await readStore<Stored>($, UPDATES_KEY)
    const storedSizes = await readStore<Record<string, { at: number; kb: number }>>($, SIZES_KEY)
    const known = list.filter(env => stored[env.path])
    await update($, updates, all => ({ ...all, ...Object.fromEntries(known.map(env => [env.path, stored[env.path]!.found])) }))
    const sized = list.filter(env => storedSizes[env.path])
    await update($, sizes, all => ({ ...all, ...Object.fromEntries(sized.map(env => [env.path, storedSizes[env.path]!.kb])) }))
    void checkUpdates($, list.filter(env => force || isStale(stored[env.path], now)), true)
    void measureSizes($, list.filter(env => force || isStale(storedSizes[env.path], now)))
    void measureCleanable($)
    void checkModUpdate($)
  })

const loadVersion = async ($: EngineInterface) => {
  const version = (await conda($, argv.version())).trim().replace(/^conda\s+/, '')
  await update($, condaVersion, () => version)
}

// The version the last update check found for pkg in env, if it found one.
async function foundVersion($: EngineInterface, env: VemsEnv, pkg: string) {
  const found = (await read($, updates))[env.path]

  return typeof found === 'object' ? found[pkg] : undefined
}

const updateConda = ($: EngineInterface, base: VemsEnv) =>
  job($, 'updating conda', async () => {
    await update($, box, () => null)
    // base's own channels, as for any base package
    await condaStream($, argv.updatePkg(base, 'conda', await foundVersion($, base, 'conda')))
    await loadVersion($)
    void checkUpdates($, [base])
    $.ui.toast(`vems: conda updated to ${await read($, condaVersion)}`)
  })

const openEnv = ($: EngineInterface, env: VemsEnv) =>
  job($, `reading ${env.name}`, async () => {
    const list = parsePackages(await conda($, argv.packages(env)))
    await update($, selected, () => env)
    await update($, packages, () => list)
    await loadPins($, env)
    await update($, query, () => '')
    await update($, tab, () => 'packages' as VemsTab)
  })

// The pin file sits inside the env, outside the session's folder, so it goes through the
// same host process path as conda itself rather than $.fs.
const readPinFile = async ($: EngineInterface, env: VemsEnv) => {
  const ran = await $.process.run(['cat', pinFile(env)])

  return ran.exitCode === 0 ? ran.stdout : ''
}

const writePinFile = async ($: EngineInterface, env: VemsEnv, text: string) => {
  const ran = await $.process.run(['tee', pinFile(env)], { stdin: text })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `tee exited ${ran.exitCode}`)
}

// pip has no pin file of its own, and conda-meta/pinned is for conda's solver, so pip pins
// live in vems's store and only keep vems from updating them.
const PIP_PINS_KEY = 'pipPins'
const readPipPins = ($: EngineInterface) => readStore<Record<string, string[]>>($, PIP_PINS_KEY)

const loadPins = async ($: EngineInterface, env: VemsEnv) => {
  const names = [...parsePins(await readPinFile($, env)), ...((await readPipPins($))[env.path] ?? [])]
  await update($, pins, () => names)
}

// Pinning a conda package rewrites conda-meta/pinned, then re-checks updates, which now honour the pin.
const flipPin = ($: EngineInterface, env: VemsEnv, pkg: VemsPackage) =>
  job($, `pinning ${pkg.name}`, async () => {
    if (pkg.source === 'pip') {
      const all = await readPipPins($)
      const mine = all[env.path] ?? []
      const next = mine.includes(pkg.name) ? mine.filter(n => n !== pkg.name) : [...mine, pkg.name]
      await $.store.set(PIP_PINS_KEY, { ...all, [env.path]: next })
    } else {
      await writePinFile($, env, togglePin(await readPinFile($, env), pkg.name, pkg.version))
    }
    await loadPins($, env)
    const isPinned = (await read($, pins)).includes(pkg.name)
    $.ui.toast(`vems: ${isPinned ? `pinned ${pkg.name} ==${pkg.version}` : `unpinned ${pkg.name}`}`)
    void checkUpdates($, [env])
  })

const searchPackages = ($: EngineInterface, query: string) =>
  job($, `searching ${query}`, async () => {
    const res = await $.http.fetch(searchUrl(query))
    if (!res.ok) throw new Error(`anaconda.org answered ${res.status}`)
    const found = parseSearch(res.text, query)
    await loadTarget($)
    await update($, hits, () => found)
    await update($, hitFocus, () => null)
  })

const removeEnv = ($: EngineInterface, target: VemsEnv) =>
  job($, `removing env ${target.name}`, async () => {
    await update($, box, () => null)
    await condaStream($, argv.removeEnv(target))
    if ((await read($, active))?.path === target.path) await setActive($, null)
    if ((await read($, selected))?.path === target.path) await update($, selected, () => null)
    await update($, envs, list => list.filter(x => x.path !== target.path))
    $.ui.toast(`vems: removed env ${target.name}`)
  })

// What each confirmable action says in the confirm box and while it runs.
const ACTIONS = {
  install: { verb: 'Install', doing: 'installing', done: 'installed', color: 'yellow' },
  update: { verb: 'Update', doing: 'updating', done: 'updated', color: 'yellow' },
  'update-all': { verb: 'Update all', doing: 'updating', done: 'updated', color: 'yellow' },
  'update-conda': { verb: 'Update', doing: 'updating', done: 'updated', color: 'blue' },
  clean: { verb: 'Clean', doing: 'cleaning', done: 'cleaned', color: 'yellow' },
  remove: { verb: 'Remove', doing: 'removing', done: 'removed', color: 'red' },
  'remove-env': { verb: 'Remove', doing: 'removing', done: 'removed', color: 'red' },
} as const

const confirm = ($: EngineInterface, p: VemsPending) =>
  p.action === 'remove-env' ? removeEnv($, p.env)
    : p.action === 'update-conda' ? updateConda($, p.env)
    : p.action === 'clean' ? cleanCache($, p.env) : job($, `${ACTIONS[p.action].doing} ${p.pkg}`, async () => {
    await update($, box, () => null)
    const current = await read($, packages)
    const isPip = current.find(x => x.name === p.pkg)?.source === 'pip'
    if (p.action === 'update-all') {
      // conda first, then pip for its own outdated, unpinned packages (pip would undo a conda solve otherwise).
      await condaStream($, argv.updateAll(p.env))
      const found = (await read($, updates))[p.env.path]
      const pinned = await read($, pins)
      const pipTargets = current
        .filter(x => x.source === 'pip' && typeof found === 'object' && found[x.name] && !pinned.includes(x.name))
        .map(x => x.name)
      if (pipTargets.length) await stream($, argv.pipUpgrade(p.env, pipTargets))
    } else if (p.action === 'install') await condaStream($, argv.install(p.env, p.pkg))
    else if (p.action === 'update') {
      await (isPip ? stream($, argv.pipUpgrade(p.env, [p.pkg])) : condaStream($, argv.updatePkg(p.env, p.pkg, await foundVersion($, p.env, p.pkg))))
    } else await (isPip ? stream($, argv.pipRemove(p.env, p.pkg)) : condaStream($, argv.remove(p.env, p.pkg)))
    // Refresh whichever lists show this env: the Packages tab's and the Install tab's.
    const list = parsePackages(await conda($, argv.packages(p.env)))
    if ((await read($, selected))?.path === p.env.path) await update($, packages, () => list)
    if ((await installTarget($))?.path === p.env.path) await update($, targetPackages, () => list)
    void checkUpdates($, [p.env])
    void measureSizes($, [p.env])
    void measureCleanable($)
    $.ui.toast(`vems: ${ACTIONS[p.action].done} ${p.pkg} in ${p.env.name}`)
  })

// Reads the create box's text; a malformed line keeps the box open with a toast.
function submitCreate($: EngineInterface, line: string) {
  const parsed = parseCreate(line)
  if (parsed === null) return $.ui.toast(`vems: "${line}" is not "name [packages...]"`)
  void createEnv($, parsed.name, parsed.specs)
}

// One box at a time under the Envs buttons: a form or a confirm, swapped in a single write.
async function openBox($: EngineInterface, next: VemsForm | null) {
  await update($, draft, () => '')
  await update($, box, () => (next ? { form: next } : null))
}

const askFor = ($: EngineInterface, ask: VemsPending) => update($, box, () => ({ ask }))

// Re-reads the env list after an env was added, then checks and sizes the new ones.
async function addNewEnvs($: EngineInterface) {
  const before = new Set((await read($, envs)).map(x => x.path))
  const list = parseEnvs(await conda($, argv.envs()))
  await update($, envs, () => list)
  const added = list.filter(x => !before.has(x.path))
  void checkUpdates($, added)
  void measureSizes($, added)
}

async function submitImport($: EngineInterface, line: string) {
  const home = (await $.env.get('HOME')) ?? ''
  const file = line.trim().replace(/^~(?=\/)/, home)
  if (!/\.ya?ml$/.test(file)) return $.ui.toast(`vems: "${line}" is not a .yml file`)
  void job($, `importing ${file.split('/').pop()}`, async () => {
    await openBox($, null)
    await condaStream($, argv.importYml(file))
    await addNewEnvs($)
    $.ui.toast(`vems: created env from ${file.split('/').pop()}`)
  })
}

async function submitClone($: EngineInterface, source: VemsEnv, line: string) {
  const name = line.trim()
  if (!isEnvName(name)) return $.ui.toast(`vems: "${line}" is not an env name`)
  if ((await read($, envs)).some(x => x.name === name)) return $.ui.toast(`vems: ${name} already exists`)
  void job($, `cloning ${source.name}`, async () => {
    await openBox($, null)
    await condaStream($, argv.clone(source, name))
    await addNewEnvs($)
    $.ui.toast(`vems: cloned ${source.name} as ${name}`)
  })
}

const cleanCache = ($: EngineInterface, base: VemsEnv) =>
  job($, 'cleaning the package cache', async () => {
    await update($, box, () => null)
    const before = (await read($, cacheSize)) ?? 0
    await condaStream($, argv.clean())
    await measureCleanable($)
    void measureSizes($, [base])
    $.ui.toast(`vems: package cache cleaned, about ${formatSize(before)} freed`)
  })

const createEnv = ($: EngineInterface, name: string, specs: string[]) =>
  job($, `creating ${name}`, async () => {
    await openBox($, null)
    await condaStream($, argv.create(name, specs))
    await addNewEnvs($)
    $.ui.toast(`vems: created ${name}`)
  })

const exportEnv = ($: EngineInterface, env: VemsEnv) =>
  job($, `exporting ${env.name}`, async () => {
    const file = `${env.name}.environment.yml`
    await conda($, argv.exportYml(env, file))
    $.ui.toast(`vems: wrote ${file}`)
  })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'envs', description: 'Browse and manage conda environments' })
    await showActive($)

    return next(e)
  })

  on('command.run', { command: 'envs' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Environments', focus: true })
    void loadEnvs($)

    return { text: 'Environments pane opened.' }
  })

  // Every Bash command Claude runs gets the activated env's PATH and variables.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const env = await read($, active)
    if (env === null) return next(e)

    return next({ ...e, command: `${activatePrefix(await condaExe($), env)}\n${e.command}` })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)

      return <Text dimColor>vems needs a terminal or desktop session.</Text>
    }
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const [current, q, env, envList, pkgList, working, shownBox, inUse, updateMap, text, version, onlyUpdates, pinList, hitList, focusKey, targetList, dotCount, sizeMap, cache, modNext] = await Promise.all([
      read($, tab), read($, query), read($, selected), read($, envs),
      read($, packages), read($, busy), read($, box), read($, active), read($, updates),
      read($, draft), read($, condaVersion), read($, updatesOnly), read($, pins), read($, hits), read($, hitFocus), read($, targetPackages),
      read($, dots), read($, sizes), read($, cacheSize), read($, modUpdate),
    ])
    const goTo = (t: VemsTab) => () => {
      void update($, tab, () => t)
      if (t === 'install') void loadTarget($)
    }
    const canChange = env !== null && !env.isBase
    const shown = current === 'envs' ? filterBy(envList, q) : filterBy(pkgList, q)
    // A column is as wide as its longest value, so no row pushes the next cells right.
    const widest = (texts: string[], min: number) => Math.max(min, ...texts.map(t => t.length))
    const nameWidth = widest(envList.map(x => x.name), 4)
    const updateWidth = widest(envList.map(x => updateLabel(updateMap[x.path])[0]), 10)
    const hitWidth = { name: widest((hitList ?? []).map(h => h.name), 4), version: widest((hitList ?? []).map(h => h.version), 7) }
    const focused = (hitList ?? []).find(h => hitKey(h) === focusKey)
    const ask = shownBox && 'ask' in shownBox ? shownBox.ask : null
    const openForm = shownBox && 'form' in shownBox ? shownBox.form : null
    // The create, import and clone boxes differ only in these.
    const formSpec = openForm === null ? null
      : openForm.kind === 'create' ? {
        key: 'create', title: 'Create a new environment', label: 'Name and packages', placeholder: 'myenv python=3.11 samtools',
        hint: 'Channels: conda-forge, bioconda', verb: 'Create', color: 'green', submit: (v: string) => void submitCreate($, v),
      }
      : openForm.kind === 'import' ? {
        key: 'import-path', title: 'Create an environment from a .yml file', label: 'File', placeholder: '~/project/environment.yml',
        hint: "The env's name and channels come from the file.", verb: 'Import', color: 'green', submit: (v: string) => void submitImport($, v),
      }
      : {
        key: 'clone-name', title: `Clone ${openForm.from.name}`, label: 'New name', placeholder: `${openForm.from.name}_backup`,
        hint: 'Same packages and versions, as a separate env.', verb: 'Clone', color: 'blue', submit: (v: string) => void submitClone($, openForm.from, v),
      }
    const target = inUse ?? envList.find(x => x.isBase)
    // + 4: the name cell also holds a dim ' pip' tag
    const pkgWidth = { name: widest(pkgList.map(p => p.name), 4) + 4, version: widest(pkgList.map(p => p.version), 7) }
    const newVersion = (of: VemsEnv, name: string) => {
      const found = updateMap[of.path]
      if (of.path === env?.path && pinList.includes(name)) return undefined

      return typeof found === 'object' ? found[name] : undefined
    }
    // ponytail: read from base's `update --all` dry run; a conda held back by base's other pins shows no update.
    // Packages tab lists every match (the pane scrolls), optionally only those with an update.
    const updatable = env ? pkgList.filter(p => newVersion(env, p.name)).length : 0
    const rows = env && current === 'packages'
      ? (shown as VemsPackage[]).filter(p => !onlyUpdates || newVersion(env, p.name))
      : []
    const base = envList.find(x => x.isBase)
    const condaNext = base && newVersion(base, 'conda')
    // Confirm box: in each tab, right under its buttons, never below a long table.
    const confirmBox = ask !== null && (
      <Box flexDirection="column" borderStyle="round" borderColor={ACTIONS[ask.action].color} paddingX={1}>
        <Text bold>{{
          'remove-env': `Remove environment ${ask.env.name}?`,
          remove: `Remove ${ask.pkg} from ${ask.env.name}?`,
          update: `Update ${ask.pkg} in ${ask.env.name}?`,
          'update-conda': 'Update conda?',
          clean: "Clean conda's package cache?",
          'update-all': `Update all ${ask.pkg} in ${ask.env.name}?`,
          install: `Install ${ask.pkg} into ${ask.env.name}?`,
        }[ask.action]}</Text>
        <Text dimColor>{{
          'remove-env': `${ask.env.path} will be deleted.`,
          remove: 'Packages that depend on it may be removed too.',
          update: `${pkgList.find(p => p.name === ask.pkg)?.version ?? '?'} → ${newVersion(ask.env, ask.pkg) ?? 'latest'}`,
          'update-conda': `${version ?? '?'} → ${condaNext ?? 'latest'}, in ${ask.env.path}`,
          clean: `Frees about ${formatSize(cache ?? 0)}: downloaded tarballs and packages no env uses. Envs are not touched.`,
          'update-all': pinList.length ? `Pinned, kept as is: ${pinList.join(', ')}` : 'No pinned packages.',
          install: 'Channels: conda-forge, bioconda',
        }[ask.action]}</Text>
        <Box>
          <Button key="confirm" variant="primary" onPress={() => void confirm($, ask)}>
            <Text color={ACTIONS[ask.action].color} bold>{ACTIONS[ask.action].verb}</Text>
          </Button>
          <Text> </Text>
          <Button key="cancel" onPress={() => void update($, box, () => null)}>Cancel</Button>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box>
          <Text>
            <Text bold>conda </Text>
            <Text color="cyan">{version ?? '…'}</Text>
            {condaNext && <Text color="yellow"> → {condaNext} available </Text>}
          </Text>
          {condaNext && base && (
            <Button key="update-conda" label="update conda" plain
              onPress={() => void askFor($, ({ action: 'update-conda' as const, pkg: 'conda', env: base }))}>
              <Text backgroundColor="blue" color="white" bold> UPDATE </Text>
            </Button>
          )}
          {working !== null && <Text color="yellow">  {working}{'.'.repeat(dotCount)}</Text>}
        </Box>
        {modNext && (
          <Text color="magenta">vems {modNext.current} → {modNext.latest} available. Run in a terminal: <Text bold>{UPDATE_COMMAND}</Text>, then /reload-plugins</Text>
        )}
        <Box>
          <Button key="tab-envs" hotkey="1" variant={current === 'envs' ? 'primary' : undefined} onPress={goTo('envs')}>Envs</Button>
          <Button key="tab-packages" hotkey="2" variant={current === 'packages' ? 'primary' : undefined} onPress={goTo('packages')}>Packages</Button>
          <Button key="tab-install" hotkey="3" variant={current === 'install' ? 'primary' : undefined} onPress={goTo('install')}>Install</Button>
          <Button key="refresh" hotkey="r" onPress={() => void loadEnvs($, true)}>refresh</Button>
        </Box>
        <Text color="green" bold>● active: {inUse?.name ?? 'base'}</Text>

        {current !== 'install' && (
          <Box borderStyle="round" borderColor="cyan" paddingX={1}>
            <Input key="search" label="Search" placeholder="type to filter by name" value={q}
              onInput={value => void update($, query, () => value)}
              onSubmit={value => void update($, query, () => value)} />
          </Box>
        )}

        {current === 'envs' && (
          <Box>
            <Box borderStyle="round" borderColor="green" paddingX={1}>
              <Button key="new-env" plain onPress={() => void openBox($, { kind: 'create' })}><Text color="green" bold>New env</Text></Button>
            </Box>
            <Box borderStyle="round" borderColor="green" paddingX={1}>
              <Button key="import" plain onPress={() => void openBox($, { kind: 'import' })}><Text color="green" bold>Import</Text></Button>
            </Box>
            {base && (
              <Box borderStyle="round" borderColor="yellow" paddingX={1}>
                <Button key="clean" plain onPress={() => void askFor($, ({ action: 'clean' as const, pkg: 'cache', env: base }))}>
                  <Text color="yellow" bold>Clean cache{cache != null ? ` (${formatSize(cache)})` : ''}</Text>
                </Button>
              </Box>
            )}
          </Box>
        )}

        {current === 'envs' && formSpec && (
          <Box flexDirection="column" borderStyle="round" borderColor={formSpec.color} paddingX={1}>
            <Text bold>{formSpec.title}</Text>
            <Input key={formSpec.key} label={formSpec.label} placeholder={formSpec.placeholder} value={text} submitLabel={formSpec.verb.toLowerCase()} autoFocus
              onInput={value => void update($, draft, () => value)}
              onSubmit={formSpec.submit} />
            <Text dimColor>{formSpec.hint}</Text>
            <Box>
              <Button key="form-ok" variant="primary" onPress={() => formSpec.submit(text)}><Text color={formSpec.color} bold>{formSpec.verb}</Text></Button>
              <Text> </Text>
              <Button key="form-cancel" onPress={() => void openBox($, null)}>Cancel</Button>
            </Box>
          </Box>
        )}

        {current === 'envs' && confirmBox}

        {current === 'envs' && (envList.length === 0
          ? <Text dimColor>No environments loaded. Press r to refresh.</Text>
          : (
            <Box flexDirection="column">
              {/* Fixed cells that never shrink, as in the Install table, so rows line up at any pane width. */}
              <Box>
                <Box width={nameWidth + 4} flexShrink={0}><Text bold>{'  '}NAME</Text></Box>
                <Box width={updateWidth + 2} flexShrink={0}><Text bold>UPDATE</Text></Box>
                <Box width={10} flexShrink={0}><Text bold>ACTIVATE</Text></Box>
                <Box width={8} flexShrink={0}><Text bold>EXPORT</Text></Box>
                <Box width={7} flexShrink={0}><Text bold>CLONE</Text></Box>
                <Box width={8} flexShrink={0}><Text bold>SIZE</Text></Box>
                <Box width={8} flexShrink={0}><Text bold>REMOVE</Text></Box>
              </Box>
              {(shown as VemsEnv[]).map(item => {
                const mark = item.path === env?.path ? '▸ ' : '  '
                const state = updateMap[item.path]
                const [label, color] = updateLabel(state)

                return (
                  <Box key={`row:${item.path}`}>
                    <Box width={nameWidth + 4} flexShrink={0}>
                      <Button key={`env:${item.path}`} plain onPress={() => void openEnv($, item)}>{mark}{item.name}</Button>
                    </Box>
                    <Box width={updateWidth + 2} flexShrink={0}><Text color={color}>{label}</Text></Box>
                    <Box width={10} flexShrink={0} paddingLeft={3}>
                      {inUse?.path === item.path
                        ? <Button key={`act:${item.path}`} label="deactivate" plain onPress={() => void setActive($, null)}><Text color="green">{SQUARE}</Text></Button>
                        : <Button key={`act:${item.path}`} label="activate" plain onPress={() => void setActive($, item)}><Text color="gray">{SQUARE}</Text></Button>}
                    </Box>
                    <Box width={8} flexShrink={0} paddingLeft={2}>
                      <Button key={`exp:${item.path}`} label="export yml" plain onPress={() => void exportEnv($, item)}><Text color="cyan">{SQUARE}</Text></Button>
                    </Box>
                    <Box width={7} flexShrink={0} paddingLeft={2}>
                      <Button key={`clone:${item.path}`} label="clone" plain onPress={() => void openBox($, { kind: 'clone', from: item })}><Text color="blue">{SQUARE}</Text></Button>
                    </Box>
                    <Box width={8} flexShrink={0}>
                      <Text dimColor>{sizeMap[item.path] !== undefined ? formatSize(sizeMap[item.path]!) : '…'}</Text>
                    </Box>
                    <Box width={8} flexShrink={0} paddingLeft={2}>
                      {item.isBase
                        ? <Text dimColor>-</Text>
                        : <Button key={`rmenv:${item.path}`} label="remove env" plain onPress={() => void askFor($, ({ action: 'remove-env' as const, pkg: item.name, env: item }))}><Text color="red">{SQUARE}</Text></Button>}
                    </Box>
                  </Box>
                )
              })}
            </Box>
          ))}

        {current === 'packages' && (env === null
          ? <Text dimColor>Pick an environment in Envs first.</Text>
          : (
            <Box flexDirection="column">
              <Box>
                <Text dimColor>{env.name}: {rows.length} of {pkgList.length} packages, {updatable} updatable  </Text>
                <Button key="updates-only" label="updates only" plain onPress={() => void update($, updatesOnly, isOn => !isOn)}>
                  <Text color={onlyUpdates ? 'yellow' : 'gray'}>{SQUARE} updates only</Text>
                </Button>
                {updatable > 0 && <Text>  </Text>}
                {updatable > 0 && (
                  <Button key="update-all" label="update all" plain
                    onPress={() => void askFor($, ({ action: 'update-all' as const, pkg: `${updatable} packages`, env }))}>
                    <Text color="yellow" bold>{SQUARE} update all</Text>
                  </Button>
                )}
              </Box>
              {confirmBox}
              <Box>
                <Box width={pkgWidth.name + 2} flexShrink={0}><Text bold>NAME</Text></Box>
                <Box width={pkgWidth.version + 4} flexShrink={0}><Text bold>VERSION</Text></Box>
                <Box width={8} flexShrink={0}><Text bold>UPDATE</Text></Box>
                <Box width={8} flexShrink={0}><Text bold>REMOVE</Text></Box>
                <Box width={6} flexShrink={0}><Text bold>PIN</Text></Box>
              </Box>
              {rows.map(pkg => {
                const next = newVersion(env, pkg.name)

                return (
                  <Box key={`pkg:${pkg.name}`}>
                    <Box width={pkgWidth.name + 2} flexShrink={0}>
                      <Text>{pkg.name}<Text dimColor>{pkg.source === 'pip' ? ' pip' : ''}</Text></Text>
                    </Box>
                    <Box width={pkgWidth.version + 4} flexShrink={0}>
                      <Text><Text color="cyan">{pkg.version}</Text><Text color="yellow" bold>{next ? ' !' : ''}</Text></Text>
                    </Box>
                    <Box width={8} flexShrink={0} paddingLeft={2}>
                      {next
                        ? <Button key={`up:${pkg.name}`} label={`update to ${next}`} plain onPress={() => void askFor($, ({ action: 'update' as const, pkg: pkg.name, env }))}><Text color="yellow">{SQUARE}</Text></Button>
                        : <Text dimColor>-</Text>}
                    </Box>
                    <Box width={8} flexShrink={0} paddingLeft={2}>
                      {canChange
                        ? <Button key={`rm:${pkg.name}`} label="remove" plain onPress={() => void askFor($, ({ action: 'remove' as const, pkg: pkg.name, env }))}><Text color="red">{SQUARE}</Text></Button>
                        : <Text dimColor>-</Text>}
                    </Box>
                    <Box width={6} flexShrink={0} paddingLeft={1}>
                      <Button key={`pin:${pkg.name}`} label={pinList.includes(pkg.name) ? 'unpin' : 'pin'} plain onPress={() => void flipPin($, env, pkg)}>
                        <Text color={pinList.includes(pkg.name) ? 'magenta' : 'gray'}>{SQUARE}</Text>
                      </Button>
                    </Box>
                  </Box>
                )
              })}
            </Box>
          ))}

        {current === 'install' && (target === undefined
          ? <Text dimColor>No environments loaded. Press r to refresh.</Text>
          : (
            <Box flexDirection="column">
              <Box borderStyle="round" borderColor="green" paddingX={1}>
                <Input key="install-search" label="Find" placeholder="name or part of it, e.g. deseq" submitLabel="search"
                  onSubmit={value => {
                    const query = value.trim()
                    if (!isValidSpec(query)) return $.ui.toast(`vems: "${query}" is not a package name`)
                    void searchPackages($, query)
                  }} />
              </Box>
              <Text dimColor>into the active env <Text color="green" bold>{target.name}</Text>, from conda-forge and bioconda (anaconda.org search)</Text>
              {target.isBase && <Text color="yellow">base is read-only here: activate another env in Envs to install.</Text>}
              {confirmBox}
              {focused && !ask && (
                // Detail pane, as aptitude and lazygit do: the picked row's full text in one fixed spot.
                <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
                  <Text><Text bold>{focused.name}</Text><Text color="cyan">  {focused.version}</Text><Text dimColor>  {focused.channel}</Text></Text>
                  <Text>{focused.summary || 'No description.'}</Text>
                  <Text dimColor>https://anaconda.org/{focused.channel}/{focused.name}</Text>
                  {targetList.some(p => p.name === focused.name)
                    ? <Text dimColor>✓ already installed in {target.name}</Text>
                    : target.isBase ? null
                    : (
                      <Box>
                        <Button key="detail-install" variant="primary"
                          onPress={() => void askFor($, ({ action: 'install' as const, pkg: `${focused.channel}::${focused.name}`, env: target }))}>
                          <Text color="green" bold>Install</Text>
                        </Button>
                      </Box>
                    )}
                </Box>
              )}
              {hitList !== null && hitList.length === 0 && <Text dimColor>No package found on conda-forge or bioconda.</Text>}
              {hitList !== null && hitList.length > 0 && (
                <Box flexDirection="column">
                  {/* Fixed cells never shrink; only DESCRIPTION gives way, so a long summary can't squeeze the columns. */}
                  <Box>
                    <Box width={hitWidth.name + 4} flexShrink={0}><Text bold>{'  '}NAME</Text></Box>
                    <Box width={hitWidth.version + 2} flexShrink={0}><Text bold>VERSION</Text></Box>
                    <Box width={13} flexShrink={0}><Text bold>CHANNEL</Text></Box>
                    <Box width={9} flexShrink={0}><Text bold>INSTALL</Text></Box>
                    <Text bold>DESCRIPTION</Text>
                  </Box>
                  {hitList.map(hit => (
                    <Box key={`hit:${hitKey(hit)}`}>
                      <Box width={hitWidth.name + 4} flexShrink={0}>
                        <Button key={`pick:${hitKey(hit)}`} plain onPress={() => void update($, hitFocus, k => (k === hitKey(hit) ? null : hitKey(hit)))}>
                          <Text bold={focusKey === hitKey(hit)} color={focusKey === hitKey(hit) ? 'green' : undefined}>{focusKey === hitKey(hit) ? '▸ ' : '  '}{hit.name}</Text>
                        </Button>
                      </Box>
                      <Box width={hitWidth.version + 2} flexShrink={0}><Text color="cyan">{hit.version}</Text></Box>
                      <Box width={13} flexShrink={0}><Text dimColor>{hit.channel}</Text></Box>
                      <Box width={9} flexShrink={0} paddingLeft={3}>
                        {targetList.some(p => p.name === hit.name)
                          ? <Text dimColor>✓</Text>
                          : target.isBase ? <Text dimColor>-</Text>
                          : <Button key={`get:${hit.channel}:${hit.name}`} label={`install ${hit.name}`} plain
                              onPress={() => void askFor($, ({ action: 'install' as const, pkg: `${hit.channel}::${hit.name}`, env: target }))}>
                              <Text color="green">{SQUARE}</Text>
                            </Button>}
                      </Box>
                      <Text dimColor wrap="truncate-end">{hit.summary}</Text>
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          ))}


      </Box>
    )
  })
}
