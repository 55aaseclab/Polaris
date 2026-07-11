export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)"],
        body: ["var(--font-body)"],
      },
      colors: {
        ink: "var(--color-ink)",
        paper: "var(--color-paper)",
        bone: "var(--color-bone)",
        oxide: "var(--color-oxide)",
        brass: "var(--color-brass)",
        signal: "var(--color-signal)",
        field: "var(--color-field)",
      },
      boxShadow: {
        hard: "10px 10px 0 var(--color-ink)",
        lift: "0 24px 80px rgba(28, 35, 33, 0.18)",
      },
    },
  },
  plugins: [],
};
