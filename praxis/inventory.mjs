import { join } from 'node:path';
export function projectInventory({id,config,working,workspaceId,storage,reminderSpaces,slidesSpaces,polaris,financeMounts,financeProjectName,intelligenceRuntime,locations,add,file,source,safePath,paths,object}) {
if (object(polaris)) {

      if (safePath(polaris.observationsFile)) file('Read-only workspace observations', 'json', polaris.observationsFile);
      if (safePath(polaris.dataRoot)) {
        file('业务数据根', 'directory', polaris.dataRoot);
        file('当前控制数据库', 'sqlite', join(polaris.dataRoot, 'control/state/control.sqlite'));
        if (workspaceId) file('工作区运行配置与 Vault 定义', 'directory', join(polaris.dataRoot, 'control/workspaces', workspaceId));
        file('采集断点和快照', 'directory', join(polaris.dataRoot, 'collection-jobs'));
        file('工作区与执行数据', 'directory', join(polaris.dataRoot, 'vault-data'));
      }
      file('浏览器资料与状态', 'directory', polaris.browserProfiles);
      file('浏览器二进制缓存', 'cache', polaris.browserCache, '缓存不等同于业务事实数据。');
      file('独立工具会话', 'directory', polaris.codexHome);
}
}
