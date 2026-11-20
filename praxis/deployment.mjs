import { createStackIntegration } from './stack.mjs';
import { localCompose } from './local-compose.mjs';
export function createDeploymentIntegration() { return {
  stack: createStackIntegration(),
  localCompose,
  "dataId": "polaris",
  "volumes": [
    "polaris"
  ],
  "runtime": {
    "POLARIS_OBSERVATIONS_FILE": "/data/polaris/observations.json",
    "PRAXIS_WORKSPACE_ID": "${workspaceId}"
  },
  "businessBindings": {},
  "initialFiles": [
    {
      "path": "observations.json",
      "value": {
        "workspaceId": "${workspaceId}",
        "packs": [],
        "runs": [],
        "graphs": [],
        "events": {}
      }
    }
  ],
  "native": {
    "dockerfile": "Dockerfile.praxis",
    "command": [
      "node",
      "server.mjs"
    ]
  },
  provider: {
  "port": 18787,
  "portEnvs": [
    "PORT"
  ]
}
}; }
