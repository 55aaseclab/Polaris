import { projectInventory } from './inventory.mjs';
export function createStorageIntegration() { return {
  inventory: { project: projectInventory, includeWithInput: 'polaris' },
  "rootId": "polaris",
  "paths": {
    "polaris": "data",
    "polarisBrowser": "browser",
    "polarisCache": "cache",
    "polarisCodex": "codex"
  },
  "sources": [],
  "omissions": [
    "Polaris legacy multi-database trees require a stopped-writer app-owned export; the runtime observer contains no execution tools."
  ],
  relocation: {
  "legacyConfiguration": {
    "input": "polaris",
    "configFile": "polaris.json",
    "configOption": "polaris-config",
    "optional": true,
    "relocationPolicy": "unavailable",
    "enabledKey": "enabled",
    "bindings": {
      "dataRoot": "polaris",
      "browserProfiles": "polarisBrowser",
      "browserCache": "polarisCache",
      "codexHome": "polarisCodex"
    }
  },
  "legacyEnvironment": {
    "variable": "POLARIS_DATA_ROOT"
  }
}
}; }
