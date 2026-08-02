return {
  {
    "mason-org/mason.nvim",
    opts = {},
  },
  {
    "WhoIsSethDaniel/mason-tool-installer.nvim",
    dependencies = {
      "mason-org/mason.nvim",
    },
    opts = {
      ensure_installed = {
        "bashls",
        "jsonls",
        "lua_ls",
        "marksman",
        "pyright",
        "shfmt",
        "stylua",
      },
    },
  },
  {
    "mason-org/mason-lspconfig.nvim",
    dependencies = {
      "mason-org/mason.nvim",
      "neovim/nvim-lspconfig",
    },
    opts = {
      ensure_installed = {
        "bashls",
        "jsonls",
        "lua_ls",
        "marksman",
        "pyright",
      },
      automatic_enable = true,
    },
  },
  {
    "folke/lazydev.nvim",
    ft = "lua",
    opts = {},
  },
  {
    "saghen/blink.cmp",
    version = "1.*",
    dependencies = {
      "rafamadriz/friendly-snippets",
    },
    opts = {
      keymap = { preset = "default" },
      appearance = {
        nerd_font_variant = "mono",
      },
      completion = {
        accept = { auto_brackets = { enabled = true } },
        documentation = { auto_show = true, auto_show_delay_ms = 200 },
        menu = {
          draw = {
            columns = {
              { "label", "label_description", gap = 1 },
              { "kind_icon", "kind" },
            },
          },
        },
      },
      sources = {
        default = { "lsp", "path", "snippets", "buffer", "lazydev" },
        providers = {
          lazydev = {
            name = "LazyDev",
            module = "lazydev.integrations.blink",
            score_offset = 100,
          },
        },
      },
      signature = { enabled = true },
    },
  },
  {
    "neovim/nvim-lspconfig",
    dependencies = {
      "saghen/blink.cmp",
      "SmiteshP/nvim-navic",
    },
    config = function()
      local navic = require("nvim-navic")

      navic.setup({
        highlight = true,
        separator = " > ",
        depth_limit = 5,
        lsp = {
          auto_attach = true,
        },
      })

      vim.api.nvim_create_autocmd("LspAttach", {
        group = vim.api.nvim_create_augroup("geek_env_lsp_attach", { clear = true }),
        callback = function(args)
          local map = function(keys, func, desc)
            vim.keymap.set("n", keys, func, { buffer = args.buf, desc = desc })
          end

          map("gd", vim.lsp.buf.definition, "Go to definition")
          map("gD", vim.lsp.buf.declaration, "Go to declaration")
          map("gi", vim.lsp.buf.implementation, "Go to implementation")
          map("gy", vim.lsp.buf.type_definition, "Go to type definition")
          map("gr", vim.lsp.buf.references, "Go to references")
          map("K", vim.lsp.buf.hover, "Hover docs")
          map("<leader>rn", vim.lsp.buf.rename, "Rename symbol")
          map("<leader>ca", vim.lsp.buf.code_action, "Code action")
          map("<leader>cd", vim.diagnostic.open_float, "Line diagnostics")
        end,
      })

      local capabilities = require("blink.cmp").get_lsp_capabilities()

      local servers = {
        bashls = {},
        jsonls = {},
        lua_ls = {},
        marksman = {},
        pyright = {},
      }

      for server, server_opts in pairs(servers) do
        server_opts.capabilities = capabilities
        vim.lsp.config(server, server_opts)
      end
    end,
  },
}
