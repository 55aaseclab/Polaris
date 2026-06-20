return {
  {
    "Mofiqul/vscode.nvim",
    name = "vscode",
    priority = 1000,
    opts = {
      style = "dark",
      transparent = false,
      italic_comments = true,
      disable_nvimtree_bg = true,
    },
    config = function(_, opts)
      require("vscode").setup(opts)
      vim.cmd.colorscheme("vscode")
    end,
  },
  {
    "utilyre/barbecue.nvim",
    version = "*",
    dependencies = {
      "SmiteshP/nvim-navic",
      "nvim-tree/nvim-web-devicons",
    },
    opts = {
      create_autocmd = true,
      attach_navic = false,
      show_dirname = false,
      exclude_filetypes = {
        "Trouble",
        "alpha",
        "dashboard",
        "lazy",
        "neo-tree",
      },
      modifiers = {
        dirname = ":~:.",
      },
    },
  },
  {
    "akinsho/bufferline.nvim",
    version = "*",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    opts = {
      options = {
        mode = "buffers",
        diagnostics = "nvim_lsp",
        always_show_bufferline = true,
        separator_style = "thin",
        show_buffer_close_icons = false,
        show_close_icon = false,
        offsets = {
          {
            filetype = "neo-tree",
            text = "Explorer",
            highlight = "Directory",
            text_align = "left",
          },
        },
      },
    },
  },
  {
    "nvim-lualine/lualine.nvim",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    opts = {
      options = {
        theme = "vscode",
        globalstatus = true,
      },
    },
  },
  {
    "folke/trouble.nvim",
    cmd = "Trouble",
    keys = {
      {
        "<leader>xx",
        "<cmd>Trouble diagnostics toggle focus=false win.position=bottom<cr>",
        desc = "Diagnostics panel",
      },
      {
        "<leader>xX",
        "<cmd>Trouble diagnostics toggle focus=false filter.buf=0 win.position=bottom<cr>",
        desc = "Buffer diagnostics panel",
      },
      {
        "<leader>cs",
        "<cmd>Trouble symbols toggle focus=false win.position=right<cr>",
        desc = "Symbols panel",
      },
      {
        "<leader>cl",
        "<cmd>Trouble lsp toggle focus=false win.position=right<cr>",
        desc = "LSP list panel",
      },
    },
    opts = {
      focus = false,
      auto_preview = false,
      win = {
        type = "split",
        position = "bottom",
      },
    },
  },
  {
    "lukas-reineke/indent-blankline.nvim",
    main = "ibl",
    event = { "BufReadPre", "BufNewFile" },
    opts = {
      indent = {
        char = "|",
      },
      scope = {
        enabled = true,
        show_start = false,
        show_end = false,
      },
      exclude = {
        filetypes = {
          "help",
          "lazy",
          "mason",
          "neo-tree",
          "Trouble",
        },
      },
    },
  },
}
