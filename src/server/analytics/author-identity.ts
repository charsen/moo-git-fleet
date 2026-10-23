/**
 * 把同一个人在不同仓库 / 不同机器上留下的多种写法归并成一个身份。
 *
 * 原来的做法只是 `author.toLowerCase()` 当 key，实测在这台机器的 53 个仓库上
 * 会漏掉两类：
 * - 同一名字、两个邮箱：`charsen` 用过 `780537@qq.com` 和 `780537@gmail.com`；
 * - 同一人、多个名字：`charsen` 与 `charsen fung`（后者是两台机器的本地邮箱），
 *   以及 `lee` 与 `李志伟`（共用 `907574271@qq.com`）。
 * 排行榜上并排出现两行同一个人，等于把第一名拆成了两个。
 *
 * 所以按三条关系做并查集，任一条成立就合并：
 * 1. **邮箱相同**——最硬的证据，`lee` / `李志伟` 这种跨语言改名只能靠它；
 * 2. **名字（小写、分隔符归一后）token 完全相同**——`Charsen` / `charsen`；
 * 3. **一个名字的 token 是另一个的前缀**，且短的那个至少 4 个字符——
 *    `charsen` / `charsen fung`。字符门槛是为了避开 `li`、`wu`、`joe` 这类
 *    三字母以下的名字：它们太容易正好是别人的前缀，错合并比不合并更难发现。
 *
 * 展示名取提交数最多的那种写法，其余进 `aliases`，界面放在 title 里，
 * 让「为什么这两个名字合成一个人」有据可查。
 */

export interface AuthorSample {
  name: string;
  email: string;
  /** 该写法在全部仓库里的提交数 */
  commits: number;
  /** 以下两项只统计近 52 周、已剔除生成文件的改动 */
  additions: number;
  deletions: number;
}

export interface AuthorIdentity {
  /** 展示名：提交数最多的那种写法 */
  name: string;
  /** 被合并进来的其它写法（已排除仅大小写不同的重复项） */
  aliases: string[];
  commits: number;
  additions: number;
  deletions: number;
}

/**
 * 一个「名字 + 邮箱」组合的稳定 key，用来跨仓库累加同一写法。
 *
 * 名字**保留原样**：`Charsen` 和 `charsen` 是两种写法，要看各自出现多少次才能选出
 * 展示名。邮箱则不区分大小写——邮箱的大小写从来不代表不同的人。
 */
export function authorSampleKey(name: string, email: string): string {
  return `${name.trim()}\u0000${email.trim().toLowerCase()}`;
}

/** 把两条样本累加进 `Map`，键是 `authorSampleKey`。 */
export function accumulateAuthorSample(map: Map<string, AuthorSample>, sample: AuthorSample): AuthorSample {
  const key = authorSampleKey(sample.name, sample.email);
  const existing = map.get(key);
  if (!existing) {
    const created: AuthorSample = { ...sample };
    map.set(key, created);
    return created;
  }
  existing.commits += sample.commits;
  existing.additions += sample.additions;
  existing.deletions += sample.deletions;
  return existing;
}

/** 前缀合并的最短字符数：低于这个长度只认同名与同邮箱。 */
const minimumPrefixLength = 4;

/** 小写化并把 `-` `_` `.` 视作空格：`wjc-home` 与 `wjc home` 是同一串 token。 */
function nameTokens(name: string): string[] {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function isTokenPrefix(shorter: string[], longer: string[]): boolean {
  if (shorter.length > longer.length) return false;
  return shorter.every((token, index) => longer[index] === token);
}

interface Node {
  name: string;
  email: string;
  commits: number;
  additions: number;
  deletions: number;
}

class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root];
    // 路径压缩：链长在合并后可能到几十，第二次起直接一步到位
    let cursor = index;
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor];
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent[rightRoot] = leftRoot;
  }
}

/**
 * 归并作者样本，按提交数降序返回。
 *
 * 不做截断：前 50 由调用方决定。传入空数组返回空数组。
 */
export function resolveAuthors(samples: AuthorSample[]): AuthorIdentity[] {
  // 节点 = 一种「名字 + 邮箱」写法。同名不同邮箱、同邮箱不同名先各自是一个节点，
  // 由并查集按下面的三条关系连起来。
  const nodes = new Map<string, Node>();
  for (const sample of samples) {
    const key = authorSampleKey(sample.name, sample.email);
    const existing = nodes.get(key);
    if (existing) {
      existing.commits += sample.commits;
      existing.additions += sample.additions;
      existing.deletions += sample.deletions;
      continue;
    }
    nodes.set(key, {
      name: sample.name.trim(),
      email: sample.email.trim().toLowerCase(),
      commits: sample.commits,
      additions: sample.additions,
      deletions: sample.deletions,
    });
  }

  const entries = [...nodes.values()];
  const set = new DisjointSet(entries.length);

  // 名字 token 只算一次：同一个人往往有两条以上的样本，重复归一化纯属浪费
  const tokenLists = entries.map((entry) => nameTokens(entry.name));

  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (entries[left].email && entries[left].email === entries[right].email) {
        set.union(left, right);
        continue;
      }

      const leftTokens = tokenLists[left];
      const rightTokens = tokenLists[right];
      if (leftTokens.length === 0 || rightTokens.length === 0) continue;

      const shorter = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
      const longer = shorter === leftTokens ? rightTokens : leftTokens;
      if (!isTokenPrefix(shorter, longer)) continue;

      // 完全同名不必看长度门槛；只是前缀关系才要求够长
      if (shorter.length === longer.length) set.union(left, right);
      else if (shorter.join(' ').length >= minimumPrefixLength) set.union(left, right);
    }
  }

  const groups = new Map<number, number[]>();
  for (let index = 0; index < entries.length; index += 1) {
    const root = set.find(index);
    const group = groups.get(root);
    if (group) group.push(index);
    else groups.set(root, [index]);
  }

  const identities: AuthorIdentity[] = [];
  for (const members of groups.values()) {
    const spellings = new Map<string, number>();
    let commits = 0;
    let additions = 0;
    let deletions = 0;

    for (const index of members) {
      const entry = entries[index];
      commits += entry.commits;
      additions += entry.additions;
      deletions += entry.deletions;
      spellings.set(entry.name, (spellings.get(entry.name) ?? 0) + entry.commits);
    }

    const ranked = [...spellings.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    );
    const name = ranked[0][0];
    const aliases = ranked
      .slice(1)
      .map(([spelling]) => spelling)
      .filter((spelling) => spelling.toLowerCase() !== name.toLowerCase());

    identities.push({ name, aliases, commits, additions, deletions });
  }

  return identities.sort((left, right) => right.commits - left.commits || left.name.localeCompare(right.name));
}
