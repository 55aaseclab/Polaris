# Neovim Usage Guide

The geek-env Neovim config is symlinked into `~/.config/nvim`. Edits to
`config/nvim/` take effect immediately. Leader key is `Space`.

## Layout

On startup, edgy.nvim manages a VS Code style layout:

- **Left** — neo-tree file explorer (pinned, 32 columns)
- **Center** — editor with buffer tabs (bufferline) and breadcrumbs (barbecue)
- **Bottom** — diagnostics panel (Trouble, collapsed by default)
- **Right** — symbols panel (collapsed by default)

Colorscheme is VS Code Dark. Statusline is lualine with global status.

## Keymaps

Press `Space` and wait for which-key to show available mappings.

### General

| Key | Action |
|-----|--------|
| `<leader>w` | Write file |
| `<leader>q` | Quit window |
| `<Esc>` | Clear search highlight |

### Window Navigation

| Key | Action |
|-----|--------|
| `<C-h>` | Move to left split |
| `<C-j>` | Move to lower split |
| `<C-k>` | Move to upper split |
| `<C-l>` | Move to right split |

### Buffers

| Key | Action |
|-----|--------|
| `<S-h>` | Previous buffer |
| `<S-l>` | Next buffer |
| `<leader>bd` | Delete buffer |
| `<leader>bb` | Alternate buffer |

### Scrolling and Search

| Key | Action |
|-----|--------|
| `<C-d>` | Scroll down (centered) |
| `<C-u>` | Scroll up (centered) |
| `n` | Next search result (centered) |
| `N` | Previous search result (centered) |

### Line Moving (Visual Mode)

| Key | Action |
|-----|--------|
| `J` | Move selection down |
| `K` | Move selection up |

### File Explorer (neo-tree)

| Key | Action |
|-----|--------|
| `<leader>e` | Toggle explorer |
| `l` | Open file/expand directory |
| `h` | Collapse directory |

The explorer follows the current file, shows git status and diagnostics,
and auto-refreshes on file changes.

### Telescope

| Key | Action |
|-----|--------|
| `<leader>ff` | Find files |
| `<leader>fg` | Live grep |
| `<leader>fb` | Buffers |
| `<leader>fh` | Help tags |

### Flash Navigation

| Key | Mode | Action |
|-----|------|--------|
| `s` | n, x, o | Flash jump (type characters to jump to) |
| `S` | n, x, o | Flash treesitter (select treesitter nodes) |

### Surround (nvim-surround)

| Key | Action |
|-----|--------|
| `ys{motion}{char}` | Add surrounding (e.g. `ysiw"` wraps word in quotes) |
| `ds{char}` | Delete surrounding (e.g. `ds"` removes quotes) |
| `cs{old}{new}` | Change surrounding (e.g. `cs"'` changes `"` to `'`) |

## LSP

Language servers are installed automatically via Mason:

| Server | Language |
|--------|----------|
| bashls | Bash/Shell |
| jsonls | JSON |
| lua_ls | Lua |
| marksman | Markdown |
| pyright | Python |

Run `:Mason` to browse and install additional servers.

### LSP Keymaps

Available in any buffer with an attached language server:

| Key | Action |
|-----|--------|
| `gd` | Go to definition |
| `gD` | Go to declaration |
| `gi` | Go to implementation |
| `gy` | Go to type definition |
| `gr` | Go to references |
| `K` | Hover documentation |
| `<leader>rn` | Rename symbol |
| `<leader>ca` | Code action |
| `<leader>cd` | Line diagnostics (float) |

### Diagnostics Navigation

| Key | Action |
|-----|--------|
| `[d` | Previous diagnostic |
| `]d` | Next diagnostic |

## Completion (blink.cmp)

Completion appears automatically as you type. Sources: LSP, file paths,
snippets (friendly-snippets), buffer words, and LazyDev (for Lua config
files).

| Key | Action |
|-----|--------|
| `<C-Space>` | Trigger completion manually |
| `<C-n>` / `<C-p>` | Next / previous item |
| `<C-y>` | Accept completion |
| `<C-e>` | Dismiss menu |

Auto-brackets are enabled (inserting `(` after completing a function).
Signature help is shown automatically when typing function arguments.
Documentation previews appear after a short delay.

## Formatting (conform.nvim)

Files are formatted automatically on save. Manual format:

| Key | Action |
|-----|--------|
| `<leader>cf` | Format buffer |

Configured formatters:

| Language | Formatter |
|----------|-----------|
| Lua | stylua |
| Python | black |
| JS/TS/JSON/YAML/Markdown | prettierd (falls back to prettier) |
| Bash/Shell | shfmt |

`stylua` and `shfmt` are installed automatically via Mason. Install others
as needed (`pip install black`, `npm i -g prettierd`, etc.).

Run `:ConformInfo` to see which formatter is active for the current buffer.

## Git (gitsigns)

Signs appear in the gutter for added (`+`), changed (`~`), and deleted
(`_`) lines.

| Key | Action |
|-----|--------|
| `]h` | Next hunk |
| `[h` | Previous hunk |
| `<leader>hs` | Stage hunk |
| `<leader>hr` | Reset hunk |
| `<leader>hu` | Undo stage hunk |
| `<leader>hp` | Preview hunk |
| `<leader>hb` | Blame line (full commit) |
| `<leader>hd` | Diff against index |

## Diagnostics and Panels (Trouble)

| Key | Action |
|-----|--------|
| `<leader>xx` | Toggle workspace diagnostics |
| `<leader>xX` | Toggle buffer diagnostics |
| `<leader>cs` | Toggle symbols panel |
| `<leader>cl` | Toggle LSP locations panel |
| `<leader>xt` | Toggle TODO list |

## TODO Comments

`TODO`, `FIXME`, `HACK`, `WARN`, `NOTE`, and `PERF` comments are
highlighted in the editor automatically.

| Key | Action |
|-----|--------|
| `]t` | Next TODO comment |
| `[t` | Previous TODO comment |
| `<leader>xt` | Show all TODOs in Trouble |

## Treesitter Text Objects

Structural selections and motions based on syntax tree:

### Selection

Use with operators like `d`, `y`, `c`, or in visual mode (`v`):

| Key | Selects |
|-----|---------|
| `af` | Outer function |
| `if` | Inner function |
| `ac` | Outer class |
| `ic` | Inner class |
| `aa` | Outer argument/parameter |
| `ia` | Inner argument/parameter |

### Motion

| Key | Action |
|-----|--------|
| `]f` | Next function start |
| `[f` | Previous function start |
| `]c` | Next class start |
| `[c` | Previous class start |

### Swap

| Key | Action |
|-----|--------|
| `<leader>a` | Swap argument with next |
| `<leader>A` | Swap argument with previous |

## Plugin Management

Plugins are managed by lazy.nvim. Useful commands:

| Command | Action |
|---------|--------|
| `:Lazy` | Open plugin manager UI |
| `:Lazy sync` | Install, update, and clean plugins |
| `:Lazy update` | Update all plugins |
| `:Mason` | Open LSP/tool installer UI |
| `:checkhealth` | Verify plugin and provider health |

Headless plugin sync (useful in scripts):

```bash
nvim --headless "+Lazy! sync" +qa
```

## Project Detection

project.nvim automatically sets the working directory to the project root
based on `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, or
`Makefile` markers.

## Config Structure

```
config/nvim/
  init.lua                     -- leader key, loads config modules
  lua/config/
    options.lua                -- vim options
    keymaps.lua                -- global keybindings
    lazy.lua                   -- lazy.nvim bootstrap
  lua/plugins/
    coding.lua                 -- autopairs, surround, flash, todo-comments, conform
    editor.lua                 -- project.nvim, neo-tree, telescope, treesitter, which-key
    git.lua                    -- gitsigns
    lsp.lua                    -- mason, blink.cmp, lspconfig, lazydev
    ui.lua                     -- vscode theme, barbecue, bufferline, lualine, trouble,
                                  indent-blankline, edgy
```
