import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAllowedUpdateUrl, sanitizeUpdateFileName, startUpdateDownload, updateDownloadStatus } from './update-download.js';

const temporary: string[] = [];
afterEach(async () => {
  while (temporary.length) {
    const dir = temporary.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('isAllowedUpdateUrl', () => {
  it('只放行 https 的 cloud / GitHub 资产域', () => {
    expect(isAllowedUpdateUrl('https://c.mooeen.com/files/moo-git-fleet-0.2.11-macos-arm64.dmg')).toBe(true);
    expect(isAllowedUpdateUrl('https://github.com/o/r/releases/download/v0.2.11/x.dmg')).toBe(true);
    expect(isAllowedUpdateUrl('https://objects.githubusercontent.com/abc')).toBe(true);
    expect(isAllowedUpdateUrl('https://release-assets.githubusercontent.com/abc')).toBe(true);
  });

  it('拒绝 http、陌生主机、非法 URL', () => {
    expect(isAllowedUpdateUrl('http://c.mooeen.com/x.dmg')).toBe(false);
    expect(isAllowedUpdateUrl('https://evil.example.com/x.dmg')).toBe(false);
    expect(isAllowedUpdateUrl('https://127.0.0.1/x.dmg')).toBe(false);
    expect(isAllowedUpdateUrl('not a url')).toBe(false);
  });

  it('配置了自建更新服务时放行该主机', () => {
    const prev = process.env.GIT_FLEET_UPDATE_BASE_URL;
    process.env.GIT_FLEET_UPDATE_BASE_URL = 'http://127.0.0.1:9999';
    try {
      expect(isAllowedUpdateUrl('http://127.0.0.1:9999/pkg.dmg')).toBe(true);
      expect(isAllowedUpdateUrl('https://evil.example.com/x.dmg')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GIT_FLEET_UPDATE_BASE_URL;
      else process.env.GIT_FLEET_UPDATE_BASE_URL = prev;
    }
  });
});

describe('sanitizeUpdateFileName', () => {
  it('取最后一段并去掉非法字符，杜绝目录穿越', () => {
    expect(sanitizeUpdateFileName('/files/Moo-Fleet-0.2.11-macos-arm64.dmg')).toBe('Moo-Fleet-0.2.11-macos-arm64.dmg');
    expect(sanitizeUpdateFileName('/x/..%2F..%2Fevil.dmg')).not.toContain('/');
    expect(sanitizeUpdateFileName('/x/')).toBe('moo-fleet-update');
    // 查询串不进文件名（URL.pathname 本来就不含查询串；这里验证纯路径段）。
    expect(sanitizeUpdateFileName('/a/b/Moo-Fleet.exe')).toBe('Moo-Fleet.exe');
  });
});

describe('startUpdateDownload', () => {
  it('从配置的更新服务流式下载，报告进度并落盘', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mf-update-'));
    temporary.push(dir);
    const payload = Buffer.alloc(220 * 1024, 7);
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-length': String(payload.length), 'content-type': 'application/octet-stream' });
      response.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    const prevBase = process.env.GIT_FLEET_UPDATE_BASE_URL;
    const prevHome = process.env.GIT_FLEET_DATA_HOME;
    process.env.GIT_FLEET_UPDATE_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.GIT_FLEET_DATA_HOME = dir;
    try {
      const started = await startUpdateDownload(`http://127.0.0.1:${port}/Moo-Fleet-0.2.11-macos-arm64.dmg`);
      expect(started.status).toBe('downloading');

      let current = started;
      for (let i = 0; i < 300 && current.status === 'downloading'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        current = updateDownloadStatus();
      }
      expect(current.status).toBe('done');
      expect(current.fileName).toBe('Moo-Fleet-0.2.11-macos-arm64.dmg');
      expect(current.receivedBytes).toBe(payload.length);
      expect(current.totalBytes).toBe(payload.length);
      expect(current.filePath?.startsWith(path.join(dir, 'updates'))).toBe(true);
      const saved = await readFile(current.filePath!);
      expect(saved.equals(payload)).toBe(true);
    } finally {
      server.close();
      if (prevBase === undefined) delete process.env.GIT_FLEET_UPDATE_BASE_URL;
      else process.env.GIT_FLEET_UPDATE_BASE_URL = prevBase;
      if (prevHome === undefined) delete process.env.GIT_FLEET_DATA_HOME;
      else process.env.GIT_FLEET_DATA_HOME = prevHome;
    }
  });

  it('拒绝非白名单地址（不会发起下载）', async () => {
    await expect(startUpdateDownload('https://evil.example.com/x.dmg')).rejects.toThrow('不被允许');
  });
});
