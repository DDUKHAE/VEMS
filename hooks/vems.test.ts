import { expect, mock, test } from 'claude-code/testing'

import { activatePrefix, argv, isValidSpec, isNewer, parseCleanable, parseCreate, parseEnvs, parsePins, parsePipOutdated, parseSearch, parseUpdates, pinFile, togglePin } from './conda'

const ENVS = JSON.stringify({
  envs: ['/opt/conda', '/opt/conda/envs/rnaseq'],
  envs_details: { '/opt/conda': { name: 'base', base: true }, '/opt/conda/envs/rnaseq': { name: 'rnaseq' } },
})
const PKGS = JSON.stringify([
  { name: 'samtools', version: '1.20', channel: 'bioconda' },
  { name: 'python', version: '3.11.9', channel: 'conda-forge' },
  { name: 'requests', version: '2.31.0', channel: 'pypi' },
])
const DRY_RUN = JSON.stringify({
  actions: {
    UNLINK: [{ name: 'samtools', version: '1.20' }, { name: 'conda', version: '26.5.3' }, { name: 'libssh2', version: '1.11.1' }],
    LINK: [{ name: 'samtools', version: '1.21' }, { name: 'htslib', version: '1.21' }, { name: 'conda', version: '26.7.0' }, { name: 'libssh2', version: '1.11.1' }],
  },
})
// pip reports conda's python too; only the pypi-channel package may count.
const PIP_OUTDATED = JSON.stringify([
  { name: 'Requests', version: '2.31.0', latest_version: '2.32.3' },
  { name: 'python', version: '3.11.9', latest_version: '3.12.0' },
])
const SEARCH = JSON.stringify([
  { owner: 'someone', name: 'samtools', latest_version: '0.1', summary: 'a personal build' },
  { owner: 'bioconda', name: 'bioconductor-deseq2', latest_version: '1.50.2', summary: 'Differential gene expression analysis based on the negative binomial distribution, for RNA-seq count data' },
  { owner: 'bioconda', name: 'samtools', latest_version: '1.24', summary: 'Tools for SAM, BAM and CRAM' },
])
// conda clean --all --dry-run --json: 512 MiB of tarballs + 512 MiB of unused packages, in bytes.
const CLEANABLE = JSON.stringify({ tarballs: { total_size: 536870912 }, packages: { total_size: 536870912 } })
const BASE = { name: 'base', path: '/opt/conda', isBase: true }
const RNASEQ = { name: 'rnaseq', path: '/opt/conda/envs/rnaseq', isBase: false }
const PANE = {
  title: 'Environments', isFocused: true, bodyColumns: 80, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 }, view: {},
}

test('parses env list and checks specs', async () => {
  expect(parseEnvs(ENVS)).toEqual([
    { name: 'base', path: '/opt/conda', isBase: true },
    RNASEQ,
  ])
  expect(isValidSpec('samtools')).toBe(true)
  expect(isValidSpec('bioconda::samtools=1.20')).toBe(true)
  expect(isValidSpec('samtools; rm -rf ~')).toBe(false)
  expect(isValidSpec('')).toBe(false)
  expect(parseCreate('myenv python=3.11 samtools')).toEqual({ name: 'myenv', specs: ['python=3.11', 'samtools'] })
  expect(parseCreate('bad;name')).toBe(null)
  expect(parseCleanable(CLEANABLE)).toBe(1048576)
  expect(isNewer('0.10.0', '0.9.3')).toBe(true)
  expect(isNewer('0.1.0', '0.1.0')).toBe(false)
  expect(isNewer('0.1', '0.1.1')).toBe(false)
  expect(parseSearch(SEARCH, 'samtools').map(h => `${h.channel}::${h.name}`)).toEqual(['bioconda::samtools', 'bioconda::bioconductor-deseq2'])
  expect(parsePipOutdated(PIP_OUTDATED, [{ name: 'requests', version: '2.31.0', source: 'pip' }])).toEqual({ requests: '2.32.3' })
  expect(togglePin('', 'samtools', '1.20')).toBe('samtools ==1.20\n')
  expect(togglePin('# keep\nsamtools ==1.20\nnumpy 1.26.*\n', 'samtools', '1.20')).toBe('# keep\nnumpy 1.26.*\n')
  expect(parsePins('# keep\nnumpy 1.26.*\nsamtools==1.20\n')).toEqual(['numpy', 'samtools'])
  expect(argv.updatePkg({ name: 'base', path: '/opt/conda', isBase: true }, 'numpy')).toEqual(['update', '-p', '/opt/conda', '-y', 'numpy'])
  expect(argv.updatePkg({ name: 'base', path: '/opt/conda', isBase: true }, 'conda', '26.9.3')).toEqual(['install', '-p', '/opt/conda', '-y', 'conda=26.9.3'])
  expect(parseUpdates(DRY_RUN)).toEqual({ samtools: '1.21', conda: '26.7.0' })
  expect(parseUpdates('{"success": true, "message": "All requested packages already installed."}')).toEqual({})
  expect(parseCreate('ok $(rm -rf ~)')).toBe(null)
  expect(activatePrefix('conda', { name: 'x', path: "/a/it's", isBase: false })).toBe(`eval "$('conda' shell.posix activate '/a/it'\\''s')"`)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`browse, then remove a package after confirm (${surface})`, async ($, on) => {
    const calls: string[][] = []
    mock.env(on, { CONDA_EXE: 'conda' })
    mock.store(on)
    mock.clock(on)
    // Long jobs stream through process.spawn: record the call and play one progress line.
    on('process.spawn', async function* ($, e) {
      calls.push(e.argv.slice(1))
      yield { stream: 'stdout' as const, text: 'Solving environment: done\n' }

      return { value: { code: 0, signal: null } }
    })
    on('process.run', async ($, e) => {
      const [exe, ...args] = e.argv
      const ok = (stdout: string, exitCode = 0) =>
        ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
      if (exe === 'cat') return files[args[0]!] === undefined ? ok('', 1) : ok(files[args[0]!]!)
      if (exe === 'tee') return (files[args[0]!] = e.init?.stdin ?? ''), ok('')
      calls.push(args)
      if (args[1] === 'pip') return ok(args[2] === 'list' ? PIP_OUTDATED : '')
      const stdout = args[0] === '--version' ? 'conda 26.5.3\n' : args[0] === 'env' ? ENVS : args[0] === 'list' ? PKGS : args[0] === 'update' ? DRY_RUN : ''

      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })

    const files: Record<string, string> = {}
    on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: SEARCH } }))

    const ui = await $.ui.mount({ plugin: 'vems', surface, component: 'Pane', requestId: 'vems', props: PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: 'rnaseq' })).toBeDefined()
    expect(await ui.find({ text: /3 updates/ })).toBeDefined()
    const checks = () => calls.filter(c => c[0] === 'update' && c.includes('--dry-run')).length
    const before = checks()
    await ui.press({ key: 'refresh' })
    expect(checks()).toBe(before + 2)
    expect(calls).toContainEqual(argv.updates(RNASEQ, false))
    expect(await ui.find({ text: '26.5.3' })).toBeDefined()
    await ui.press({ key: 'update-conda' })
    expect(await ui.find({ text: /26\.5\.3 → 26\.7\.0/ })).toBeDefined()
    await ui.press({ key: 'confirm' })
    expect(calls).toContainEqual(argv.updatePkg(BASE, 'conda', '26.7.0'))

    await ui.press({ key: `env:${RNASEQ.path}` })
    expect(await ui.find({ text: 'samtools' })).toBeDefined()
    expect(await ui.find({ key: 'up:python' })).toBeUndefined()
    await ui.press({ key: 'up:requests' })
    expect(await ui.find({ text: /2\.31\.0 → 2\.32\.3/ })).toBeDefined()
    await ui.press({ key: 'confirm' })
    expect(calls).toContainEqual(argv.pipUpgrade(RNASEQ, ['requests']).slice(1))
    await ui.press({ key: 'updates-only' })
    expect(await ui.find({ text: /^python/ })).toBeUndefined()
    expect(await ui.find({ key: 'up:samtools' })).toBeDefined()
    await ui.press({ key: 'updates-only' })
    expect(await ui.find({ key: 'rm:python' })).toBeDefined()

    await ui.press({ key: 'update-all' })
    expect(await ui.find({ text: /No pinned packages/ })).toBeDefined()
    await ui.press({ key: 'confirm' })
    expect(calls).toContainEqual(argv.updateAll(RNASEQ))

    await ui.press({ key: 'pin:samtools' })
    expect(files[pinFile(RNASEQ)]).toBe('samtools ==1.20\n')
    expect(await ui.find({ key: 'up:samtools' })).toBeUndefined()
    await ui.press({ key: 'pin:samtools' })
    expect(files[pinFile(RNASEQ)]).toBe('\n')
    expect(await ui.find({ key: 'up:samtools' })).toBeDefined()
    await ui.press({ key: 'up:samtools' })
    expect(await ui.find({ text: /1\.20 → 1\.21/ })).toBeDefined()
    await ui.press({ key: 'confirm' })
    expect(calls).toContainEqual(argv.updatePkg(RNASEQ, 'samtools', '1.21'))

    await ui.press({ key: 'rm:samtools' })
    expect(await ui.find({ text: /Remove samtools from rnaseq\?/ })).toBeDefined()
    expect(calls.some(c => c[0] === 'remove')).toBe(false)

    await ui.press({ key: 'confirm' })
    expect(calls).toContainEqual(argv.remove(RNASEQ, 'samtools'))

    await ui.press({ key: 'tab-install' })
    expect(await ui.find({ text: /base is read-only here/ })).toBeDefined()
    await ui.press({ key: 'tab-envs' })
    await ui.press({ key: `act:${RNASEQ.path}` })
    await ui.press({ key: 'tab-install' })
    await ui.input({ key: 'install-search', text: 'samtools' })
    expect(await ui.find({ key: 'get:bioconda:samtools' })).toBeUndefined()
    await ui.press({ key: 'pick:bioconda:bioconductor-deseq2' })
    expect(await ui.find({ text: 'https://anaconda.org/bioconda/bioconductor-deseq2' })).toBeDefined()
    await ui.press({ key: 'pick:bioconda:samtools' })
    expect(await ui.find({ text: /already installed in rnaseq/ })).toBeDefined()
    await ui.press({ key: 'pick:bioconda:bioconductor-deseq2' })
    await ui.press({ key: 'detail-install' })
    expect(await ui.find({ text: /Install bioconda::bioconductor-deseq2 into rnaseq\?/ })).toBeDefined()
    await ui.press({ key: 'cancel' })
    await ui.press({ key: 'get:bioconda:bioconductor-deseq2' })
    expect(await ui.find({ text: /Install bioconda::bioconductor-deseq2 into rnaseq\?/ })).toBeDefined()
    await ui.press({ key: 'confirm' })
    expect(calls).toContainEqual(argv.install(RNASEQ, 'bioconda::bioconductor-deseq2'))

    await ui.press({ key: 'tab-envs' })
    expect(await ui.find({ key: 'rmenv:/opt/conda' })).toBeUndefined()
    await ui.press({ key: `rmenv:${RNASEQ.path}` })
    expect(await ui.find({ text: /Remove environment rnaseq\?/ })).toBeDefined()
    await ui.press({ key: 'confirm' })
    expect(calls).toContainEqual(argv.removeEnv(RNASEQ))
    expect(await ui.find({ key: `env:${RNASEQ.path}` })).toBeUndefined()
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`create an env, then activate it for Bash (${surface})`, async ($, on) => {
    const calls: string[][] = []
    const commands: string[] = []
    mock.env(on, { CONDA_EXE: 'conda', HOME: '/home/me' })
    // The mod loaded at 0.1.0 while GitHub's main branch says 0.2.0.
    on('fs.read', async () => ({ value: '{"version": "0.1.0"}' }))
    on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: '{"version": "0.2.0"}' } }))
    mock.store(on)
    mock.clock(on)
    // Long jobs stream through process.spawn: record the call and play one progress line.
    on('process.spawn', async function* ($, e) {
      calls.push(e.argv.slice(1))
      yield { stream: 'stdout' as const, text: 'Solving environment: done\n' }

      return { value: { code: 0, signal: null } }
    })
    // du -k -d 1: rnaseq is 1 GiB; base is 5 GiB with 2 GiB of envs/ and 1 GiB of pkgs/ inside.
    const DU: Record<string, string> = {
      [RNASEQ.path]: `1048576\t${RNASEQ.path}\n`,
      [BASE.path]: `2097152\t/opt/conda/envs\n1048576\t/opt/conda/pkgs\n5242880\t/opt/conda\n`,
    }
    on('process.run', async ($, e) => {
      const args = e.argv.slice(1)
      calls.push(args)
      const stdout = e.argv[0] === 'du' ? DU[args.at(-1)!] ?? '' : args[0] === 'clean' ? CLEANABLE : args[0] === '--version' ? 'conda 26.5.3\n' : args[0] === 'env' ? ENVS : args[0] === 'list' ? PKGS : ''

      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('tool.call', async ($, e) => {
      if (e.tool === 'Bash') commands.push(e.command)

      return { deny: 'not run in tests' }
    })

    const ui = await $.ui.mount({ plugin: 'vems', surface, component: 'Pane', requestId: 'vems', props: PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: '1.0G' })).toBeDefined()
    expect(await ui.find({ text: /vems 0\.1\.0 → 0\.2\.0 available/ })).toBeDefined()
    expect(await ui.find({ text: '2.0G' })).toBeDefined()
    expect(await ui.find({ text: /Clean cache \(1\.0G\)/ })).toBeDefined()
    // One box at a time: the clean confirm replaces an open import form, and a form replaces the confirm.
    await ui.press({ key: 'import' })
    await ui.press({ key: 'clean' })
    expect(await ui.find({ key: 'import-path' })).toBeUndefined()
    await ui.press({ key: 'new-env' })
    expect(await ui.find({ key: 'confirm' })).toBeUndefined()
    await ui.press({ key: 'clean' })
    await ui.press({ key: 'confirm' })
    expect(calls).toContainEqual(argv.clean())

    await ui.press({ key: 'import' })
    await ui.input({ key: 'import-path', text: '~/proj/environment.yml' })
    expect(calls).toContainEqual(argv.importYml('/home/me/proj/environment.yml'))
    await ui.press({ key: `clone:${RNASEQ.path}` })
    expect(await ui.find({ key: 'import-path' })).toBeUndefined()
    await ui.input({ key: 'clone-name', text: 'rnaseq_bk' })
    expect(calls).toContainEqual(argv.clone(RNASEQ, 'rnaseq_bk'))
    expect(await ui.find({ key: 'update-conda' })).toBeUndefined()
    expect(await ui.find({ key: 'create' })).toBeUndefined()
    await ui.press({ key: 'new-env' })
    await ui.input({ key: 'create', text: 'newenv python=3.11' })
    expect(calls).toContainEqual(argv.create('newenv', ['python=3.11']))
    expect(await ui.find({ key: 'create' })).toBeUndefined()

    await $.tool.call({ tool: 'Bash', command: 'which python' })
    expect(commands.at(-1)).toBe('which python')

    await ui.press({ key: `env:${RNASEQ.path}` })
    await ui.press({ key: 'tab-envs' })
    await ui.press({ key: `act:${RNASEQ.path}` })
    await $.tool.call({ tool: 'Bash', command: 'which python' })
    expect(commands.at(-1)).toBe(`${activatePrefix('conda', RNASEQ)}\nwhich python`)

    await ui.press({ key: `act:${RNASEQ.path}` })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(commands.at(-1)).toBe('ls')
    await ui.unmount()
  })
}
