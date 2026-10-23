import { describe, expect, it } from 'vitest';
import {
  aggregateCommitVolumes,
  emptyCodeVolume,
  isGeneratedFile,
  parseCodeVolumeLog,
  parseNumstatCommits,
  reconcileCommitVolumes,
  type CommitCodeVolume,
} from './code-volume.js';
import { authorSampleKey } from './author-identity.js';

/**
 * 拼一段 git log --numstat 的输出：头行以 \u0001 开头（`sha|email|name`），
 * 之后是 numstat 行。sha 默认按序号生成，需要断言的用例自己传。
 */
function logOf(
  commits: { sha?: string; email: string; name: string; files: [string, string, string][] }[],
): string {
  return commits
    .map((commit, index) => {
      const header = `\u0001${commit.sha ?? `sha${index}`}|${commit.email}|${commit.name}`;
      const rows = commit.files.map(([additions, deletions, filePath]) => `${additions}\t${deletions}\t${filePath}`);
      return [header, '', ...rows].join('\n');
    })
    .join('\n');
}

describe('isGeneratedFile', () => {
  it.each([
    'package-lock.json',
    'web/package-lock.json',
    'admin/pnpm-lock.yaml',
    'engine/composer.lock',
    'public/app.min.js',
    'src/app.min.css',
    'dist/index.js',
    'release/mac/MooFleet',
    'node_modules/vue/index.js',
    'engine/public/vendor/scaffold/css/index.css',
    'backup/RestoreDB/wisdomcity/notifications/data/notifications_0_part0.sql',
    'engine/database/schema/mariadb-schema.sql',
    'static/img/logo.png',
    'src/fonts/icon.woff2',
    'assets/app-3f2a9b1c.js',
    'packages/moo-scaffold/public/css/index.css',
    'static/js/app.js',
  ])('生成文件：%s', (filePath) => {
    expect(isGeneratedFile(filePath)).toBe(true);
  });

  it.each([
    'src/server/analytics/code-volume.ts',
    'app/Filament/App/Resources/Todos/Tables/TodosTable.php',
    'packages/moo-scaffold/src/Http/Views/db/designer/show.blade.php',
    'public/site/index.html',
    'public/archify/monitoring-dataflow.html',
    'README.md',
    'docs/HANDOFF.md',
    // 手写脚本不能因为叫 js 就被剔掉
    'src/client/main.js',
    'scripts/release.sh',
  ])('人工文件：%s', (filePath) => {
    expect(isGeneratedFile(filePath)).toBe(false);
  });
});

describe('parseCodeVolumeLog', () => {
  it('按作者累加增删行与文件次', () => {
    const parsed = parseCodeVolumeLog(
      logOf([
        {
          email: 'a@x.com',
          name: 'Alice',
          files: [
            ['10', '2', 'src/a.ts'],
            ['3', '0', 'src/b.ts'],
          ],
        },
        { email: 'b@x.com', name: 'Bob', files: [['5', '5', 'src/c.ts']] },
      ]),
    );

    expect(parsed.totals).toEqual({ additions: 18, deletions: 7, files: 3, excludedFiles: 0, binaryFiles: 0 });
    expect(parsed.byAuthor.get(authorSampleKey('Alice', 'a@x.com'))).toMatchObject({
      additions: 13,
      deletions: 2,
      files: 2,
    });
    expect(parsed.byAuthor.size).toBe(2);
  });

  it('剔除生成文件与二进制，并分别计数', () => {
    const parsed = parseCodeVolumeLog(
      logOf([
        {
          email: 'a@x.com',
          name: 'Alice',
          files: [
            ['12000', '0', 'package-lock.json'],
            ['40', '5', 'src/a.ts'],
            ['-', '-', 'static/img/logo.png'],
          ],
        },
      ]),
    );

    // 锁文件那 12000 行不能进总量，但要能说出「剔了几个」
    expect(parsed.totals).toMatchObject({ additions: 40, deletions: 5, files: 1, excludedFiles: 1, binaryFiles: 1 });
  });

  it('二进制不计入剔除：它本来就没有行数', () => {
    const parsed = parseCodeVolumeLog(logOf([{ email: 'a@x.com', name: 'Alice', files: [['-', '-', 'a.png']] }]));

    expect(parsed.totals).toMatchObject({ binaryFiles: 1, excludedFiles: 0, files: 0 });
  });

  it('文件名里的制表符不影响解析（只按前两个 tab 切）', () => {
    const parsed = parseCodeVolumeLog(logOf([{ email: 'a@x.com', name: 'Alice', files: [['7', '1', 'src/a\tb.ts']] }]));

    expect(parsed.totals).toMatchObject({ additions: 7, deletions: 1, files: 1 });
  });

  it('重命名（0 增 0 删）算一次文件改动', () => {
    const parsed = parseCodeVolumeLog(
      logOf([{ email: 'a@x.com', name: 'Alice', files: [['0', '0', 'one.txt => renamed.txt']] }]),
    );

    expect(parsed.totals).toMatchObject({ additions: 0, deletions: 0, files: 1 });
  });

  it('同一作者的多次提交累加到一起', () => {
    const parsed = parseCodeVolumeLog(
      logOf([
        { email: 'a@x.com', name: 'Alice', files: [['10', '0', 'a.ts']] },
        { email: 'a@x.com', name: 'Alice', files: [['5', '1', 'b.ts']] },
      ]),
    );

    expect(parsed.byAuthor.size).toBe(1);
    expect(parsed.totals).toMatchObject({ additions: 15, deletions: 1, files: 2 });
  });

  it('没有作者信息的空提交不影响结果', () => {
    const parsed = parseCodeVolumeLog('\u0001abc1234|a@x.com|Alice\n');

    expect(parsed.totals).toEqual({ additions: 0, deletions: 0, files: 0, excludedFiles: 0, binaryFiles: 0 });
  });

  it('空输出返回全零', () => {
    expect(parseCodeVolumeLog('')).toEqual(emptyCodeVolume());
  });
});

describe('parseNumstatCommits', () => {
  it('一个提交一条记录，按 sha 归位', () => {
    const commits = parseNumstatCommits(
      logOf([
        { sha: 'aaa111', email: 'a@x.com', name: 'Alice', files: [['10', '2', 'src/a.ts']] },
        { sha: 'bbb222', email: 'a@x.com', name: 'Alice', files: [['3', '0', 'src/b.ts']] },
      ]),
    );

    // 增量缓存靠 sha 认提交，这里必须真的带上 sha，不能退化成「按作者折起来」
    expect(commits.map((commit) => commit.sha)).toEqual(['aaa111', 'bbb222']);
    expect(commits[0].totals).toMatchObject({ additions: 10, deletions: 2, files: 1 });
    expect(commits[1].totals).toMatchObject({ additions: 3, deletions: 0, files: 1 });
  });

  it('同一个提交内部已经把生成文件剔掉，聚合时不会再算一次', () => {
    const [commit] = parseNumstatCommits(
      logOf([{ sha: 'ccc333', email: 'a@x.com', name: 'Alice', files: [['9000', '0', 'yarn.lock'], ['4', '0', 'a.ts']] }]),
    );

    expect(commit.totals).toEqual({ additions: 4, deletions: 0, files: 1, excludedFiles: 1, binaryFiles: 0 });
  });

  it('作者名里带竖线也能解析（只按前两个竖线切）', () => {
    const [commit] = parseNumstatCommits('\u0001ddd444|a@x.com|Wei|Zhang\n\n1\t0\ta.ts\n');

    expect(commit).toMatchObject({ sha: 'ddd444', email: 'a@x.com', name: 'Wei|Zhang' });
    expect(commit.totals.additions).toBe(1);
  });
});

describe('reconcileCommitVolumes', () => {
  function entry(sha: string, additions: number): CommitCodeVolume {
    return {
      sha,
      name: 'Alice',
      email: 'a@x.com',
      totals: { additions, deletions: 0, files: 1, excludedFiles: 0, binaryFiles: 0 },
    };
  }

  function baseline(entries: CommitCodeVolume[]): Map<string, CommitCodeVolume> {
    return new Map(entries.map((commit) => [commit.sha, commit]));
  }

  it('窗口里已经没有的提交要撤账', () => {
    const merged = reconcileCommitVolumes(baseline([entry('a', 10), entry('b', 20)]), ['a'], []);

    // `reset --hard` 之后 b 不在任何引用上，它的 20 行不能继续算
    expect([...(merged ?? [])].map(([sha]) => sha)).toEqual(['a']);
  });

  it('新提交按 sha 补进来，老的账保持原值', () => {
    const merged = reconcileCommitVolumes(baseline([entry('a', 10)]), ['a', 'b'], [entry('b', 7)]);

    expect(merged?.get('a')?.totals.additions).toBe(10);
    expect(merged?.get('b')?.totals.additions).toBe(7);
  });

  it('什么都不用补时原样返回，不产生多余的新旧差异', () => {
    const merged = reconcileCommitVolumes(baseline([entry('a', 10)]), ['a'], []);

    expect(merged?.size).toBe(1);
    expect(merged?.get('a')?.totals.additions).toBe(10);
  });

  it('补算少一条就返回 null，逼调用方退回全量扫描', () => {
    // 该补 b、c 两个，只补回 b：这种缺口留在缓存里会永远偏低且看不出来
    expect(reconcileCommitVolumes(baseline([entry('a', 10)]), ['a', 'b', 'c'], [entry('b', 7)])).toBeNull();
  });

  it('补算多出来的条目也不会被悄悄忽略（条数对不上就是 null）', () => {
    expect(reconcileCommitVolumes(baseline([entry('a', 10)]), ['a'], [entry('b', 7)])).toBeNull();
  });

  it('空基线可以整份建立', () => {
    const merged = reconcileCommitVolumes(new Map(), ['a', 'b'], [entry('a', 1), entry('b', 2)]);

    expect(merged?.size).toBe(2);
  });
});

describe('aggregateCommitVolumes', () => {
  it('按 sha 去重：同一个提交重复出现只算一次', () => {
    const commits = parseNumstatCommits(
      logOf([
        { sha: 'same', email: 'a@x.com', name: 'Alice', files: [['10', '0', 'a.ts']] },
        { sha: 'same', email: 'a@x.com', name: 'Alice', files: [['10', '0', 'a.ts']] },
      ]),
    );

    // 解析层如实返回两条，去重是调用方（Map<sha, …>）的职责；
    // 这里断言的是「聚合不会自己按 sha 去重」，避免出现两条路径两套语义
    expect(commits).toHaveLength(2);
    expect(aggregateCommitVolumes(commits).totals.additions).toBe(20);
  });

  it('空输入返回全零', () => {
    expect(aggregateCommitVolumes([])).toEqual(emptyCodeVolume());
  });

  it('多作者合计等于各作者之和', () => {
    const commits = parseNumstatCommits(
      logOf([
        { sha: 's1', email: 'a@x.com', name: 'Alice', files: [['7', '1', 'a.ts']] },
        { sha: 's2', email: 'b@x.com', name: 'Bob', files: [['2', '5', 'b.ts']] },
      ]),
    );

    const aggregated = aggregateCommitVolumes(commits);
    expect(aggregated.totals).toMatchObject({ additions: 9, deletions: 6, files: 2 });
    expect(aggregated.byAuthor.size).toBe(2);
    expect(aggregated.byAuthor.get(authorSampleKey('Bob', 'b@x.com'))).toMatchObject({ additions: 2, deletions: 5 });
  });
});
