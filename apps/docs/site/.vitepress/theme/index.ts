import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import DocsDiff from "./components/DocsDiff.vue";
import "./styles.css";

const theme: Theme = {
  ...DefaultTheme,
  enhanceApp({ app }) {
    app.component("DocsDiff", DocsDiff);
  },
};

export default theme;
