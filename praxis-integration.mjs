import { createWebIntegration } from './praxis/web.mjs';
import { createStorageIntegration } from './praxis/storage.mjs';
import { createDeploymentIntegration } from './praxis/deployment.mjs';

export function createIntegration({ z }) {
return { schemaVersion:1, appId:"polaris", web:createWebIntegration(),storage:createStorageIntegration(),deployment:createDeploymentIntegration() };
}
