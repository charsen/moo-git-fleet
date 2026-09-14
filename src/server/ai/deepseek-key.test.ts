import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `appRoot` 是模块级常量，所以每个用例都要重置模块再重新导入 provider，
 * 才能让 `GIT_FLEET_HOME` 指向临时目录。
 */
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function loadProvider(): Promise<typeof import('./provider.js')> {
  vi.resetModules();
  return import('./provider.js');
}

async function fixture(prefix: string): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(home);
  vi.stubEnv('GIT_FLEET_HOME', home);
  delete process.env.GIT_FLEET_AI_API_KEY;
  delete process.env.GIT_FLEET_AI_ENABLED;
  return home;
}

describe('DeepSeek Token 读取的失败语义', () => {
  it('文件不存在时视为未配置，不报错', async () => {
    await fixture('git-fleet-ai-key-missing-');
    const { readDeepSeekApiKey, aiProviderStatus } = await loadProvider();

    await expect(readDeepSeekApiKey()).resolves.toEqual({ apiKey: null, error: null });
    await expect(aiProviderStatus()).resolves.toMatchObject({ configured: false, keyError: null });
  });

  it('读到 Key 时按已配置返回', async () => {
    const home = await fixture('git-fleet-ai-key-present-');
    await writeFile(path.join(home, 'deepseek_token'), 'sk-test-key\n');
    const { readDeepSeekApiKey, aiProviderStatus } = await loadProvider();

    await expect(readDeepSeekApiKey()).resolves.toEqual({ apiKey: 'sk-test-key', error: null });
    await expect(aiProviderStatus()).resolves.toMatchObject({ configured: true, keyError: null });
  });

  it('已配置但读不出来时返回原因而不是抛出，首页因此仍能打开', async () => {
    const home = await fixture('git-fleet-ai-key-unreadable-');
    // 把 Token 路径做成目录：chmod 成功、readFile 报 EISDIR，是「已配置但读不出来」的真实形态之一。
    await mkdir(path.join(home, 'deepseek_token'));
    const { readDeepSeekApiKey, aiProviderStatus, loadDeepSeekApiKey } = await loadProvider();

    await expect(readDeepSeekApiKey()).resolves.toEqual({
      apiKey: null,
      error: '无法读取 deepseek_token，请检查文件权限',
    });
    // 关键断言：状态接口不抛。它服务于首页，抛出去会让整个工作台 500，
    // 而用户恰恰要靠这个界面才能进设置去修 Token。
    await expect(aiProviderStatus()).resolves.toMatchObject({
      configured: false,
      keyError: '无法读取 deepseek_token，请检查文件权限',
    });
    await expect(loadDeepSeekApiKey()).resolves.toBeNull();
  });

  it('环境变量优先于文件，且不受文件损坏影响', async () => {
    const home = await fixture('git-fleet-ai-key-env-');
    await mkdir(path.join(home, 'deepseek_token'));
    vi.stubEnv('GIT_FLEET_AI_API_KEY', 'sk-from-env');
    const { readDeepSeekApiKey } = await loadProvider();

    await expect(readDeepSeekApiKey()).resolves.toEqual({ apiKey: 'sk-from-env', error: null });
  });
});
