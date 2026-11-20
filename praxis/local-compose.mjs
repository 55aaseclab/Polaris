// Source-only local installation recipe. Preserve volume identities during upgrades.
export const localCompose = {
  "services": {
    "polaris": {
      "build": {
        "args": {
          "PRAXIS_GID": "${PRAXIS_GID:-1000}",
          "PRAXIS_UID": "${PRAXIS_UID:-1000}"
        },
        "context": "./third_party/polaris",
        "dockerfile": "Dockerfile.praxis"
      },
      "cap_drop": [
        "ALL"
      ],
      "command": [
        "node",
        "server.mjs"
      ],
      "configs": [
        {
          "source": "native-launcher",
          "target": "/opt/praxis/launch-builtin.mjs"
        }
      ],
      "depends_on": {
        "core": {
          "condition": "service_started",
          "required": true
        }
      },
      "entrypoint": [
        "node",
        "/opt/praxis/launch-builtin.mjs"
      ],
      "environment": {
        "HEALTH_URL": "http://127.0.0.1:18787/health"
      },
      "healthcheck": {
        "interval": "10s",
        "retries": 6,
        "start_period": "10s",
        "test": [
          "CMD",
          "node",
          "-e",
          "fetch(process.env.HEALTH_URL).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ],
        "timeout": "5s"
      },
      "image": "praxis-builtins/polaris:local",
      "init": true,
      "logging": {
        "driver": "json-file",
        "options": {
          "max-file": "3",
          "max-size": "10m"
        }
      },
      "network_mode": "service:core",
      "read_only": true,
      "restart": "unless-stopped",
      "security_opt": [
        "no-new-privileges:true"
      ],
      "stop_grace_period": "30s",
      "tmpfs": [
        "/tmp:rw,nosuid,nodev,size=512m,mode=1777"
      ],
      "volumes": [
        {
          "read_only": true,
          "source": "polaris-config",
          "target": "/config",
          "type": "volume",
          "volume": {
            "nocopy": true
          }
        },
        {
          "source": "polaris-data",
          "target": "/data/polaris",
          "type": "volume",
          "volume": {
            "nocopy": true
          }
        }
      ]
    }
  },
  "volumes": {
    "polaris-config": {},
    "polaris-data": {}
  },
  "initializeVolumes": [],
  "webVolumes": []
};
