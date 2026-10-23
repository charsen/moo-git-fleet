import { describe, expect, it } from 'vitest';
import { accumulateAuthorSample, authorSampleKey, resolveAuthors, type AuthorSample } from './author-identity.js';

function sample(name: string, email: string, commits: number, additions = 0, deletions = 0): AuthorSample {
  return { name, email, commits, additions, deletions };
}

describe('resolveAuthors', () => {
  it('同名不同邮箱归成一个人（charsen 的 qq 与 gmail）', () => {
    const identities = resolveAuthors([
      sample('charsen', '780537@qq.com', 2639),
      sample('charsen', '780537@gmail.com', 285),
    ]);

    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ name: 'charsen', commits: 2924 });
  });

  it('同邮箱不同名字归成一个人（lee 与 李志伟）', () => {
    const identities = resolveAuthors([
      sample('lee', '907574271@qq.com', 186),
      sample('李志伟', '907574271@qq.com', 126),
    ]);

    expect(identities).toHaveLength(1);
    // 展示名取提交数多的写法，另一种进 aliases
    expect(identities[0]).toMatchObject({ name: 'lee', aliases: ['李志伟'], commits: 312 });
  });

  it('名字是另一个的前缀时归成一个人（charsen 与 charsen fung）', () => {
    const identities = resolveAuthors([
      sample('charsen', '780537@qq.com', 2639),
      sample('charsen fung', 'charsen@charsendemacbook-pro.local', 66),
      sample('charsen fung', 'charsen@charsendemac-mini.local', 4),
    ]);

    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ name: 'charsen', aliases: ['charsen fung'], commits: 2709 });
  });

  it('三个字母以下的短名不按前缀合并：可能是两个人', () => {
    const identities = resolveAuthors([
      sample('lee', 'lee@a.com', 10),
      sample('lee wang', 'wang@b.com', 5),
    ]);

    expect(identities).toHaveLength(2);
  });

  it('分隔符不当人：charsen.fung 与 charsen fung 是同一串 token', () => {
    const identities = resolveAuthors([
      sample('charsen', 'a@a.com', 10),
      sample('charsen_fung', 'b@b.com', 3),
    ]);

    expect(identities).toHaveLength(1);
    expect(identities[0].commits).toBe(13);
  });

  it('前缀只认 token 边界，不做字符串前缀', () => {
    const identities = resolveAuthors([
      sample('author 5', 'a5@x.com', 4),
      sample('author 55', 'a55@x.com', 6),
    ]);

    expect(identities).toHaveLength(2);
  });

  it('仅大小写不同的写法不重复计入 aliases', () => {
    const identities = resolveAuthors([
      sample('Charsen', 'charsen@x.com', 2),
      sample('charsen', 'charsen@x.com', 1),
    ]);

    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ name: 'Charsen', aliases: [], commits: 3 });
  });

  it('增删行跟着身份一起合并', () => {
    const identities = resolveAuthors([
      sample('charsen', 'a@a.com', 10, 1200, 300),
      sample('charsen fung', 'b@b.com', 2, 80, 20),
    ]);

    expect(identities[0]).toMatchObject({ additions: 1280, deletions: 320 });
  });

  it('按提交数降序，同数按名字排', () => {
    const identities = resolveAuthors([
      sample('b', 'b@x.com', 5),
      sample('a', 'a@x.com', 5),
      sample('c', 'c@x.com', 9),
    ]);

    expect(identities.map((identity) => identity.name)).toEqual(['c', 'a', 'b']);
  });

  it('空输入返回空数组', () => {
    expect(resolveAuthors([])).toEqual([]);
  });
});

describe('accumulateAuthorSample', () => {
  it('同一写法跨仓库累加，不同写法分开', () => {
    const map = new Map<string, AuthorSample>();
    accumulateAuthorSample(map, sample('charsen', 'A@x.com', 2, 10, 1));
    accumulateAuthorSample(map, sample('charsen', 'a@x.com', 3, 5, 2));
    accumulateAuthorSample(map, sample('charsen', 'b@x.com', 1, 1, 1));

    expect(map.size).toBe(2);
    expect(map.get(authorSampleKey('charsen', 'a@x.com'))).toMatchObject({ commits: 5, additions: 15, deletions: 3 });
  });
});
