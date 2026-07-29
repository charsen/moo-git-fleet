import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeSessionVault,
  loadSessionVaultStatus,
  resolveSuggestedSessionVaultPath,
  SESSION_VAULT_PRIVATE_LABEL,
  SESSION_VAULT_PRIVATE_REMOTE_CONFIRMATION,
  SessionVaultSafetyError,
} from './vault.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createFleetRepository(root: string): Promise<string> {
  const fleetPath = path.join(root, 'moo-git-fleet');
  await mkdir(fleetPath, { recursive: true });
  await execFileAsync('git', ['init', '--initial-branch=main', fleetPath]);
  await execFileAsync('git', ['-C', fleetPath, 'remote', 'add', 'origin', 'https://example.test/open-source/moo-git-fleet.git']);
  return fleetPath;
}

function serviceOptions(root: string, fleetPath: string) {
  return {
    fleetRepositoryPath: fleetPath,
    bindingPath: path.join(root, 'fleet-home', 'config', 'session-vault.yaml'),
    now: new Date('2026-07-28T02:00:00.000Z'),
  };
}

async function expectSafetyFailure(promise: Promise<unknown>, code: string, text: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => {
    return error instanceof SessionVaultSafetyError && error.code === code && error.message.includes(text);
  });
}

describe('Session Vault isolation and initialization', () => {
  it('suggests a dedicated Vault beside config without requiring a path choice', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-vault-suggested-'));
    temporaryDirectories.push(root);
    const fleetPath = await createFleetRepository(root);
    const options = serviceOptions(root, fleetPath);

    expect(resolveSuggestedSessionVaultPath(options)).toBe(path.join(root, 'fleet-home', 'session-vault'));
    await expect(loadSessionVaultStatus(options)).resolves.toMatchObject({
      configured: false,
      suggestedVaultPath: path.join(root, 'fleet-home', 'session-vault'),
    });
  });

  it('rejects the open-source root, a child path and a shared Fleet remote', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-vault-boundary-'));
    temporaryDirectories.push(root);
    const fleetPath = await createFleetRepository(root);
    const options = serviceOptions(root, fleetPath);

    await expectSafetyFailure(
      initializeSessionVault({ vaultPath: fleetPath, enableRemoteSync: false }, options),
      'path-overlaps-fleet',
      '开源仓库根目录',
    );
    await expectSafetyFailure(
      initializeSessionVault({ vaultPath: path.join(fleetPath, 'docs', 'vault'), enableRemoteSync: false }, options),
      'path-overlaps-fleet',
      '子目录',
    );
    await expectSafetyFailure(
      initializeSessionVault(
        {
          vaultPath: path.join(root, 'shared-remote-vault'),
          remoteUrl: 'git@example.test:open-source/moo-git-fleet.git',
          enableRemoteSync: false,
        },
        options,
      ),
      'remote-matches-fleet',
      '不能与 Moo Fleet 开源仓库远端相同',
    );
  });

  it('requires the exact private-remote confirmation before creating a remote-sync Vault', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-vault-confirmation-'));
    temporaryDirectories.push(root);
    const fleetPath = await createFleetRepository(root);
    const vaultPath = path.join(root, 'private-vault');
    const options = serviceOptions(root, fleetPath);

    await expectSafetyFailure(
      initializeSessionVault(
        { vaultPath, remoteUrl: 'https://example.test/private/session-vault.git', enableRemoteSync: true },
        options,
      ),
      'private-confirmation-required',
      SESSION_VAULT_PRIVATE_REMOTE_CONFIRMATION,
    );
    await expect(access(path.join(vaultPath, '.git'))).rejects.toThrow();
    await expect(access(options.bindingPath)).rejects.toThrow();

    const missingRemotePath = path.join(root, 'missing-remote-vault');
    await expectSafetyFailure(
      initializeSessionVault({ vaultPath: missingRemotePath, enableRemoteSync: true }, options),
      'remote-required',
      '必须配置独立的私有 Git 远端',
    );
    await expect(access(path.join(missingRemotePath, '.git'))).rejects.toThrow();
  });

  it('initializes local-only Vaults and keeps the privacy label honest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-vault-local-'));
    temporaryDirectories.push(root);
    const fleetPath = await createFleetRepository(root);
    const options = serviceOptions(root, fleetPath);
    const status = await initializeSessionVault({ vaultPath: path.join(root, 'local-vault') }, options);

    expect(status).toMatchObject({
      configured: true,
      privacyLabel: '仅本机（未启用远端同步）',
      binding: { remoteSyncEnabled: false, privacyState: 'local-only', normalizedRemoteUrl: null },
      manifest: { privacyMode: 'plaintext-private', remote: null },
    });
    expect(await readdir(status.binding!.vaultPath)).toContain('vault.yaml');
    const reloaded = await loadSessionVaultStatus(options);
    expect(reloaded).toEqual(status);
  });

  it('binds an isolated remote only after confirmation and stores no credential-bearing URL', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-vault-remote-'));
    temporaryDirectories.push(root);
    const fleetPath = await createFleetRepository(root);
    const options = serviceOptions(root, fleetPath);
    const status = await initializeSessionVault(
      {
        vaultPath: path.join(root, 'remote-vault'),
        remoteName: 'origin',
        remoteUrl: 'ssh://example.test/private/session-vault.git',
        enableRemoteSync: true,
        confirmationPhrase: SESSION_VAULT_PRIVATE_REMOTE_CONFIRMATION,
      },
      options,
    );

    expect(status.privacyLabel).toBe(SESSION_VAULT_PRIVATE_LABEL);
    expect(status.binding).toMatchObject({
      remoteSyncEnabled: true,
      privacyState: 'private-user-confirmed',
      normalizedRemoteUrl: 'host:example.test/private/session-vault',
    });
    expect(status.manifest?.remote).toMatchObject({
      name: 'origin',
      normalizedUrl: 'host:example.test/private/session-vault',
      privateConfirmed: true,
    });
    const configuredRemote = await execFileAsync('git', ['-C', status.binding!.vaultPath, 'remote', 'get-url', 'origin']);
    expect(configuredRemote.stdout.trim()).toBe('ssh://example.test/private/session-vault.git');
    expect(await readFile(path.join(status.binding!.vaultPath, 'vault.yaml'), 'utf8')).not.toContain('password');
  });

  it('rejects credential-bearing URLs and parent overlap to prevent accidental capture', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'moo-fleet-vault-extra-boundary-'));
    temporaryDirectories.push(root);
    const fleetPath = await createFleetRepository(root);
    const options = serviceOptions(root, fleetPath);

    await expectSafetyFailure(
      initializeSessionVault(
        {
          vaultPath: path.join(root, 'credential-vault'),
          remoteUrl: 'https://user:password@example.test/private.git',
          enableRemoteSync: false,
        },
        options,
      ),
      'remote-contains-credentials',
      '不能内嵌',
    );
    await expectSafetyFailure(
      initializeSessionVault({ vaultPath: root, enableRemoteSync: false }, options),
      'path-overlaps-fleet',
      '包含 Moo Fleet',
    );

    const isolatedVaultPath = path.join(root, 'isolated-vault');
    await expectSafetyFailure(
      initializeSessionVault(
        { vaultPath: isolatedVaultPath },
        { ...options, bindingPath: path.join(fleetPath, 'config', 'session-vault.yaml') },
      ),
      'binding-path-unsafe',
      '不能写入 Moo Fleet 开源仓库',
    );
    await expectSafetyFailure(
      initializeSessionVault(
        { vaultPath: isolatedVaultPath },
        { ...options, bindingPath: path.join(isolatedVaultPath, 'config', 'binding.yaml') },
      ),
      'binding-path-unsafe',
      '不能放进 Vault',
    );
  });
});
