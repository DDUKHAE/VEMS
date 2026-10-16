# VEMS

A Claude Code mod for managing conda environments and packages from a pane, so you don't have to remember `conda` commands in the terminal.

Type `/envs` to open it.

## Features

- **Envs**: every environment with its pending updates and disk size. From each row you can activate it for Claude's Bash commands, export a `.yml`, clone, or remove it. You can also create a new environment, import one from a `.yml` file, and clean conda's package cache.
- **Packages**: every package in the chosen environment, conda and pip alike. You can update one package or all of them, remove packages, and pin a version so updates leave it alone.
- **Install**: search conda-forge and bioconda by name or part of a name, read a package's description, and install it into the active environment.
- Shows the conda version and offers an update when one is out. Checks GitHub for new vems releases.

## Requirements

- Claude Code with mods (function-hook plugins)
- conda (Miniconda, Anaconda or Miniforge) on macOS or Linux

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install vems --marketplace DDUKHAE/VEMS
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install vems --marketplace DDUKHAE/VEMS
```

In the desktop app: click + next to the prompt box, then Plugins, then Add marketplace with `DDUKHAE/VEMS`, then Add plugin.

## Update

When the pane says a new version is out:

```
claude plugin update vems@vems
```

Then run `/reload-plugins` in the session.
