#!/usr/bin/env node
/**
 * 性能夹具：造 N 个有真实工作树规模的仓库并注册到隔离实例。
 *
 * 为什么不用 doc-screenshots 那套 6 仓夹具：性能问题几乎都在规模上暴露
 * （15 秒轮询扫全量仓库、每仓 4 个 git 子进程、列表渲染行数）。6 个仓库
 * 的读数看不出差异，也不该为了性能测试去改那套写死了 6 行的断言。
 *
 * 每个仓库：1 个 bare origin + 2 个提交 + 150～400 个文件 + 若干脏改动，
 * 名字全部是虚构的 perf-repository-NN。
 *
 * 用法：GIT_FLEET_PORT=8899 node scripts/perf/fixture.mjs --root /tmp/moo-perf --count 40
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const root = argOf('--root', '/tmp/moo-fleet-perf');
const count = Number.parseInt(argOf('--count', '40'), 10);
const port = process.env.GIT_FLEET_PORT ?? '8899';
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

const git = (cwd, args) => exec('git', ['-C', cwd, ...args], { env, maxBuffer: 8 << 20 });

async function concurrent(items, limit, task) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await task(items[index], index);
    }
  }));
}

const groups = ['Perf 核心', 'Perf 服务', 'Perf 工具', 'Perf 数据'];

async function makeRepository(index) {
  const name = `perf-repository-${String(index + 1).padStart(2, '0')}`;
  const work = path.join(root, 'projects', name);
  const origin = path.join(root, 'origins', `${name}.git`);
  await fs.mkdir(path.join(work, 'src'), { recursive: true });
  await fs.mkdir(origin, { recursive: true });

  const fileCount = 150 + ((index * 37) % 250);
  const files = [];
  for (let i = 0; i < fileCount; i += 1) {
    const dir = path.join(work, 'src', `mod-${String(i % 12).padStart(2, '0')}`);
    const file = path.join(dir, `file-${String(i).padStart(3, '0')}.ts`);
    files.push(fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(file, `export const value${i} = ${i};\n`.repeat(12))));
  }
  await Promise.all(files);
  await fs.writeFile(path.join(work, 'README.md'), `# ${name}\n\n性能夹具仓库。\n`);
  await fs.writeFile(path.join(work, 'package.json'), JSON.stringify({ name, private: true, version: '1.0.0' }, null, 2));

  await git(work, ['init', '-q', '-b', 'main']);
  await git(work, ['config', 'user.name', 'Perf Fixture']);
  await git(work, ['config', 'user.email', 'perf@example.invalid']);
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-q', '-m', `feat: seed ${name}`]);
  await fs.appendFile(path.join(work, 'README.md'), '\n## 第二轮\n');
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-q', '-m', 'docs: 补充说明']);

  await git(origin, ['init', '-q', '--bare', '-b', 'main']);
  await git(work, ['remote', 'add', 'origin', origin]);
  await git(work, ['push', '-q', 'origin', 'main']);
  await git(work, ['fetch', '-q', 'origin']);
  await git(work, ['branch', '-q', '--set-upstream-to=origin/main', 'main']);

  // 三分之一脏工作区、六分之一有未跟踪文件，列表才有真实的分支与改动计数。
  if (index % 3 === 0) {
    await fs.appendFile(path.join(work, 'README.md'), '\n<!-- dirty -->\n');
  }
  if (index % 6 === 1) {
    await fs.writeFile(path.join(work, 'src', 'untracked-note.ts'), 'export const note = 1;\n');
  }
  if (index % 5 === 2) {
    await fs.writeFile(path.join(work, 'src', 'staged-change.ts'), 'export const staged = 1;\n');
    await git(work, ['add', 'src/staged-change.ts']);
  }
  return { name, work, group: groups[index % groups.length] };
}

async function api(method, route, payload) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-git-fleet-token': token },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${await response.text()}`);
  return response.json();
}

await fs.mkdir(path.join(root, 'projects'), { recursive: true });
await fs.mkdir(path.join(root, 'origins'), { recursive: true });

const started = Date.now();
const repositories = [];
await concurrent(Array.from({ length: count }, (_, index) => index), 6, async (index) => {
  repositories[index] = await makeRepository(index);
});
console.log(`夹具：${count} 个仓库，${((Date.now() - started) / 1000).toFixed(1)}s`);

const session = await (await fetch(`${base}/api/session`)).json();
const token = session.token;
const { rootId } = await api('POST', '/api/repository-roots', { path: path.join(root, 'projects') });
await concurrent(repositories, 4, async (repository) => {
  await api('POST', '/api/repositories', {
    rootId,
    relativePath: repository.name,
    group: repository.group,
    tags: [],
  });
});
console.log(`已注册 ${repositories.length} 个仓库（root ${rootId}）`);
